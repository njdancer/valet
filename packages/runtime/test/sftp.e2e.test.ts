// ctx.sftp through the tool host: a protocol adapter's tool runs, the host builds GuardedSftp for
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
  ValetError,
} from '@valet/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { SftpBackend, SftpCall } from '../src/guarded-sftp'
import { noBrowserDriver } from '../src/no-browser-driver'
import { type CredentialGrantSource, ToolHost, type ToolIsolation } from '../src/tool-host'
import type { AuthRunner } from '../src/types'
import { FakeClock, FakePrompt, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'
import { inMemory, scriptFor } from './isolation/processes'

const HASH = 'f'.repeat(64)
const ENDPOINT = 'nas.example.test:22'
const PIN = `SHA256:${'A'.repeat(43)}`
const KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBkZXZpY2Uta2V5LWZvci12YWxldC10ZXN0cy1vbmx5AAAAkFZhbGV0VmFs',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n')

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'nas-files',
  name: 'NAS files',
  version: '0.1.0',
  description: 'A protocol adapter for files',
  runtime: 'protocol',
  protocols: {
    sftp: {
      endpoint: ENDPOINT,
      credential: 'nas',
      hostKeySha256: PIN,
      username: 'nick',
      roots: [
        { path: '/docs', access: 'read' },
        { path: '/inbox', access: 'write' },
      ],
    },
  },
  credentials: {
    nas: {
      description: 'A key Valet made for the NAS',
      kind: 'ssh-key',
      custody: 'kept',
      use: { protocol: 'sftp', endpoint: ENDPOINT },
    },
  },
  tools: [
    { name: 'read_files', title: 'Read files', description: 'Reads', sideEffect: 'read' },
    { name: 'file_files', title: 'File files', description: 'Files', sideEffect: 'write' },
  ],
  limits: { requestsPerRun: 10, minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 600 },
})

let body: (ctx: ToolContext) => Promise<unknown> = async () => null
const definition = defineAdapter({
  manifest,
  tools: {
    // `do` is for the isolated script's tools (isolation/sftp-tools.ts).
    read_files: tool({ input: z.object({ do: z.string().optional() }), output: z.unknown(), run: (ctx) => body(ctx) }),
    file_files: tool({ input: z.object({ do: z.string().optional() }), output: z.unknown(), run: (ctx) => body(ctx) }),
  },
})

const grant: CredentialGrant = {
  adapterId: 'nas-files',
  adapterHash: HASH,
  credential: 'nas',
  kind: 'ssh-key',
  custody: 'kept',
  provider: 'valet-key',
  itemRef: 'valet-key:2b1f2a3c-1111-4222-8333-444455556666',
  targets: [ENDPOINT],
  grantedAt: '2026-11-17T00:00:00.000Z',
}

/** A backend that signs in on connect and answers each operation with what the server "said". */
function backend(answer: (op: string, key: string) => unknown = () => ({ ok: true })) {
  const calls: { purpose: string; op?: string; args?: readonly unknown[]; username?: string | null }[] = []
  const b: SftpBackend = {
    endpoint: ENDPOINT,
    roots: manifest.protocols?.sftp?.roots ?? [],
    connect: async (call: SftpCall) => {
      const values = await call.signIn()
      const key = values.secret.reveal((v) => v)
      calls.push({ purpose: call.purpose, username: values.username?.reveal((v) => v) ?? null })
      return {
        operation: async (op, args) => {
          calls.push({ purpose: call.purpose, op, args })
          return answer(op, key)
        },
        end: async () => {},
      }
    },
  }
  return { b, calls }
}

function setup(
  options: { grants?: CredentialGrantSource | null; sftp?: SftpBackend; isolation?: ToolIsolation } = {},
) {
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'nas-files' && hash === HASH },
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
    findGrant: async (credential) => (credential === 'nas' ? grant : null),
    resolve: async (_grant, field) => {
      // A key Valet made has no username: the manifest's is used.
      if (field === 'username') throw new ValetError('credential', 'field-missing')
      return SecretValue.fromString(KEY)
    },
  }
  const fake = backend()
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    sftp: options.sftp ?? fake.b,
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    ...(options.grants === null ? {} : { credentialGrants: options.grants ?? grants }),
  })
  let n = 0
  const run = (name: 'read_files' | 'file_files' = 'read_files', input: unknown = {}) =>
    host.call({ adapterId: 'nas-files', tool: name, input, client: 'claude-code', callId: `c-${++n}` })
  return { run, audit, calls: fake.calls }
}

beforeEach(() => {
  body = async () => null
})

