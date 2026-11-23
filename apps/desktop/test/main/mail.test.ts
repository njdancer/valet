// @vitest-environment node
// Mail on this Mac (docs/mail.md): the person's switch and account choices decide what agents see,
// every call is audited, and the built-in tools reach agents through the same caller as adapters.
// The Mail library here is the made-up one native-mail's tests use; nothing touches real Mail.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@valet/mcp-server'
import {
  type DraftRequest,
  type MailFiles,
  MailFilesError,
  type MailOrganizer,
  type MoveRecord,
  type OrganizeRequest,
} from '@valet/native-mail'
import type { ToolCallResult } from '@valet/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectMailFiles } from '../../../../packages/native-mail/src/direct-files'
import { ALLOWED, buildLibrary, OTHER } from '../../../../packages/native-mail/test/fixture-library'
import { type NativeTools, RuntimeToolCaller } from '../../src/main/core/caller'
import { MailService, MailSettingsStore, type ReaderControl } from '../../src/main/core/mail'

let root: string
const servers: Server[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'valet-mail-app-'))
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  rmSync(root, { recursive: true, force: true })
})

/** A socket at the reader's path, so status() sees it running. */
async function listening(path: string): Promise<void> {
  const server = createServer((socket) => socket.end())
  servers.push(server)
  await new Promise<void>((done) => server.listen(path, done))
}

function reader(socketPath: string): ReaderControl & { started: number } {
  const control = {
    socketPath,
    started: 0,
    async start() {
      control.started += 1
      return 'started' as const
    },
    openFullDiskAccess: async () => {},
    openLoginItems: async () => {},
    reveal: async () => {},
  }
  return control
}

interface Setup {
  service: MailService
  reader: ReturnType<typeof reader>
  audited: { call: ToolCall; result: ToolCallResult }[]
  saved: DraftRequest[]
  changes: () => number
}

function setup(
  options: {
    files?: MailFiles | null
    reader?: boolean
    settings?: string
    organizer?: Pick<MailOrganizer, 'apply'>
    moved?: (moves: readonly MoveRecord[]) => Promise<void>
  } = {},
): Setup {
  const settingsPath = join(root, 'mail.json')
  if (options.settings !== undefined) writeFileSync(settingsPath, options.settings)
  const r = reader(join(root, 'r.sock'))
  const audited: Setup['audited'] = []
  const saved: DraftRequest[] = []
  let changes = 0
  const files =
    options.files === undefined
      ? new DirectMailFiles(buildLibrary(mkdtempSync(join(root, 'lib-'))))
      : options.files
  const service = new MailService({
    settings: new MailSettingsStore(settingsPath),
    reader: options.reader === false ? null : r,
    files,
    drafts: {
      save: async (draft) => {
        saved.push(draft)
        return { kind: 'saved' }
      },
    },
    ...(options.organizer === undefined ? {} : { organizer: options.organizer }),
    ...(options.moved === undefined ? {} : { moved: async (moves) => options.moved?.(moves) }),
    audit: async (call, result) => {
      audited.push({ call, result })
    },
    now: () => 1_000,
    changed: () => {
      changes += 1
    },
  })
  return { service, reader: r, audited, saved, changes: () => changes }
}

const call = (tool: string, input: unknown = {}): ToolCall => ({
  adapterId: 'mail',
  tool,
  input,
  client: 'Claude',
  callId: `c-${tool}`,
})
const signal = new AbortController().signal

