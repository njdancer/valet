// A raw adapter end to end through the tool host (docs/adapter-kinds.md#raw): its code in the Node
// runtime's process, its sockets through the egress broker's real tunnels (exact endpoints, the SNI
// check, the upload budget, pacing and audit), and ctx.secrets through a CredentialGate, which
// narrows the call's tunnels to the credential's endpoints. The servers are fakes on loopback.

import { homedir } from 'node:os'
import {
  type AuditEvent,
  type CredentialGrant,
  defineAdapter,
  type ManifestInput,
  parseManifest,
  rawEndpoints,
  SecretValue,
  tool,
  ValetError,
} from '@valet/core'
import { EgressBroker, type Lookup } from '@valet/egress'
import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { type CredentialGrantSource, noBrowserDriver, ToolHost } from '@valet/runtime'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { FakeClock, FakePrompt, MemoryAudit, MemoryJsonStore, MemoryMarkers } from '../../runtime/test/fakes'
import { nodeRuntimeProcess } from '../src/spawn'
import { mac, scriptFor } from './helpers'

const HASH = 'f'.repeat(64)
const TOKEN = 'hk_live_4f3e2d1c0b9a8f7e6d5c'

const MANIFEST: ManifestInput = {
  schemaVersion: 1,
  id: 'raw-notes',
  name: 'Raw notes',
  version: '0.1.0',
  description: 'A raw adapter with an entrusted token.',
  runtime: 'raw',
  endpoints: ['api.example.test:443', 'feeds.example.test:443'],
  credentials: {
    api: {
      description: 'The notes API token',
      kind: 'token',
      custody: 'entrusted',
      use: { entrusted: { endpoints: ['api.example.test:443'] } },
    },
  },
  limits: { requestsPerRun: 10, minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 600 },
  tools: [
    'items',
    'leak_output',
    'use_token',
    'token_elsewhere',
    'token_into_open_socket',
    'big_upload',
    'other_name',
    'secret',
    'others',
    'page',
  ]
    .map((name) => ({
      name,
      title: name,
      description: `The ${name} test tool.`,
      sideEffect: 'read' as 'read' | 'irreversible',
    }))
    .concat([
      { name: 'remove', title: 'Remove', description: 'Deletes an item.', sideEffect: 'irreversible' },
    ]),
}
const manifest = parseManifest(MANIFEST)

const loopback: Lookup = (_name, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }])

let api: FakeApi
let script: string
beforeAll(async () => {
  api = await startFakeApi()
  script = await scriptFor('raw-adapter.ts')
})
afterAll(async () => {
  await api.close()
})

const grant = (over: Partial<CredentialGrant> = {}): CredentialGrant => ({
  adapterId: 'raw-notes',
  adapterHash: HASH,
  credential: 'api',
  kind: 'token',
  custody: 'entrusted',
  provider: 'keychain-copy',
  itemRef: 'keychain:raw-notes',
  targets: ['api.example.test:443'],
  grantedAt: '2026-11-17T00:00:00.000Z',
  ...over,
})

function setup(options: { grants?: CredentialGrantSource | null; raw?: boolean } = {}) {
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const prompt = new FakePrompt()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'raw-notes' && hash === HASH },
    audit,
    prompt,
    authRunner: vi.fn(async () => ({ status: 'ok' as const })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    pacingSleep: clock.pacingSleep,
  })
  const broker = new EgressBroker(
    { egress: [], endpoints: manifest.endpoints ?? [] },
    {
      lookup: loopback,
      testing: { allowAddresses: ['127.0.0.1'], route: () => ({ address: '127.0.0.1', port: api.port }) },
    },
  )
  const stderr: string[] = []
  const definition = defineAdapter({
    manifest,
    tools: Object.fromEntries(
      manifest.tools.map((t) => [
        t.name,
        tool({
          input: z.record(z.string(), z.unknown()),
          output: z.record(z.string(), z.unknown()),
          run: async () => {
            throw new ValetError('tool-run', 'internal')
          },
        }),
      ]),
    ),
  })
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    ...(options.raw === false
      ? {}
      : {
          raw: {
            script,
            start: (openTunnels) =>
              nodeRuntimeProcess({
                nodeBinary: process.execPath,
                endpoints: rawEndpoints(manifest),
                openTunnels,
                home: homedir(),
                withoutSeatbelt: !mac,
                onStderr: (t) => stderr.push(t),
              }),
            tunnels: (run, opts) => broker.tunnels(run, opts),
          },
        }),
    ...(options.grants === null
      ? {}
      : {
          credentialGrants: options.grants ?? {
            findGrant: async (credential) => (credential === 'api' ? grant() : null),
            resolve: async () => SecretValue.fromString(TOKEN),
          },
        }),
  })
  let n = 0
  const call = (name: string, input: Record<string, unknown> = {}) =>
    host.call({
      adapterId: 'raw-notes',
      tool: name,
      input: { ca: api.cert, ...input },
      client: 'claude-code',
      callId: `c-${++n}`,
    })
  return { call, audit, stderr, prompt }
}

