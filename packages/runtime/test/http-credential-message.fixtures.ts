// Shared set-up for the credential-message tests (docs/adapter-kinds.md#credential-messages): a
// real ToolHost with an http adapter whose kept token goes in a WebSocket sign-in message, over a
// scripted hub that stands in for the broker's socket.

import {
  type AuditEvent,
  type CredentialGrant,
  defineAdapter,
  type HttpSocket,
  parseManifest,
  SecretValue,
  type ToolContext,
  tool,
} from '@valet/core'
import { vi } from 'vitest'
import { z } from 'zod'
import type { EgressSocket, HttpEgress } from '../src/guarded-http'
import { noBrowserDriver } from '../src/no-browser-driver'
import { type CredentialGrantSource, ToolHost } from '../src/tool-host'
import type { AuthRunner } from '../src/types'
import { FakeClock, FakePrompt, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'

export const HASH = 'd'.repeat(64)
/** Long enough to be cut into 12-character pieces, with letters in both cases. */
export const TOKEN = 'hubTok_9f8e7d6c5b4a39281706Xy'

export const MESSAGE = { type: 'auth', access_token: '{value}' }

export const manifestJson = {
  schemaVersion: 1,
  id: 'hub',
  name: 'Hub',
  version: '0.1.0',
  description: 'An http adapter that signs in to a WebSocket with a kept token in a message',
  runtime: 'http',
  egress: ['hub.example.test', 'other.example.test'],
  privateHosts: [{ address: '192.168.1.30', port: 8080, scheme: 'http' }],
  requests: [
    { method: 'GET', host: 'hub.example.test', path: '/api/websocket', purpose: 'write', websocket: true },
    { method: 'GET', host: 'other.example.test', path: '/api/websocket', purpose: 'write', websocket: true },
    { method: 'GET', host: '192.168.1.30:8080', path: '/api/websocket', purpose: 'write', websocket: true },
  ],
  credentials: {
    hub: {
      description: 'The hub token',
      kind: 'token',
      custody: 'kept',
      use: { message: { json: MESSAGE }, hosts: ['hub.example.test', '192.168.1.30'] },
    },
    rest: {
      description: 'A header-only token',
      kind: 'token',
      custody: 'kept',
      use: { header: { name: 'authorization', format: 'Bearer {value}' }, hosts: ['hub.example.test'] },
    },
  },
  tools: [{ name: 'act', title: 'Act', description: 'Acts on the hub', sideEffect: 'write' }],
  limits: { requestsPerRun: 10, minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 600 },
}

export const grant = (over: Partial<CredentialGrant> = {}): CredentialGrant => ({
  adapterId: 'hub',
  adapterHash: HASH,
  credential: 'hub',
  kind: 'token',
  custody: 'kept',
  provider: 'keychain-copy',
  itemRef: 'keychain:hub',
  targets: ['hub.example.test', '192.168.1.30'],
  grantedAt: '2026-11-18T00:00:00.000Z',
  ...over,
})

/** What the scripted hub does with each message it is sent. */
export type HubScript = (
  text: string,
  hub: { push(data: string | Buffer, binary?: boolean): void; close(code: number): void; received: string[] },
) => void

/**
 * A hub like Home Assistant's: says auth_required on open, takes `{"type":"auth","access_token"}`
 * first, then hands every later message to `after`. Records what it was sent and opened with.
 */
export function scriptedHub(after: HubScript = () => undefined, token = TOKEN) {
  const sent: string[] = []
  const opened: { url: string; headers: Readonly<Record<string, string>> }[] = []
  const http: HttpEgress = {
    fetch: async () => {
      throw new Error('unused')
    },
    websocket: async (url, options): Promise<EgressSocket> => {
      opened.push({ url: url.href, headers: { ...(options.headers ?? {}) } })
      const queue: ({ kind: 'message'; data: Buffer; binary: boolean } | { kind: 'closed'; code: number })[] =
        []
      let authed = false
      const received: string[] = []
      const hub = {
        push: (data: string | Buffer, binary = false) =>
          queue.push({ kind: 'message', data: Buffer.isBuffer(data) ? data : Buffer.from(data), binary }),
        close: (code: number) => queue.push({ kind: 'closed', code }),
        received,
      }
      hub.push(JSON.stringify({ type: 'auth_required' }))
      return {
        send: async (data) => {
          const text = data.toString('utf8')
          sent.push(text)
          received.push(text)
          if (!authed) {
            const parsed = JSON.parse(text) as { type?: unknown; access_token?: unknown }
            authed = parsed.type === 'auth' && parsed.access_token === token
            hub.push(JSON.stringify({ type: authed ? 'auth_ok' : 'auth_invalid' }))
            return
          }
          after(text, hub)
        },
        receive: async () => queue.shift() ?? null,
        close: () => undefined,
      }
    },
  }
  return { http, sent, opened }
}

export function setupHub(
  options: {
    http?: HttpEgress
    grants?: CredentialGrantSource | null
    manifest?: Record<string, unknown>
  } = {},
) {
  let body: (ctx: ToolContext) => Promise<unknown> = async () => null
  const manifest = parseManifest(options.manifest ?? manifestJson)
  const definition = defineAdapter({
    manifest,
    tools: { act: tool({ input: z.object({}), output: z.unknown(), run: (ctx) => body(ctx) }) },
  })
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'hub' && hash === HASH },
    audit,
    prompt: new FakePrompt(),
    authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    sleep: clock.sleep,
    pacingSleep: clock.pacingSleep,
  })
  const resolve = vi.fn(async () => SecretValue.fromString(TOKEN))
  const grants: CredentialGrantSource = {
    findGrant: async (credential) =>
      credential === 'hub' ? grant() : credential === 'rest' ? grant({ credential: 'rest' }) : null,
    resolve,
  }
  const hub = scriptedHub()
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    http: options.http ?? hub.http,
    ...(options.grants === null ? {} : { credentialGrants: options.grants ?? grants }),
  })
  let n = 0
  const run = (tool: (ctx: ToolContext) => Promise<unknown>) => {
    body = tool
    return host.call({ adapterId: 'hub', tool: 'act', input: {}, client: 'claude-code', callId: `c-${++n}` })
  }
  return { run, audit, hub, resolve }
}

export const used = (events: readonly AuditEvent[]) => events.filter((e) => e.type === 'secret-used')

/** Every message the socket has, as text. */
export async function drain(socket: HttpSocket): Promise<string[]> {
  const out: string[] = []
  for (;;) {
    const message = await socket.receive({ waitMs: 0 })
    if (message === null || message.kind === 'closed') return out
    out.push(message.data)
  }
}
