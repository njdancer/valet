// A `raw` adapter's manifest rules (docs/adapter-kinds.md#raw): endpoints instead of egress and
// requests, no browser parts, no login, files as its only sandbox exceptions, and entrusted
// credentials only for endpoints it can reach.

import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_RUNTIMES,
  homeUnreachable,
  type ManifestInput,
  manifestSchema,
  parseManifest,
  rawEndpoints,
  runtimeOf,
} from '../src/manifest'

const RAW: ManifestInput = {
  schemaVersion: 1,
  id: 'mail-reader',
  name: 'Mail reader',
  version: '0.1.0',
  description: 'Reads mail with an npm IMAP client.',
  runtime: 'raw',
  endpoints: ['imap.example.com:993', 'api.example.com:443'],
  tools: [
    { name: 'list_unread', title: 'List unread', description: 'Lists unread mail.', sideEffect: 'read' },
  ],
}

const copy = (): ManifestInput & Record<string, unknown> =>
  structuredClone(RAW) as ManifestInput & Record<string, unknown>
const issues = (input: unknown): string[] => {
  const result = manifestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe('runtime: raw', () => {
  it('is available', () => {
    expect(AVAILABLE_RUNTIMES).toContain('raw')
  })

  it('parses, with home derived from its first endpoint', () => {
    const manifest = parseManifest(copy())
    expect(runtimeOf(manifest)).toBe('raw')
    expect(manifest.home).toBe('https://imap.example.com:993/')
    expect(manifest.navigation).toEqual([])
    expect(homeUnreachable(manifest)).toBeNull()
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest)
  })

  it('drops the port from home on 443', () => {
    const input = copy()
    input.endpoints = ['api.example.com:443']
    expect(parseManifest(input).home).toBe('https://api.example.com/')
  })

  it('still refuses a home that is not derived', () => {
    const once = structuredClone(parseManifest(copy())) as unknown as Record<string, unknown>
    once['home'] = 'https://elsewhere.example.com/'
    expect(issues(once)).toContain('a raw adapter has no home: it opens no pages')
  })

  it('refuses browser parts, egress hosts and requests', () => {
    const nav = copy()
    nav.navigation = ['https://imap.example.com']
    expect(issues(nav)).toContain('a raw adapter has no navigation origins')
    const cart = copy()
    cart.cartUrl = 'https://imap.example.com/cart'
    expect(issues(cart)).toContain('a raw adapter has no cartUrl')
    const egress = copy()
    egress.egress = ['api.example.com']
    expect(issues(egress)).toContain('a raw adapter names endpoints ("host:port"), not egress hosts')
    const requests = copy()
    requests.requests = [{ method: 'GET', path: '/x', purpose: 'read' }]
    expect(issues(requests)).toContain(
      'a raw adapter has no requests: Valet can’t see inside its connections',
    )
  })

  it('has no login', () => {
    const input = copy()
    input.session = {
      cookieDomains: ['example.com'],
      probe: { kind: 'fetch', path: '/me', expectStatus: 200 },
    }
    input.auth = { steps: [{ op: 'goto', url: 'https://imap.example.com/login' }] }
    expect(issues(input)).toContain('a raw adapter has no login: its probe is none')
  })

  it('has no irreversible tools, since nothing could confirm one', () => {
    const input = copy()
    input.tools = [{ name: 'send', title: 'Send', description: 'Sends mail.', sideEffect: 'irreversible' }]
    expect(issues(input)).toContain("tool send: a raw adapter's tools are read or write, not irreversible")
  })

  it('needs somewhere to go, each once', () => {
    const none = copy()
    none.endpoints = []
    expect(issues(none)).toContain('a raw adapter needs an endpoint or a private host')
    const twice = copy()
    twice.endpoints = ['imap.example.com:993', 'imap.example.com:993']
    expect(issues(twice)).toContain('endpoints lists the same endpoint twice')
  })

  it('may reach a private host instead, without a pinned certificate', () => {
    const input = copy()
    input.endpoints = undefined
    input.privateHosts = [{ address: '192.168.1.20', port: 8123 }]
    const manifest = parseManifest(input)
    expect(manifest.home).toBe('https://192.168.1.20:8123/')
    expect(rawEndpoints(manifest)).toEqual(['192.168.1.20:8123'])
    const pinned = copy()
    pinned.privateHosts = [{ address: '192.168.1.20', port: 8123, certSha256: 'a'.repeat(64) }]
    expect(issues(pinned).join('\n')).toContain('certSha256 is not for it')
  })

  it('lists its endpoints, then its private hosts, unbracketed', () => {
    const input = copy()
    input.privateHosts = [{ address: 'fd00::5', port: 80 }]
    expect(rawEndpoints(parseManifest(input))).toEqual([
      'imap.example.com:993',
      'api.example.com:443',
      'fd00::5:80',
    ])
  })

  it.each([
    'IMAP.example.com:993',
    'imap.example.com',
    '10.0.0.5:22',
    '127.0.0.1:8080',
    '[::1]:443',
    '*.example.com:443',
  ])('refuses the endpoint %s', (endpoint) => {
    const input = copy()
    input.endpoints = [endpoint]
    expect(issues(input).length).toBeGreaterThan(0)
  })

  it('takes only file exceptions, and never runs unsandboxed', () => {
    const files = copy()
    files.sandbox = {
      mode: 'sandboxed',
      exceptions: [
        { kind: 'files', access: 'read', paths: ['~/Documents/Mail'], purpose: 'Reads saved mail.' },
      ],
    }
    expect(issues(files)).toEqual([])
    const network = copy()
    network.sandbox = {
      mode: 'sandboxed',
      exceptions: [{ kind: 'local-service', port: 8080, purpose: 'A local service.' }],
    }
    expect(issues(network)).toContain(
      "sandbox exception local-service: a raw adapter's only exceptions are files (its network is its endpoints)",
    )
    const loose = copy()
    loose.sandbox = { mode: 'unsandboxed', reason: 'It needs everything.' }
    expect(issues(loose)).toContain('a raw adapter always runs in its sandbox profile')
  })

  it('entrusts a credential only for endpoints it can reach', () => {
    const ok = copy()
    ok.credentials = {
      mail: {
        description: 'An app password',
        kind: 'password',
        custody: 'entrusted',
        use: { entrusted: { endpoints: ['imap.example.com:993'] } },
      },
    }
    expect(issues(ok)).toEqual([])
    const elsewhere = copy()
    elsewhere.credentials = {
      mail: {
        description: 'An app password',
        kind: 'password',
        custody: 'entrusted',
        use: { entrusted: { endpoints: ['smtp.example.com:465'] } },
      },
    }
    expect(issues(elsewhere)).toContain(
      "credential mail: smtp.example.com:465 is not one of the adapter's endpoints or private hosts",
    )
    const kept = copy()
    kept.credentials = {
      api: {
        description: 'A token',
        kind: 'token',
        custody: 'kept',
        use: { header: { name: 'authorization', format: 'Bearer {value}' }, hosts: ['api.example.com'] },
      },
    }
    expect(issues(kept).join('\n')).toContain('a raw adapter may not declare a header credential')
  })
})