const connections = (events: readonly AuditEvent[]) =>
  events.filter((e) => e.type === 'egress-connection') as Extract<AuditEvent, { type: 'egress-connection' }>[]

describe('a raw adapter’s irreversible tool (the raw confirmation)', () => {
  it('asks first with the tool, its input and everything the run reaches, and runs nothing on a no', async () => {
    const { call, audit, prompt } = setup()
    prompt.answer = 'declined'
    const before = api.seen.length
    expect(await call('remove', { id: 'note-7' })).toEqual({ status: 'declined' })
    expect(prompt.requests).toEqual([
      expect.objectContaining({
        adapterId: 'raw-notes',
        tool: 'remove',
        kind: 'raw-tool',
        input: { ca: api.cert, id: 'note-7' },
        endpoints: ['api.example.test:443', 'feeds.example.test:443'],
        credentials: ['api'],
        readFolders: [],
        writeFolders: [],
      }),
    ])
    // No process, no connection, no secret: its code never ran.
    expect(api.seen.length).toBe(before)
    expect(connections(audit.events)).toEqual([])
    expect(audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'confirmation', answer: 'declined' }))
  })

  it('runs once on a yes', async () => {
    const { call, prompt } = setup()
    expect(await call('remove', { id: 'note-8' })).toEqual({ status: 'ok', output: { status: 200 } })
    expect(prompt.requests.map((r) => r.kind)).toEqual(['raw-tool'])
    expect(api.seen.at(-1)).toMatchObject({ method: 'POST', url: '/v1/echo', body: 'delete note-8' })
  })

  it('treats an unanswered or cancelled confirmation as a no', async () => {
    for (const answer of ['timed-out', 'cancelled'] as const) {
      const { call, prompt } = setup()
      prompt.answer = answer
      const before = api.seen.length
      const result = await call('remove', { id: 'note-9' })
      expect(result.status === 'declined' || result.status === 'failed').toBe(true)
      expect(api.seen.length).toBe(before)
    }
  })

  it('asks nothing for its read tools', async () => {
    const { call, prompt } = setup()
    expect(await call('items')).toMatchObject({ status: 'ok' })
    expect(prompt.requests).toEqual([])
  })
})