describe('ctx.sftp through the tool host', () => {
  it('signs in through the call’s grant, audited, with the tool’s purpose', async () => {
    body = async (ctx) => ctx.sftp?.list('/docs')
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'ok' })
    expect(t.calls).toEqual([
      { purpose: 'read', username: null },
      { purpose: 'read', op: 'list', args: ['/docs'] },
    ])
    expect(t.audit.events).toContainEqual(
      expect.objectContaining({ type: 'secret-used', secret: 'nas', origin: ENDPOINT, custody: 'kept' }),
    )
  })

  it('takes the key back out of anything the server echoes', async () => {
    body = async (ctx) => ctx.sftp?.read('/docs/a.txt', { encoding: 'utf8' })
    const fake = backend((_op, key) => ({ text: `here: ${key}`, base64: Buffer.from(key).toString('base64') }))
    const t = setup({ sftp: fake.b })
    const result = await t.run()
    const text = JSON.stringify(result)
    expect(text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ')
    expect(text).not.toContain(Buffer.from(KEY).toString('base64').slice(0, 40))
  })

  it('refuses a write from a read tool, before the host is started', async () => {
    body = async (ctx) => ctx.sftp?.write('/inbox/a.txt', 'x')
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(t.calls).toEqual([])
    expect(t.audit.events).toContainEqual(
      expect.objectContaining({ type: 'request-blocked', method: 'SFTP', reason: 'command-not-allowed' }),
    )
  })

  it('refuses paths outside the roots, or not in Valet’s form, and the refusal ends the call', async () => {
    for (const path of ['/private/key', '/docs/../private/key', '/docs/', 'docs/a.txt', '/docsx/a.txt']) {
      body = async (ctx) => ctx.sftp?.read(path)
      const t = setup()
      expect(await t.run()).toMatchObject({ status: 'failed' })
      expect(t.calls).toEqual([])
    }
    // A refusal is sticky: the tool can't catch it and carry on.
    body = async (ctx) => {
      await ctx.sftp?.read('/private/key').catch(() => undefined)
      return ctx.sftp?.list('/docs')
    }
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(t.calls).toEqual([])
  })

  it('needs an irreversible tool to replace, and never names a root for a change', async () => {
    body = async (ctx) => ctx.sftp?.write('/inbox/a.txt', 'x', { mode: 'replace' })
    expect(await setup().run('file_files')).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    body = async (ctx) => ctx.sftp?.rename('/inbox', '/inbox2')
    expect(await setup().run('file_files')).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    body = async (ctx) => ctx.sftp?.write('/inbox/a.txt', 'x', { mode: 'append' })
    expect(await setup().run('file_files')).toMatchObject({ status: 'ok' })
  })

  it('counts each operation against the request ceiling', async () => {
    body = async (ctx) => {
      for (let i = 0; i < 11; i++) await ctx.sftp?.stat('/docs')
    }
    const t = setup()
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'request-ceiling' })
    expect(t.calls.filter((c) => c.op === 'stat')).toHaveLength(10)
  })

  it('is not-granted without a grant, and sends nothing', async () => {
    body = async (ctx) => ctx.sftp?.list('/docs')
    const t = setup({ grants: null })
    expect(await t.run()).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(t.calls).toEqual([])
  })

  it('gives the tool no IMAP, and an IMAP adapter no SFTP', async () => {
    body = async (ctx) => ctx.imap?.listFolders()
    expect(await setup().run()).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
  })
})

describe('ctx.sftp from an isolated tool process', () => {
  const SFTP_TOOLS = join(import.meta.dirname, 'isolation', 'sftp-tools.ts')
  const isolated = async () => {
    const processes = inMemory()
    const world = setup({ isolation: { script: await scriptFor(SFTP_TOOLS), start: processes.start } })
    return {
      ...world,
      call: (what: string, name: 'read_files' | 'file_files' = 'read_files') => world.run(name, { do: what }),
    }
  }

  it('runs operations across the channel, trailing options left out', async () => {
    const w = await isolated()
    expect(await w.call('list')).toEqual({ status: 'ok', output: { ok: true } })
    expect(await w.call('read')).toEqual({ status: 'ok', output: { ok: true } })
    expect(w.calls.filter((c) => c.op !== undefined).map((c) => [c.op, c.args])).toEqual([
      ['list', ['/docs']],
      ['read', ['/docs/a.txt', { encoding: 'utf8' }]],
    ])
  })

  it('refuses a write from a read tool, and a path that climbs out, on the host side', async () => {
    const w = await isolated()
    expect(await w.call('write')).toMatchObject({ status: 'failed', errorClass: 'command-not-allowed' })
    expect(await w.call('escape')).toMatchObject({ status: 'failed' })
    expect(w.calls).toEqual([])
  })

  it('lets a write tool write', async () => {
    const w = await isolated()
    expect(await w.call('', 'file_files')).toEqual({ status: 'ok', output: { ok: true } })
  })

  it('has no way to name an operation itself', async () => {
    const w = await isolated()
    expect(await w.call('raw')).toEqual({ status: 'ok', output: 'no raw op' })
    expect(w.calls).toEqual([])
  })
})
