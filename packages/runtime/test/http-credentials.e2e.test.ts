// Secrets v2 end to end through the tool host (docs/adapter-kinds.md#f2-secrets-version-2): an
// http adapter names a kept credential, the host builds a CredentialGate over its grants for the
// call, and ctx.http adds the header. Fakes stand in for the grant store and the provider.

import {
  type AuditEvent,
  type CredentialGrant,
  defineAdapter,
  type ItemField,
  parseManifest,
  SecretValue,
  type ToolContext,
  tool,
} from '@valet/core'
import type { ExchangeResult } from '@valet/egress'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { HttpEgress } from '../src/guarded-http'
import { noBrowserDriver } from '../src/no-browser-driver'
import { type CredentialGrantSource, ToolHost } from '../src/tool-host'
import type { AuthRunner } from '../src/types'
import { FakeClock, FakePrompt, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'

const HASH = 'd'.repeat(64)
const TOKEN = 'tok_9f8e7d6c5b4a39281706'

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'notes-api',
  name: 'Notes API',
  version: '0.1.0',
  description: 'An http adapter with a kept token',
  runtime: 'http',
  egress: ['api.example.test'],
  requests: [{ method: 'GET', host: 'api.example.test', path: '/v1/notes', purpose: 'read' }],
  credentials: {
    api: {
      description: 'The Notes API token',
      kind: 'token',
      custody: 'kept',
      use: { header: { name: 'authorization', format: 'Bearer {value}' }, hosts: ['api.example.test'] },
    },
  },
  tools: [{ name: 'list_notes', title: 'List notes', description: 'Lists notes', sideEffect: 'read' }],
  limits: { requestsPerRun: 10, minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 600 },
})

let body: (ctx: ToolContext) => Promise<unknown> = async () => null
const definition = defineAdapter({
  manifest,
  tools: { list_notes: tool({ input: z.object({}), output: z.unknown(), run: (ctx) => body(ctx) }) },
})

const grant = (over: Partial<CredentialGrant> = {}): CredentialGrant => ({
  adapterId: 'notes-api',
  adapterHash: HASH,
  credential: 'api',
  kind: 'token',
  custody: 'kept',
  provider: 'keychain-copy',
  itemRef: 'keychain:notes-api',
  targets: ['api.example.test'],
  grantedAt: '2026-11-17T00:00:00.000Z',
  ...over,
})

/** The API: answers notes to the right token, and records every authorization header it saw. */
function notesApi(reflect = false) {
  const seen: (string | undefined)[] = []
  const http: HttpEgress = {
    fetch: async (_url, request): Promise<ExchangeResult> => {
      const auth = request.headers['authorization']
      seen.push(auth)
      const ok = auth === `Bearer ${TOKEN}`
      const payload = reflect ? { auth } : ok ? { notes: ['milk', 'eggs'] } : { error: 'unauthorized' }
      return {
        status: ok ? 200 : 401,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)),
      }
    },
    websocket: async () => {
      throw new Error('unused')
    },
  }
  return { http, seen }
}

function setup(options: { grants?: CredentialGrantSource | null; http?: HttpEgress } = {}) {
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'notes-api' && hash === HASH },
    audit,
    prompt: new FakePrompt(),
    authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    sleep: clock.sleep,
    pacingSleep: clock.pacingSleep,
  })
  const resolved: ItemField[] = []
  const grants: CredentialGrantSource = {
    findGrant: async (credential) => (credential === 'api' ? grant() : null),
    resolve: async (_grant, field) => {
      resolved.push(field)
      return SecretValue.fromString(TOKEN)
    },
  }
  const api = notesApi()
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    http: options.http ?? api.http,
    ...(options.grants === null ? {} : { credentialGrants: options.grants ?? grants }),
  })
  let n = 0
  const run = () =>
    host.call({
      adapterId: 'notes-api',
      tool: 'list_notes',
      input: {},
      client: 'claude-code',
      callId: `c-${++n}`,
    })
  return { run, audit, seen: api.seen, resolved }
}

