import { afterEach, describe, expect, it } from 'vitest'
import { Lockdown, listDevices, SpringBoard, watchDevices } from '../src/device'
import { applyEdits, describeChanges, EditError, problems, tidy } from '../src/edit'
import { buildIconState, parseIconState, place } from '../src/layout'
import { decode, decodeBinary, decodeXml, encodeXml, PlistReal, type PlistValue } from '../src/plist'
import { readPhone, writeLayout } from '../src/read'
import { type FakePhone, sampleState, startFakePhone } from './fake-phone'

describe('plist', () => {
  it('round-trips XML with types kept', () => {
    const value: PlistValue = {
      a: 'x & <y>',
      n: 3,
      r: new PlistReal(2.5),
      t: true,
      d: new Uint8Array([1, 2, 3]),
      list: [{}, [], ''],
      big: 9_007_199_254_740_993n,
    }
    const back = decodeXml(encodeXml(value)) as Record<string, PlistValue>
    expect(back['a']).toBe('x & <y>')
    expect(back['n']).toBe(3)
    expect(back['r']).toBeInstanceOf(PlistReal)
    expect((back['r'] as PlistReal).value).toBe(2.5)
    expect(Array.from(back['d'] as Uint8Array)).toEqual([1, 2, 3])
    expect(back['list']).toEqual([{}, [], ''])
    expect(back['big']).toBe(9_007_199_254_740_993n)
  })

  it('reads a binary plist', () => {
    // {"a": [1, "hi", 2.5, "é"], "b": true, "d": <01 02>}, made by Python's plistlib.
    const hex =
      '62706c6973743030d301020304090a516151625164a40506070810015268692340040000000000006100e909420102080f1113151a1c1f282b2c0000000000000101000000000000000b0000000000000000000000000000002f'
    const value = decodeBinary(Buffer.from(hex, 'hex')) as Record<string, PlistValue>
    const list = value['a'] as PlistValue[]
    expect(list[0]).toBe(1)
    expect(list[1]).toBe('hi')
    expect((list[2] as PlistReal).value).toBe(2.5)
    expect(list[3]).toBe('é')
    expect(value['b']).toBe(true)
    expect(Array.from(value['d'] as Uint8Array)).toEqual([1, 2])
    expect(decode(Buffer.from(encodeXml({ x: 1 })))).toEqual({ x: 1 })
  })
})

describe('layout', () => {
  it('parses pages, dock, folders and widgets, and builds the same raw back', () => {
    const parsed = parseIconState(sampleState())
    const { layout } = parsed
    expect(layout.dock.map((i) => i.id)).toEqual(['com.apple.mobilephone', 'com.apple.mobilesafari'])
    const [widget, mail, folder] = layout.pages[0]?.items ?? []
    expect(widget).toMatchObject({
      kind: 'widget',
      size: 'medium',
      apps: ['com.apple.weather'],
      kinds: ['Forecast'],
    })
    expect(mail).toMatchObject({ kind: 'app', id: 'com.apple.mobilemail' })
    expect(folder).toMatchObject({ kind: 'folder', name: 'Social' })
    const rebuilt = buildIconState(layout, parsed.raw)
    expect(encodeXml(rebuilt)).toBe(encodeXml(sampleState()))
  })

  it('places widgets and icons as iOS fills the grid', () => {
    const { layout } = parseIconState(sampleState())
    const { placed } = place(layout.pages[0]?.items ?? [])
    expect(placed.map((p) => [p.column, p.row, p.columns, p.rows])).toEqual([
      [0, 0, 4, 2],
      [0, 2, 1, 1],
      [1, 2, 1, 1],
    ])
  })
})