describe('MailService', () => {
  it('lists nothing until Mail is on with an account picked, and drafts only when allowed', async () => {
    const s = setup()
    await s.service.load()
    expect(s.service.listTools()).toEqual([])
    await s.service.update({ enabled: true })
    expect(s.service.listTools()).toEqual([])
    await s.service.update({ accounts: [ALLOWED] })
    expect(s.service.listTools().map((t) => t.declaration.name)).toEqual([
      'accounts',
      'search',
      'read',
      'thread',
    ])
    await s.service.update({ drafts: true })
    expect(s.service.listTools().map((t) => t.declaration.name)).toContain('create_draft')
    expect(s.service.listTools().every((t) => t.adapterId === 'mail' && t.adapterName === 'Mail')).toBe(true)
    // Each change to what agents see tells the app to re-list; the reader starts when Mail turns on.
    expect(s.changes()).toBe(3)
    expect(s.reader.started).toBe(1)
    await s.service.update({ approveDrafts: true })
    expect(s.changes()).toBe(3)
  })

  it('keeps the choices across a restart, and reads a damaged settings file as off', async () => {
    const first = setup()
    await first.service.load()
    await first.service.update({ enabled: true, accounts: [ALLOWED] })
    const again = setup()
    await again.service.load()
    expect(again.service.listTools()).toHaveLength(4)
    expect(again.reader.started).toBe(1)

    rmSync(join(root, 'mail.json'))
    const damaged = setup({ settings: '{"enabled": true, "accounts": ["x"], "sneaky": 1}' })
    await damaged.service.load()
    expect(damaged.service.listTools()).toEqual([])
    expect(damaged.reader.started).toBe(0)
  })

  it('refuses settings it does not know', async () => {
    const s = setup()
    await s.service.load()
    await expect(s.service.update({ accounts: ['../etc'] })).rejects.toThrow()
    await expect(s.service.update({ sending: true } as never)).rejects.toThrow()
  })

  it('shows agents only the accounts the person picked, and audits every call', async () => {
    const s = setup()
    await s.service.load()
    await s.service.update({ enabled: true, accounts: [ALLOWED] })
    const result = await s.service.call(call('search', {}), signal)
    expect(result.status).toBe('ok')
    const ids = (result as { output: { messages: { id: number }[] } }).output.messages.map((m) => m.id)
    expect(ids).toContain(7)
    expect(ids).not.toContain(11)
    expect((await s.service.call(call('read', { id: 11 }), signal)).status).toBe('failed')

    await s.service.update({ accounts: [OTHER] })
    const other = await s.service.call(call('search', {}), signal)
    const otherIds = (other as { output: { messages: { id: number }[] } }).output.messages.map((m) => m.id)
    expect(otherIds).toEqual([11])

    expect(s.audited.map((a) => [a.call.tool, a.result.status])).toEqual([
      ['search', 'ok'],
      ['read', 'failed'],
      ['search', 'ok'],
    ])
  })

  it('answers nothing once Mail is turned off, even for a call already listed', async () => {
    const s = setup()
    await s.service.load()
    await s.service.update({ enabled: true, accounts: [ALLOWED] })
    await s.service.update({ enabled: false })
    expect(await s.service.call(call('accounts'), signal)).toEqual({
      status: 'failed',
      stage: 'config',
      errorClass: 'not-found',
    })
    expect(s.audited).toHaveLength(1)
  })

  it('saves a draft only while drafts are on', async () => {
    const s = setup()
    await s.service.load()
    await s.service.update({ enabled: true, accounts: [ALLOWED] })
    const draft = { to: ['ada@example.com'], subject: 'Hi', body: 'Hello' }
    expect((await s.service.call(call('create_draft', draft), signal)).status).not.toBe('ok')
    expect(s.saved).toEqual([])
    await s.service.update({ drafts: true })
    expect((await s.service.call(call('create_draft', draft), signal)).status).toBe('ok')
    expect(s.saved).toHaveLength(1)
  })

  it('tells the setup screen where setup stands', async () => {
    const none = setup({ reader: false })
    await none.service.load()
    expect((await none.service.status()).state).toBe('off')
    await none.service.update({ enabled: true })
    expect((await none.service.status()).state).toBe('no-reader')
    expect(await none.service.startReader()).toBe('no-reader')

    const s = setup()
    await s.service.load()
    await s.service.update({ enabled: true })
    expect((await s.service.status()).state).toBe('not-running')
    await listening(s.reader.socketPath)
    const ready = await s.service.status()
    expect(ready.state).toBe('ready')
    expect(ready.accounts.map((a) => [a.id, a.allowed])).toEqual(
      expect.arrayContaining([
        [ALLOWED, false],
        [OTHER, false],
      ]),
    )
    await s.service.update({ accounts: [ALLOWED] })
    expect((await s.service.status()).accounts.find((a) => a.id === ALLOWED)?.allowed).toBe(true)
  })

  it('says the reader needs Full Disk Access when it cannot open Mail’s files', async () => {
    const refusing: MailFiles = {
      library: async () => {
        throw new MailFilesError('unavailable')
      },
      query: async () => [],
      file: async () => Buffer.alloc(0),
      list: async () => [],
      spotlight: async () => [],
    }
    const s = setup({ files: refusing })
    await s.service.load()
    await s.service.update({ enabled: true })
    await listening(s.reader.socketPath)
    expect(await s.service.status()).toEqual({
      state: 'needs-access',
      settings: expect.anything(),
      accounts: [],
    })
  })

  it('says when Mail’s index is laid out differently from what Valet reads', async () => {
    const lib = buildLibrary(mkdtempSync(join(root, 'odd-')), { dropColumn: 'sender' })
    const s = setup({ files: new DirectMailFiles(lib) })
    await s.service.load()
    await s.service.update({ enabled: true })
    await listening(s.reader.socketPath)
    expect((await s.service.status()).state).toBe('unsupported')
  })
})