const used = (events: readonly AuditEvent[]) => events.filter((e) => e.type === 'secret-used')

beforeEach(() => {
  body = async () => null
})

describe('a kept credential through ctx.http', () => {
  it('adds the header from the grant, audits the use for the call, and never shows the token', async () => {
    const { run, audit, seen, resolved } = setup()
    body = async (ctx) => JSON.parse((await ctx.http!.fetch('/v1/notes', { credential: 'api' })).body)
    const result = await run()
    expect(result).toMatchObject({ status: 'ok', output: { notes: ['milk', 'eggs'] } })
    expect(seen).toEqual([`Bearer ${TOKEN}`])
    expect(resolved).toEqual(['token'])
    expect(used(audit.events)).toEqual([
      expect.objectContaining({
        adapterId: 'notes-api',
        adapterHash: HASH,
        secret: 'api',
        field: 'token',
        origin: 'api.example.test',
        callId: 'c-1',
        custody: 'kept',
      }),
    ])
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN)
  })

  it('keeps the token out of what the tool returns when the server echoes it', async () => {
    const api = notesApi(true)
    const { run, audit } = setup({ http: api.http })
    body = async (ctx) => (await ctx.http!.fetch('/v1/notes', { credential: 'api' })).body
    const result = await run()
    expect(JSON.stringify(result)).not.toContain(TOKEN)
    expect(JSON.stringify(result)).not.toContain(Buffer.from(TOKEN).toString('base64').slice(0, 20))
    expect(JSON.stringify(audit.events)).not.toContain(TOKEN)
  })

  it('sends nothing when there is no grant', async () => {
    const { run, seen, audit } = setup({
      grants: { findGrant: async () => null, resolve: async () => SecretValue.fromString(TOKEN) },
    })
    body = async (ctx) => JSON.parse((await ctx.http!.fetch('/v1/notes', { credential: 'api' })).body)
    const r = await run()
    expect(r).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(seen).toEqual([])
    expect(used(audit.events)).toEqual([])
  })

  it('refuses a grant made for another version of the adapter', async () => {
    const resolve = vi.fn(async () => SecretValue.fromString(TOKEN))
    const { run, seen } = setup({
      grants: { findGrant: async () => grant({ adapterHash: 'e'.repeat(64) }), resolve },
    })
    body = async (ctx) => JSON.parse((await ctx.http!.fetch('/v1/notes', { credential: 'api' })).body)
    const r = await run()
    expect(r).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(seen).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a credential the manifest does not declare', async () => {
    const { run, seen } = setup()
    body = async (ctx) => JSON.parse((await ctx.http!.fetch('/v1/notes', { credential: 'other' })).body)
    const r = await run()
    expect(r).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(seen).toEqual([])
  })

  it('sends nothing when the use cannot be audited', async () => {
    const { run, seen, audit } = setup()
    audit.failNext = 'secret-used'
    body = async (ctx) => JSON.parse((await ctx.http!.fetch('/v1/notes', { credential: 'api' })).body)
    const r = await run()
    expect(r).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(seen).toEqual([])
  })

  it('does not let tool code set the credential header itself', async () => {
    const { run, seen } = setup()
    body = async (ctx) =>
      JSON.parse((await ctx.http!.fetch('/v1/notes', { headers: { Authorization: 'Bearer guessed' } })).body)
    const r = await run()
    expect(r).toEqual({ status: 'failed', stage: 'request-surface', errorClass: 'undeclared-request' })
    expect(seen).toEqual([])
  })

  it('is not-granted for an adapter registered without grants', async () => {
    const { run, seen } = setup({ grants: null })
    body = async (ctx) => JSON.parse((await ctx.http!.fetch('/v1/notes', { credential: 'api' })).body)
    const r = await run()
    expect(r).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(seen).toEqual([])
  })
})
