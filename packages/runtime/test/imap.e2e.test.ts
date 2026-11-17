// ctx.imap through the tool host: a protocol adapter's tool runs, the host builds GuardedImap for
// the call, and the backend signs in through the call's CredentialGate, audited and redacted. The
// backend here is a fake that records what it was given; packages/protocols tests the real one.

import { join } from 'node:path'
import {
  type CredentialGrant,
  defineAdapter,
  parseManifest,
  SecretValue,
  type ToolContext,
  tool,
} from '@valet/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ImapBackend, ImapCall } from '../src/guarded-imap'
import { noBrowserDriver } from '../src/no-browser-driver'
import { type CredentialGrantSource, ToolHost, type ToolIsolation } from '../src/tool-host'
import type { AuthRunner } from '../src/types'
import { FakeClock, FakePrompt, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'
import { inMemory, scriptFor } from './isolation/processes'

const HASH = 'e'.repeat(64)
const PASSWORD = 'abcd-efgh-ijkl-mnop'
const ENDPOINT = 'imap.mail.me.com:993'

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'icloud-mail',
  name: 'iCloud Mail',
  version: '0.1.0',
  description: 'A protocol adapter for mail',
  runtime: 'protocol',
  protocols: { imap: { endpoint: ENDPOINT, credential: 'mail', folders: ['INBOX', 'Receipts'] } },
  credentials: {
    mail: {
      description: 'Your iCloud app-specific password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: ENDPOINT },
    },
  },
  tools: [
    { name: 'read_mail', title: 'Read mail', description: 'Reads', sideEffect: 'read' },
    { name: 'file_mail', title: 'File mail', description: 'Files', sideEffect: 'write' },
  ],
  limits: { requestsPerRun: 10, minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 600 },
})

let body: (ctx: ToolContext) => Promise<unknown> = async () => null
const definition = defineAdapter({
  manifest,
  tools: {
    // `do` is for the isolated script's tools (isolation/imap-tools.ts).
    read_mail: tool({
      input: z.object({ do: z.string().optional() }),
      output: z.unknown(),
      run: (ctx) => body(ctx),
    }),
    file_mail: tool({
      input: z.object({ do: z.string().optional() }),
      output: z.unknown(),
      run: (ctx) => body(ctx),
    }),
  },
})

const grant: CredentialGrant = {
  adapterId: 'icloud-mail',
  adapterHash: HASH,
  credential: 'mail',
  kind: 'password',
  custody: 'kept',
  provider: 'keychain-copy',
  itemRef: 'keychain:icloud-mail',
  targets: [ENDPOINT],
  grantedAt: '2026-11-17T00:00:00.000Z',
}

/** A backend that signs in on connect and answers each operation with what the server "said". */
function backend(answer: (op: string, password: string) => unknown = () => ({ ok: true })) {
  const calls: { purpose: string; op?: string }[] = []
  const b: ImapBackend = {
    endpoint: ENDPOINT,
    folders: ['INBOX', 'Receipts'],
    connect: async (call: ImapCall) => {
      const values = await call.signIn()
      const password = values.secret.reveal((v) => v)
      calls.push({ purpose: call.purpose })
      return {
        operation: async (op) => {
          calls.push({ purpose: call.purpose, op })
          return answer(op, password)
        },
        end: async () => {},
      }
    },
  }
  return { b, calls }
}

function setup(
  options: { grants?: CredentialGrantSource | null; imap?: ImapBackend; isolation?: ToolIsolation } = {},
) {
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'icloud-mail' && hash === HASH },
    audit,
    prompt: new FakePrompt(),
    authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    sleep: clock.sleep,
    pacingSleep: clock.pacingSleep,
  })
  const grants: CredentialGrantSource = {
    findGrant: async (credential) => (credential === 'mail' ? grant : null),
    resolve: async (_grant, field) =>
      SecretValue.fromString(field === 'username' ? 'nick@icloud.test' : PASSWORD),
  }
  const fake = backend()
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    imap: options.imap ?? fake.b,
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    ...(options.grants === null ? {} : { credentialGrants: options.grants ?? grants }),
  })
  let n = 0
  const run = (name: 'read_mail' | 'file_mail' = 'read_mail', input: unknown = {}) =>
    host.call({ adapterId: 'icloud-mail', tool: name, input, client: 'claude-code', callId: `c-${++n}` })
  return { run, audit, calls: fake.calls }
}