describe('edits', () => {
  const ids = () => {
    let n = 1
    return () => `folder:new-${n++}`
  }

  it('moves, makes folders and sets pages, all or none', () => {
    const { layout } = parseIconState(sampleState())
    const next = applyEdits(
      layout,
      [
        { op: 'move', item: 'com.apple.Maps', to: { where: 'dock', position: 1 } },
        { op: 'createFolder', name: 'Out', items: ['com.apple.camera', 'com.apple.mobilemail'], page: 1 },
        { op: 'renameFolder', folder: 'folder:1', name: 'Chat' },
      ],
      { nextFolderId: ids() },
    )
    expect(next.dock[0]?.id).toBe('com.apple.Maps')
    expect(tidy(next).pages).toHaveLength(1)
    const lines = describeChanges(layout, tidy(next))
    expect(lines).toContain('Folder “Social” renamed “Chat”.')
    expect(lines.some((l) => l.startsWith('Maps: page 2'))).toBe(true)
    expect(() =>
      applyEdits(layout, [{ op: 'move', item: 'nope', to: { where: 'dock' } }], { nextFolderId: ids() }),
    ).toThrow(EditError)
    expect(() =>
      applyEdits(layout, [{ op: 'move', item: 'widget:1', to: { where: 'dock' } }], { nextFolderId: ids() }),
    ).toThrow(/only apps/)
  })

  it('says when a page or the dock is too full', () => {
    const { layout } = parseIconState(sampleState())
    const next = applyEdits(
      layout,
      [
        { op: 'move', item: 'com.apple.Maps', to: { where: 'dock' } },
        { op: 'move', item: 'com.apple.camera', to: { where: 'dock' } },
        { op: 'move', item: 'com.apple.mobilemail', to: { where: 'dock' } },
      ],
      { nextFolderId: ids() },
    )
    expect(problems(tidy(next))[0]?.where).toBe('dock')
  })

  it('writes a folder back with its new contents', () => {
    const parsed = parseIconState(sampleState())
    const next = applyEdits(
      parsed.layout,
      [{ op: 'move', item: 'com.apple.Maps', to: { where: 'folder', folder: 'folder:1' } }],
      { nextFolderId: ids() },
    )
    const raw = buildIconState(tidy(next), parsed.raw) as PlistValue[][]
    const folder = raw[1]?.[2] as Record<string, PlistValue>
    expect((folder['iconLists'] as PlistValue[][])[0]).toHaveLength(3)
    expect(raw).toHaveLength(3)
  })
})

describe('the phone over usbmuxd', () => {
  let phone: FakePhone | null = null
  afterEach(async () => {
    await phone?.close()
    phone = null
  })

  it('lists, reads and writes', async () => {
    phone = await startFakePhone(sampleState())
    const deps = { socketPath: phone.socketPath }
    const [device] = await listDevices(deps)
    expect(device?.udid).toBe('00008110-000A1B2C3D4E5F60')
    if (device === undefined) throw new Error('no device')
    const read = await readPhone(device, deps)
    expect(read.device.name).toBe('Test iPhone')
    expect(read.grid.columns).toBe(4)
    expect(read.icons.get('com.apple.mobilemail')).toBeDefined()
    expect(read.icons.get('com.apple.weather')).toBeDefined()
    expect(encodeXml(read.iconState as PlistValue[])).toBe(encodeXml(sampleState()))
    const after = await writeLayout(device, [[], ...(sampleState().slice(1) as PlistValue[][])], {
      ...deps,
      settleMs: 10,
    })
    expect(phone.written).toHaveLength(1)
    expect((after[0] as PlistValue[]).length).toBe(0)
  })

  it('says when the phone is locked', async () => {
    phone = await startFakePhone(sampleState())
    phone.locked = true
    const [device] = await listDevices({ socketPath: phone.socketPath })
    if (device === undefined) throw new Error('no device')
    await expect(Lockdown.open(device, { socketPath: phone.socketPath })).rejects.toMatchObject({
      code: 'locked',
    })
  })

  it('hears a phone being plugged in', async () => {
    phone = await startFakePhone(sampleState())
    const seen: string[] = []
    const watch = watchDevices((e) => seen.push(e.kind), { socketPath: phone.socketPath })
    await new Promise((r) => setTimeout(r, 100))
    phone.attach()
    await new Promise((r) => setTimeout(r, 100))
    watch.stop()
    expect(seen).toEqual(['attached'])
    void SpringBoard
  })
})