describe('a raw adapter through the tool host', () => {
  it('reaches its endpoint through the broker’s tunnel, and the connection is audited', async () => {
    const { call, audit } = setup()
    const result = await call('items')
    expect(result).toMatchObject({ status: 'ok', output: { status: 200 } })
    const [connection] = connections(audit.events)
    expect(connection).toMatchObject({ endpoint: 'api.example.test:443', kind: 'tunnel', errorClass: null })
    expect(connection?.bytesUp).toBeGreaterThan(0)
    expect(api.seen.at(-1)?.servername).toBe('api.example.test')
  })

  it('gives an entrusted token, audits it, and uses it with its own endpoint', async () => {
    const { call, audit } = setup()
    const result = await call('use_token')
    expect(result).toEqual({ status: 'ok', output: { status: 200, sawToken: true } })
    expect(audit.events.filter((e) => e.type === 'secret-used')).toEqual([
      expect.objectContaining({
        adapterId: 'raw-notes',
        adapterHash: HASH,
        secret: 'api',
        origin: 'api.example.test:443',
        custody: 'entrusted',
        callId: 'c-1',
      }),
    ])
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN)
  })

  it('redacts the token and its encodings from the output', async () => {
    const { call, audit } = setup()
    const result = await call('leak_output')
    expect(result.status).toBe('ok')
    const text = JSON.stringify(result)
    const bytes = Buffer.from(TOKEN)
    for (const form of [
      TOKEN,
      bytes.toString('base64'),
      bytes.toString('base64url'),
      bytes.toString('hex'),
      [...TOKEN].reverse().join(''),
      encodeURIComponent(TOKEN),
    ])
      expect(text).not.toContain(form)
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN)
  })

  it('refuses another endpoint once the token is given, and ends the call', async () => {
    const before = api.seen.length
    const { call, audit } = setup()
    const result = await call('token_elsewhere')
    expect(result).toEqual({ status: 'failed', stage: 'egress', errorClass: 'host-not-allowed' })
    expect(api.seen.slice(before).some((s) => s.url.includes(TOKEN))).toBe(false)
    expect(connections(audit.events)).toContainEqual(
      expect.objectContaining({ endpoint: 'feeds.example.test:443', errorClass: 'host-not-allowed' }),
    )
  })

  it('closes a connection to another endpoint that was open when the token was given', async () => {
    const before = api.seen.length
    const { call } = setup()
    const result = await call('token_into_open_socket')
    // The call ends either way; what matters is that nothing with the token reached the server.
    expect(result.status).not.toBe('blocked')
    expect(api.seen.slice(before).some((s) => s.url.includes(TOKEN))).toBe(false)
  })

  it('holds a read to its upload budget, and fails the call past it', async () => {
    const before = api.seen.length
    const { call, audit } = setup()
    const result = await call('big_upload', { bytes: 200_000 })
    expect(result).toEqual({ status: 'failed', stage: 'egress', errorClass: 'upload-budget' })
    expect(api.seen.slice(before).some((s) => s.body.length >= 200_000)).toBe(false)
    expect(connections(audit.events)).toContainEqual(expect.objectContaining({ errorClass: 'upload-budget' }))
  })

  it('refuses another server’s name on an endpoint’s tunnel', async () => {
    const before = api.seen.length
    const { call } = setup()
    const result = await call('other_name')
    expect(result).toEqual({ status: 'failed', stage: 'egress', errorClass: 'sni-mismatch' })
    expect(api.seen.length).toBe(before)
  })

  it('refuses a credential without a grant, an undeclared one, and one granted to another version', async () => {
    const none = setup({
      grants: { findGrant: async () => null, resolve: async () => SecretValue.fromString(TOKEN) },
    })
    expect(await none.call('secret', { name: 'api' })).toEqual({
      status: 'ok',
      output: { refused: 'not-granted' },
    })
    const other = setup({
      grants: {
        findGrant: async () => grant({ adapterHash: 'e'.repeat(64) }),
        resolve: async () => SecretValue.fromString(TOKEN),
      },
    })
    expect(await other.call('secret', { name: 'api' })).toEqual({
      status: 'ok',
      output: { refused: 'not-granted' },
    })
    const undeclared = setup()
    expect(await undeclared.call('secret', { name: 'mail' })).toEqual({
      status: 'ok',
      output: { refused: 'not-granted' },
    })
    const noSource = setup({ grants: null })
    expect(await noSource.call('secret', { name: 'api' })).toEqual({
      status: 'ok',
      output: { refused: 'not-granted' },
    })
  })

  it('has no ctx.http or ctx.local, and a page call ends the call', async () => {
    const { call } = setup()
    expect(await call('others')).toEqual({
      status: 'ok',
      output: { http: 'not-granted', local: 'not-granted' },
    })
    const page = await call('page')
    expect(page.status).toBe('failed')
  })

  it('is unavailable without its runtime, and never runs anywhere else', async () => {
    const { call } = setup({ raw: false })
    expect(await call('items')).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'unavailable' })
  })
})