describe('organising mail', () => {
  function organizing() {
    const asked: OrganizeRequest[] = []
    const moved: MoveRecord[] = []
    const s = setup({
      files: new DirectMailFiles(buildLibrary(mkdtempSync(join(root, 'lib-')), { withTrash: true })),
      organizer: {
        apply: async (request) => {
          asked.push(request)
          return { kind: 'done', results: request.items.map(() => 'done' as const) }
        },
      },
      moved: async (moves) => {
        moved.push(...moves)
      },
    })
    return { ...s, asked, moved }
  }

  it('lists move and mark only with its own switch, and records every move', async () => {
    const s = organizing()
    await s.service.load()
    await s.service.update({ enabled: true, accounts: [ALLOWED] })
    expect(s.service.listTools().map((t) => t.declaration.name)).not.toContain('move')
    expect((await s.service.call(call('move', { ids: [7], to: 'trash' }), signal)).status).toBe('failed')
    await s.service.update({ organize: true })
    expect(s.service.listTools().map((t) => t.declaration.name)).toEqual(
      expect.arrayContaining(['move', 'mark']),
    )
    const result = await s.service.call(call('move', { ids: [7], to: 'trash' }), signal)
    expect(result.status).toBe('ok')
    expect(s.moved).toEqual([expect.objectContaining({ from: 'INBOX', to: 'Deleted Messages' })])
    expect(s.audited.map((a) => [a.call.tool, a.result.status])).toEqual([
      ['move', 'failed'],
      ['move', 'ok'],
    ])
  })

  it('stops at 500 moves an hour across agents', async () => {
    let now = 0
    const s = organizing()
    ;(s.service as unknown as { deps: { now: () => number } }).deps.now = () => now
    await s.service.load()
    await s.service.update({ enabled: true, accounts: [ALLOWED], organize: true })
    // The made-up Mail moves nothing, so the same two messages count again each time: 250 calls of two.
    for (let i = 0; i < 250; i++)
      expect((await s.service.call(call('move', { ids: [7, 8], to: 'trash' }), signal)).status).toBe('ok')
    expect(await s.service.call(call('move', { ids: [7], to: 'archive' }), signal)).toMatchObject({
      status: 'failed',
      errorClass: 'rate-limited',
    })
    now += 3_600_001
    expect((await s.service.call(call('move', { ids: [7], to: 'archive' }), signal)).status).toBe('ok')
  })

  it('puts moves back where they came from, as Undo asks', async () => {
    const s = organizing()
    await s.service.load()
    expect(
      await s.service.undoMoves([
        {
          accountId: ALLOWED,
          messageId: 'engine-1@example.com',
          from: 'INBOX',
          to: 'Deleted Messages',
          subject: 'Engine notes',
          sender: null,
          date: null,
        },
      ]),
    ).toBe('done')
    expect(s.asked).toEqual([
      {
        kind: 'move',
        to: 'INBOX',
        items: [{ messageId: 'engine-1@example.com', accountId: ALLOWED, mailbox: 'Deleted Messages' }],
      },
    ])
  })
})

describe('RuntimeToolCaller with built-in tools', () => {
  const listed = (adapterId: string, name: string) => ({
    adapterId,
    adapterName: adapterId,
    adapterHash: 'a'.repeat(64),
    declaration: { name, title: name, description: 'd', sideEffect: 'read' as const },
    input: {} as never,
    output: {} as never,
  })

  function caller(native: NativeTools, paused = false) {
    const runtimeCalls: unknown[] = []
    const finished: string[] = []
    const c = new RuntimeToolCaller(
      {
        listTools: async () => [listed('mail', 'shadow'), listed('shop', 'echo')],
        call: async (request) => {
          runtimeCalls.push(request)
          return { status: 'ok', output: {} }
        },
      },
      {
        paused: () => paused,
        started: () => {},
        finished: (call, result) => finished.push(`${call.tool} ${result.status}`),
        refused: async () => {},
      },
      [native],
    )
    return { c, runtimeCalls, finished }
  }

  const native = (result: () => Promise<ToolCallResult>): NativeTools & { calls: ToolCall[] } => {
    const calls: ToolCall[] = []
    return {
      adapterId: 'mail',
      calls,
      listTools: () => [listed('mail', 'search'), listed('other', 'sneaky')],
      call: async (c) => {
        calls.push(c)
        return result()
      },
    }
  }

  it('lists built-in tools first, and an installed adapter can’t take their id', async () => {
    const { c } = caller(native(async () => ({ status: 'ok', output: {} })))
    await c.refresh()
    expect(c.listTools().map((t) => `${t.adapterId}.${t.declaration.name}`)).toEqual([
      'mail.search',
      'shop.echo',
    ])
  })

  it('sends a built-in call to its source, never the runtime', async () => {
    const n = native(async () => ({ status: 'ok', output: { a: 1 } }))
    const { c, runtimeCalls, finished } = caller(n)
    expect(await c.call({ adapterId: 'mail', tool: 'search', input: {}, client: 'x', callId: 'c1' })).toEqual(
      {
        status: 'ok',
        output: { a: 1 },
      },
    )
    expect(n.calls).toHaveLength(1)
    expect(runtimeCalls).toEqual([])
    expect(finished).toEqual(['search ok'])
  })

  it('applies the app’s refusals to built-in tools too', async () => {
    const n = native(async () => ({ status: 'ok', output: {} }))
    const { c } = caller(n, true)
    const outcome = await c.call({ adapterId: 'mail', tool: 'search', input: {}, client: 'x', callId: 'c1' })
    expect(outcome.status).not.toBe('ok')
    expect(n.calls).toEqual([])
  })

  it('turns a built-in tool that throws into a failed call', async () => {
    const { c, finished } = caller(
      native(async () => {
        throw new Error('boom')
      }),
    )
    const outcome = await c.call({ adapterId: 'mail', tool: 'search', input: {}, client: 'x', callId: 'c1' })
    expect(outcome.status).toBe('failed')
    expect(finished).toEqual(['search failed'])
  })
})