describe('more edits', () => {
  const next = () => {
    let n = 1
    return () => `folder:new-${n++}`
  }
  const base = () => parseIconState(sampleState()).layout

  it('sets pages and the dock, empties folders, and adds and moves pages', () => {
    const layout = applyEdits(
      base(),
      [
        { op: 'setDock', items: ['com.apple.mobilesafari', 'com.apple.mobilephone'] },
        { op: 'emptyFolder', folder: 'folder:1', page: 2, position: 1 },
        { op: 'addPage', page: 1 },
        { op: 'setPage', page: 1, items: ['com.apple.mobilemail'] },
        { op: 'movePage', from: 1, to: 3 },
        { op: 'setPage', page: 4, items: ['com.x.app'] },
        { op: 'move', item: 'com.apple.camera', to: { where: 'page', page: 4, position: 1 } },
      ],
      { nextFolderId: next() },
    )
    expect(layout.dock.map((i) => i.id)).toEqual(['com.apple.mobilesafari', 'com.apple.mobilephone'])
    expect(layout.pages.map((p) => p.items.map((i) => i.id))).toEqual([
      ['widget:1'],
      ['com.apple.MobileSMS', 'com.apple.Maps'],
      ['com.apple.mobilemail'],
      ['com.apple.camera', 'com.x.app'],
    ])
    const lines = describeChanges(base(), tidy(layout))
    expect(lines).toContain('Folder “Social” removed.')
    expect(lines.some((l) => l.startsWith('Pages: 2 → 4'))).toBe(true)
    expect(describeChanges(base(), tidy(layout), 1)).toHaveLength(2)
  })

  it('refuses what can’t be done', () => {
    const cases: Parameters<typeof applyEdits>[1][] = [
      [{ op: 'setPage', page: 1, items: ['com.apple.Maps'] }],
      [{ op: 'setDock', items: ['com.apple.Maps'] }],
      [{ op: 'move', item: 'com.apple.Maps', to: { where: 'page', page: 9 } }],
      [{ op: 'move', item: 'com.apple.Maps', to: { where: 'folder', folder: 'folder:9' } }],
      [{ op: 'move', item: 'folder:1', to: { where: 'folder', folder: 'folder:1' } }],
      [{ op: 'renameFolder', folder: 'nope', name: 'x' }],
      [{ op: 'movePage', from: 9, to: 1 }],
      [{ op: 'createFolder', name: 'W', items: ['widget:1'], page: 1 }],
    ]
    for (const ops of cases)
      expect(() => applyEdits(base(), ops, { nextFolderId: next() })).toThrow(EditError)
  })

  it('splits a big new folder into pages and finds overflowing pages and folders', () => {
    const state = sampleState()
    const many = Array.from({ length: 30 }, (_, k) => ({ bundleIdentifier: `a.b${k}`, displayName: `A${k}` }))
    state.push(many)
    const { layout } = parseIconState(state)
    const ids = many.map((m) => m.bundleIdentifier)
    const made = applyEdits(layout, [{ op: 'createFolder', name: 'Big', items: ids.slice(0, 20), page: 3 }], {
      nextFolderId: next(),
    })
    const folder = made.pages[2]?.items.at(-1)
    expect(folder?.kind === 'folder' && folder.pages.map((p) => p.length)).toEqual([9, 9, 2])
    expect(problems(layout).map((p) => p.where)).toEqual(['page 3'])
    const crowded = {
      dock: [],
      pages: [
        {
          items: [{ kind: 'folder' as const, id: 'f', name: 'F', pages: [layout.pages[2]?.items as never] }],
        },
      ],
    }
    expect(problems(crowded)[0]?.where).toBe('f page 1')
  })
})

describe('parsing odd entries', () => {
  it('reads web clips, unnamed items, stacks and large widgets', () => {
    const { layout } = parseIconState([
      [{ displayIdentifier: 'com.apple.webapp.123', displayName: 'Site', webClipURL: 'https://example.com' }],
      [
        { displayName: 'Mystery' },
        {
          gridSize: 'large',
          elements: [{ containerBundleIdentifier: 'a' }, { containerBundleIdentifier: 'b' }],
        },
        { iconType: 'custom', gridSize: 'extraLarge' },
        'junk',
      ],
    ])
    expect(layout.dock[0]?.kind).toBe('webclip')
    const items = layout.pages[0]?.items ?? []
    expect(items.map((i) => i.kind)).toEqual(['other', 'widget', 'widget'])
    expect(items[1]).toMatchObject({ size: 'large', stack: true, name: 'Widget stack' })
    expect(items[2]).toMatchObject({ size: 'extraLarge' })
    expect(place(items).overflow).toHaveLength(1)
  })

  it('reads XML entities, comments and empty values', () => {
    const xml =
      '<?xml version="1.0"?><!-- c --><plist><dict><key>a</key><string>&#65;&#x42;&quot;&apos;&lt;&gt;</string>' +
      '<key>e</key><data/><key>d</key><date>2026-01-01T00:00:00Z</date><key>f</key><false/></dict></plist>'
    const v = decodeXml(xml) as Record<string, PlistValue>
    expect(v['a']).toBe('AB"\'<>')
    expect(v['d']).toBeInstanceOf(Date)
    expect(v['f']).toBe(false)
    expect(() => decodeXml('<plist><dict><string>x</string></dict></plist>')).toThrow()
    expect(() => decodeXml('<plist><bogus>x</bogus></plist>')).toThrow()
    expect(() => decodeBinary(new Uint8Array(10))).toThrow()
    expect(encodeXml({ when: new Date(0), list: [true], r: 0.5 })).toContain('<real>0.5</real>')
  })
})
