import { mkdtempSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceError, listDevices, readPhone, watchDevices, writeLayout } from '@valet/iphone'
import type { ToolCall } from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakePhone, sampleState, startFakePhone } from '../../../packages/iphone/test/fake-phone'
import { focusChecklist, IPhoneService, iphoneTools, problemText } from '../src/main/core/iphone'

function call(tool: string, input: unknown): ToolCall {
  return { callId: `c_${Math.random()}`, tool, input, client: 'Test agent' } as unknown as ToolCall
}

async function out(service: IPhoneService, tool: string, input: unknown = {}) {
  const result = await service.call(call(tool, input), new AbortController().signal)
  if (result.status !== 'ok') throw new Error(`${tool} ${result.status}`)
  return result.output as Record<string, unknown>
}

describe('IPhoneService', () => {
  let phone: FakePhone | null = null
  let service: IPhoneService | null = null
  afterEach(async () => {
    service?.stop()
    await phone?.close()
  })

  async function setup(approve = true) {
    phone = await startFakePhone(sampleState())
    const deps = { socketPath: phone.socketPath }
    const notes: string[] = []
    const approvals: string[][] = []
    service = new IPhoneService({
      dir: mkdtempSync(join(tmpdir(), 'iphone-')),
      now: Date.now,
      audit: async () => undefined,
      notify: (t) => notes.push(t),
      approveWrite: async (preview) => {
        approvals.push([...preview])
        return approve
      },
      phone: {
        list: () => listDevices(deps),
        read: (d, have) => readPhone(d, { ...deps, haveIcon: have }),
        write: (d, s) => writeLayout(d, s, { ...deps, settleMs: 10 }),
        watch: (on) => watchDevices(on, deps),
      },
    })
    await service.start()
    return { notes, approvals, service }
  }

  it('saves the layout when the phone is plugged in, and lets an agent plan and apply', async () => {
    const { notes, approvals, service } = await setup()
    await new Promise((r) => setTimeout(r, 100))
    phone?.attach()
    for (let i = 0; i < 50 && notes.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(notes[0]).toContain('saved Test iPhone’s home screen')

    const layout = await out(service, 'layout', { cells: true })
    expect(layout['problem']).toBeNull()
    const proposal = layout['proposal'] as { revision: number; pages: { cells: unknown[] }[] }
    expect(proposal.pages[0]?.cells).toHaveLength(3)

    const edited = await out(service, 'edit', {
      revision: proposal.revision,
      changes: [{ op: 'move', item: 'com.apple.Maps', to: { where: 'page', page: 1, position: 1 } }],
      pageNames: { '1': 'Every day' },
    })
    expect(edited['problem']).toBeNull()
    expect(edited['changes']).toContain('Maps: page 2 position 1 → page 1 position 1.')

    const stale = await out(service, 'edit', {
      revision: proposal.revision,
      changes: [{ op: 'addPage' }],
    })
    expect(String(stale['problem'])).toMatch(/revision/)

    const icons = await out(service, 'icons', { ids: ['com.apple.Maps'] })
    expect((icons['icons'] as Record<string, string>)['com.apple.Maps']).toMatch(/^data:image\/png;base64,/)

    const focus = await out(service, 'plan_focus', { focus: [{ name: 'Work', pages: [1], notes: '' }] })
    expect((focus['checklist'] as string[])[0]).toContain('Work')

    const applied = await out(service, 'apply', { revision: focus['revision'] as number })
    expect(applied).toMatchObject({ problem: null })
    expect(applied['written']).toBe(true)
    expect(approvals[0]?.[0]).toContain('Test iPhone')
    expect(phone?.written).toHaveLength(1)
    const dir = (service as unknown as { deps: { dir: string } }).deps.dir
    const plists = (await readdir(join(dir, 'snapshots'))).filter((f) => f.endsWith('.plist'))
    expect(plists.length).toBeGreaterThanOrEqual(3)
  })

  it('writes nothing when the person says no, or the phone changed', async () => {
    const { service } = await setup(false)
    await out(service, 'snapshot')
    const edited = await out(service, 'edit', {
      changes: [{ op: 'move', item: 'com.apple.Maps', to: { where: 'dock' } }],
    })
    const no = await out(service, 'apply', { revision: edited['revision'] as number })
    expect(String(no['problem'])).toMatch(/didn’t approve/)
    if (phone !== null) phone.iconState = [[], ...(sampleState().slice(1) as never[])]
    const drift = await out(service, 'apply', { revision: edited['revision'] as number })
    expect(String(drift['problem'])).toMatch(/changed since/)
    expect(phone?.written).toHaveLength(0)
  })

  it('names pages, undoes, resets and says what it can’t do', async () => {
    const { service } = await setup()
    expect((await out(service, 'layout'))['problem']).toMatch(/hasn’t saved/)
    expect((await out(service, 'edit', { changes: [{ op: 'addPage' }] }))['problem']).toMatch(/hasn’t saved/)
    expect((await out(service, 'reset'))['problem']).toMatch(/hasn’t saved/)
    expect((await out(service, 'apply', { revision: 1 }))['problem']).toMatch(/no proposal/)
    expect((await out(service, 'undo'))['problem']).toMatch(/nothing to undo/)
    const status = await out(service, 'status')
    expect(status).toMatchObject({ pluggedIn: true, lastSaved: null, proposal: null })

    await out(service, 'snapshot')
    const named = await out(service, 'name_pages', { pageNames: { '1': 'Every day', '2': '' }, notes: 'Why' })
    expect(named['revision']).toBe(2)
    const moved = await out(service, 'edit', {
      changes: [{ op: 'move', item: 'com.apple.Maps', to: { where: 'dock' } }],
      notes: 'Maps to the dock',
    })
    expect((await out(service, 'apply', { revision: 1 }))['problem']).toMatch(/revision/)
    const undone = await out(service, 'undo')
    expect(undone['changes']).toEqual([])
    expect((await out(service, 'apply', { revision: undone['revision'] as number }))['problem']).toMatch(
      /nothing to write/,
    )
    expect((await out(service, 'plan_focus', { focus: [{ name: 'Work', pages: [7] }] }))['problem']).toMatch(
      /no page 7/,
    )
    const reset = await out(service, 'reset')
    expect(reset['revision']).toBeGreaterThan(moved['revision'] as number)
    const phoneOnly = await out(service, 'layout', { view: 'phone' })
    expect(phoneOnly['proposal']).toBeUndefined()
    const proposalOnly = await out(service, 'layout', { view: 'proposal' })
    expect(proposalOnly['phone']).toBeUndefined()
    expect(await service.wallpaper()).not.toBeNull()

    const bad = await out(service, 'edit', { changes: [] })
    expect(bad['problem']).toMatch(/input/)
    const unknown = await service.call(call('nope', {}), new AbortController().signal)
    expect(unknown.status).toBe('failed')
    const aborted = new AbortController()
    aborted.abort()
    expect((await service.call(call('status', {}), aborted.signal)).status).toBe('failed')
    const full = await out(service, 'edit', {
      changes: [
        { op: 'move', item: 'com.apple.Maps', to: { where: 'dock' } },
        { op: 'move', item: 'com.apple.camera', to: { where: 'dock' } },
        { op: 'move', item: 'com.apple.mobilemail', to: { where: 'dock' } },
      ],
    })
    expect((await out(service, 'apply', { revision: full['revision'] as number }))['problem']).toMatch(
      /doesn’t fit/,
    )
  })

  it('keeps trying while the phone is locked, and stops when it is unplugged', async () => {
    phone = await startFakePhone(sampleState())
    phone.locked = true
    const deps = { socketPath: phone.socketPath }
    const notes: string[] = []
    const pending: (() => void)[] = []
    service = new IPhoneService({
      dir: mkdtempSync(join(tmpdir(), 'iphone-')),
      now: Date.now,
      audit: async () => undefined,
      notify: (t) => notes.push(t),
      approveWrite: async () => false,
      phone: {
        list: () => listDevices(deps),
        read: (d, have) => readPhone(d, { ...deps, haveIcon: have }),
        write: (d, s) => writeLayout(d, s, deps),
        watch: (on) => {
          setTimeout(() => {
            on({ kind: 'attached', device: { deviceId: 7, udid: 'x', connection: 'Network' } })
            on({
              kind: 'attached',
              device: { deviceId: 7, udid: '00008110-000A1B2C3D4E5F60', connection: 'USB' },
            })
          }, 0)
          return { stop() {} }
        },
      },
      timers: {
        setTimeout: (run) => {
          pending.push(run)
          return pending.length
        },
        clearTimeout: () => undefined,
      },
    })
    await service.start()
    await new Promise((r) => setTimeout(r, 20))
    pending.shift()?.()
    for (let i = 0; i < 50 && notes.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(notes[0]).toMatch(/unlock the iPhone/)
    phone.locked = false
    pending.shift()?.()
    for (let i = 0; i < 50 && notes.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    expect(notes[1]).toMatch(/saved Test iPhone/)
  })

  it('words problems and Focus steps for people', () => {
    for (const code of ['locked', 'not-paired', 'not-attached', 'no-usbmuxd', 'timeout'] as const)
      expect(problemText(new DeviceError(code, 'x'))).not.toBe('')
    expect(problemText('?')).toBe('something went wrong.')
    expect(problemText(new Error('boom'))).toBe('boom')
    expect(
      focusChecklist({
        focus: [{ name: 'Work', pages: [1, 2], notes: '' }],
        pageNames: { '1': 'Desk' },
      } as never)[0],
    ).toBe('Settings › Focus › Work › Customise Screens › Home Screen: choose pages 1 (Desk), 2.')
    expect(iphoneTools().map((t) => t.declaration.name)).toContain('apply')
  })

  it('finds no phone where this computer has no iPhone service', async () => {
    const own = new IPhoneService({
      dir: mkdtempSync(join(tmpdir(), 'iphone-')),
      now: Date.now,
      audit: async () => undefined,
      notify: () => undefined,
      approveWrite: async () => false,
    })
    service = own
    await own.start()
    expect(await out(own, 'status')).toMatchObject({ pluggedIn: false })
    expect((await out(own, 'snapshot'))['problem']).toMatch(/isn’t plugged in/)
  })
})