beforeEach(() => {
  body = async () => null
})

describe('ctx.imap through the tool host', () => {
  it('signs in through the call’s grant, audited, with the tool’s purpose', async () => {
    body = async (ctx) => ctx.imap?.search('INBOX', { seen: false })
    const t = setup()
    const result = await t.run()
    expect(result).toMatchObject({ status: 'ok' })
    expect(t.calls).toEqual([{ purpose: 'read' }, { purpose: 'read', op: 'search' }])
    expect(t.audit.events.filter((e) => e.type === 'secret-used')).not.toHaveLength(0)
  })

  it('takes the password back out of anything the server echoes', async () => {
    body = async (ctx) => ctx.imap?.status('INBOX')
    const fake = backend((_op, password) => ({ folder: `INBOX ${password}` }))
    const t = setup({ imap: fake.b })
    const result = await t.run()
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
  })

  it('refuses a move from a read tool, before the host is started', async () => {
    body = async (ctx) => ctx.imap?.move('INBOX', [1], 'Receipts')
    const t = setup()
    const result = await t.run()
    expect(result).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(t.calls).toEqual([])
    expect(t.audit.events).toContainEqual(
      expect.objectContaining({ type: 'request-blocked', method: 'IMAP', reason: 'command-not-allowed' }),
    )
  })

  it('lets a write tool file mail, in allowed folders only', async () => {
    body = async (ctx) => ctx.imap?.move('INBOX', [1], 'Receipts')
    const t = setup()
    expect(await t.run('file_mail')).toMatchObject({ status: 'ok' })
    expect(t.calls.at(-1)).toEqual({ purpose: 'write', op: 'move' })
    body = async (ctx) => ctx.imap?.move('INBOX', [1], 'Trash')
    expect(await t.run('file_mail')).toMatchObject({ status: 'failed' })
  })

  it('is not-granted without a grant, and sends nothing', async () => {
    body = async (ctx) => ctx.imap?.status('INBOX')
    const t = setup({ grants: null })
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(t.calls).toEqual([])
  })

  it('gives an adapter registered without a backend no IMAP', async () => {
    body = async (ctx) => ctx.imap?.status('INBOX')
    const audit = new MemoryAudit()
    const clock = new FakeClock()
    const host = new ToolHost({
      approvals: { isApproved: async () => true },
      audit,
      prompt: new FakePrompt(),
      authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
      markers: new MemoryMarkers(() => clock.now()),
      breakerStore: new MemoryJsonStore(),
      clock,
      sleep: clock.sleep,
      pacingSleep: clock.pacingSleep,
    })
    host.register({ definition, bundleHash: HASH, driver: noBrowserDriver() })
    const result = await host.call({
      adapterId: 'icloud-mail',
      tool: 'read_mail',
      input: {},
      client: 'claude-code',
      callId: 'x',
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
  })
})

describe('ctx.imap from an isolated tool process', () => {
  const IMAP_TOOLS = join(import.meta.dirname, 'isolation', 'imap-tools.ts')
  const isolated = async () => {
    const processes = inMemory()
    const world = setup({ isolation: { script: await scriptFor(IMAP_TOOLS), start: processes.start } })
    return {
      ...world,
      call: (what: string, name: 'read_mail' | 'file_mail' = 'read_mail') => world.run(name, { do: what }),
    }
  }

  it('runs operations across the channel, trailing options left out', async () => {
    const w = await isolated()
    expect(await w.call('search')).toEqual({ status: 'ok', output: { ok: true } })
    expect(await w.call('message')).toEqual({ status: 'ok', output: { ok: true } })
    expect(w.calls.filter((c) => c.op !== undefined).map((c) => c.op)).toEqual(['search', 'message'])
  })

  it('refuses a move from a read tool on the host side', async () => {
    const w = await isolated()
    expect(await w.call('move')).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(w.calls).toEqual([])
  })

  it('lets a write tool move', async () => {
    const w = await isolated()
    expect(await w.call('', 'file_mail')).toEqual({ status: 'ok', output: { ok: true } })
  })

  it('has no way to name an operation itself', async () => {
    const w = await isolated()
    expect(await w.call('raw')).toEqual({ status: 'ok', output: 'no raw op' })
    expect(w.calls).toEqual([])
  })
})
