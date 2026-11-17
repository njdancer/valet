// @vitest-environment node
// The worked examples (docs/adapter-kinds.md#h-example-adapters), end to end against fakes only
// (@valet/fake-example-services): each one starts as a draft from the example, as an agent would,
// passes valet_check_draft with every case, and then runs for real. A live trial reaches the fake
// through the real egress broker, for the examples a trial can run (public hosts, no credential).
// The rest run as installed, through ToolHost with the real broker, the real credential gate over a
// test grant, and for the raw one the Node runtime with its npm dependency fetched from a fake
// registry (the real tarballs, vendored as fixtures).

import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore, buildRecord } from '@valet/adapter-store'
import {
  type AuditEvent,
  type AuditSink,
  type CredentialGrant,
  type PackageFiles,
  rawEndpoints,
  SecretValue,
} from '@valet/core'
import { EgressBroker, type OpenTunnels } from '@valet/egress'
import {
  type ExampleServices,
  HUB_TOKEN,
  ICLOUD_APP_PASSWORD,
  ICLOUD_USER,
  REDIS_PASSWORD,
  REDIS_USER,
  startExampleServices,
} from '@valet/fake-example-services'
import { DEFAULT_USER, startFakeImap } from '@valet/fake-imap'
import type { ClientIdentity } from '@valet/mcp-server'
import { addDependency, loadDependencies, memoryTarballStore, nodeRuntimeProcess } from '@valet/node-runtime'
import { imapBackend, type ProtocolHostOptions } from '@valet/protocols'
import { writeProtocolHost } from '@valet/protocols/build'
import { type ImapBackend, noBrowserDriver, type SiteGuards, ToolHost } from '@valet/runtime'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { inProcessQuickJS, nodeQuickJS } from '@valet/sandbox'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FakeClock,
  FakePrompt,
  MemoryAudit,
  MemoryJsonStore,
  MemoryMarkers,
} from '../../../../packages/runtime/test/fakes'
import { type AuthoringDeps, DraftAuthoring } from '../../src/main/core/drafts/authoring'
import { EXAMPLES, examplesFrom } from '../../src/main/core/drafts/examples'
import { DraftStore } from '../../src/main/core/drafts/store'
import { PackageManager } from '../../src/main/core/packages'

const AGENT: ClientIdentity = { origin: 'local', clientId: 'claude-code' }
const mac = process.platform === 'darwin'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NPM = join(import.meta.dirname, '..', 'fixtures', 'npm')
const REGISTRY_TLS = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'node-runtime',
  'test',
  'fixtures',
)
const REGISTRY_CA = readFileSync(join(REGISTRY_TLS, 'test-cert.pem'), 'utf8')

/**
 * A fake npm registry serving the real tarballs of redis-parser 3.0.0 and redis-errors 1.2.0
 * (vendored under test/fixtures/npm, their integrity as npm publishes it), with the packuments the
 * resolver reads. Nothing touches the real registry.
 */
async function fakeRegistry(): Promise<{ registry: string; requests: string[]; close(): void }> {
  const tarballs: Record<string, Buffer> = {
    '/redis-parser/-/redis-parser-3.0.0.tgz': readFileSync(join(NPM, 'redis-parser-3.0.0.tgz')),
    '/redis-errors/-/redis-errors-1.2.0.tgz': readFileSync(join(NPM, 'redis-errors-1.2.0.tgz')),
  }
  const requests: string[] = []
  let base = ''
  const doc = (name: string, version: string, dependencies: Record<string, string>, published: string) => {
    const bytes = tarballs[`/${name}/-/${name}-${version}.tgz`] as Buffer
    return {
      name,
      versions: {
        [version]: {
          name,
          version,
          dependencies,
          dist: {
            integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
            tarball: `${base}${name}/-/${name}-${version}.tgz`,
          },
        },
      },
      time: { [version]: published },
    }
  }
  const server: Server = createServer(
    {
      cert: REGISTRY_CA,
      key: readFileSync(join(REGISTRY_TLS, 'test-key.pem'), 'utf8'),
    },
    (req, res) => {
      const path = new URL(req.url ?? '/', 'https://x').pathname
      requests.push(path)
      const tgz = tarballs[path]
      if (tgz !== undefined) return res.end(tgz)
      res.setHeader('content-type', 'application/json')
      if (path === '/redis-parser')
        return res.end(
          JSON.stringify(
            doc('redis-parser', '3.0.0', { 'redis-errors': '^1.0.0' }, '2017-05-28T00:00:00.000Z'),
          ),
        )
      if (path === '/redis-errors')
        return res.end(JSON.stringify(doc('redis-errors', '1.2.0', {}, '2018-02-24T00:00:00.000Z')))
      res.statusCode = 404
      res.end('{}')
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `https://127.0.0.1:${(server.address() as { port: number }).port}/`
  return { registry: base, requests, close: () => server.close() }
}

/** fetch over node:https that trusts the registry's test certificate, as addDependency is handed. */
const registryFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const { request } = await import('node:https')
  return new Promise((resolve, reject) => {
    const req = request(
      input,
      { method: init?.method ?? 'GET', ca: REGISTRY_CA, checkServerIdentity: () => undefined },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 500 })))
      },
    )
    req.on('error', reject)
    req.end()
  })
}) as typeof fetch

let prelude: string
let sandbox: () => ReturnType<ReturnType<typeof inProcessQuickJS>>
let services: ExampleServices
let npm: Awaited<ReturnType<typeof fakeRegistry>>
beforeAll(async () => {
  prelude = await buildToolLibrary()
  const factory = inProcessQuickJS(await nodeQuickJS())
  sandbox = () => factory()
  services = await startExampleServices()
  npm = await fakeRegistry()
}, 60_000)
afterAll(async () => {
  await services.close()
  npm.close()
})

const noTunnels: OpenTunnels = async () => ({
  ports: new Map(),
  close: () => undefined,
  restrict: () => undefined,
})

function rawProcess(endpoints: readonly string[], openTunnels: OpenTunnels) {
  return nodeRuntimeProcess({
    nodeBinary: process.execPath,
    endpoints,
    openTunnels,
    home: homedir(),
    withoutSeatbelt: !mac,
  })
}

const site = () =>
  ({
    budget: { acquire: async () => undefined, spentForMs: () => 0 },
    breaker: {
      isOpen: () => false,
      admit: () => 0,
      recordSuccess: () => undefined,
      trip: () => undefined,
      status: () => ({ retryAfterMs: 0 }),
    },
  }) as unknown as SiteGuards

/** The real broker, its DNS and dialing pointed at the fakes, trusting their certificate. */
export function fakeBroker(endpoints: ConstructorParameters<typeof EgressBroker>[0]): EgressBroker {
  return new EgressBroker(endpoints, {
    lookup: (_name, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
    testing: { allowAddresses: ['127.0.0.1'], route: (a, p) => services.route(a, p), ca: services.cert },
  })
}

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'valet-examples-'))
  dirs.push(dir)
  const rawStart = rawProcess([], noTunnels)
  const tarballs = memoryTarballStore()
  const packages = new PackageManager({
    store: new AdapterStore(join(dir, 'adapters')),
    runtime: {
      prelude,
      start: sandbox,
      raw: { dependencies: (lock) => loadDependencies(lock, tarballs), start: rawStart },
    },
    build: buildRecord('0.1.0', prelude),
    audit: { append: async () => undefined } as unknown as AuditSink,
    now: () => new Date(),
    keep: async () => new Set(),
  })
  const trials: AuthoringDeps['trials'] = {
    start: sandbox,
    driver: async () => {
      throw new Error('an example opens no browser')
    },
    guards: () => site(),
    signedIn: async () => new Map(),
    egress: ({ egress }) => fakeBroker({ egress }),
    raw: {
      start: (manifest, openTunnels) => rawProcess(rawEndpoints(manifest), openTunnels),
      tunnels: (endpoints) => {
        const broker = fakeBroker({ egress: [], endpoints })
        return (run, options) => broker.tunnels(run, options)
      },
    },
  }
  const store = new DraftStore(join(dir, 'drafts'))
  const authoring = new DraftAuthoring({
    store,
    prepare: async (files) => (await packages.prepare(files, 'draft')).loaded,
    caseProcess: sandbox,
    rawCaseProcess: rawStart,
    installed: async () => null,
    approved: async () => null,
    sites: () => [],
    permissionLines: () => [],
    submit: async () => ({ ok: false, sentence: 'unused' }),
    withdraw: async () => undefined,
    requestState: () => ({ state: 'unknown', note: null }),
    clientName: () => 'Claude Code',
    audit: async () => undefined,
    notify: () => undefined,
    now: () => Date.now(),
    trials,
    dependencies: {
      add: (lock, name, range) =>
        addDependency(lock, name, range, tarballs, { registry: npm.registry, fetch: registryFetch }),
    },
  })
  return { authoring, packages, store }
}

async function fromExample(example: string, adapterId = `my-${example}`) {
  const h = await harness()
  const { draft } = await h.authoring.createDraft(AGENT, { adapterId, from: 'example', example })
  const read = async (path: string) => (await h.authoring.readFile(AGENT, false, draft.draftId, path)).content
  const write = (path: string, text: string) => h.authoring.writeFile(AGENT, draft.draftId, path, text)
  return { ...h, draftId: draft.draftId, read, write }
}

/** Every case passes and nothing is an error: what valet_submit_draft needs. */
async function expectPasses(h: Awaited<ReturnType<typeof fromExample>>) {
  const report = await h.authoring.check(AGENT, h.draftId)
  expect(report.cases.filter((c) => !c.passed)).toEqual([])
  expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
  expect(report.cases.length).toBeGreaterThan(0)
  expect(report.ok).toBe(true)
  return report
}

/** The fakes' certificate's SHA-256, as a manifest pins a private host's. */
const pinOf = (pem: string) => createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')

/** What each grant resolves, by field: the fakes' own accounts. */
type Grants = Record<string, { kind: CredentialGrant['kind']; fields: Record<string, string> }>

/**
 * An example as installed: its files (changed by `edit`) checked, compiled and registered with a
 * ToolHost whose ctx.http is the real broker to the fakes, whose credentials come through the real
 * gate from test grants, and whose raw code runs in the Node runtime through the broker's tunnels.
 */
async function installed(
  example: string,
  grants: Grants,
  edit: (files: PackageFiles) => PackageFiles = (f) => f,
  dependencies: readonly { name: string; range: string }[] = [],
  imap?: ImapBackend,
) {
  const h = await fromExample(example)
  for (const d of dependencies) await h.authoring.addDependency(AGENT, h.draftId, d)
  for (const [path, text] of Object.entries(edit({ ...(await draftFiles(h)) }))) await h.write(path, text)
  const files = await draftFiles(h)
  const loaded = (await h.packages.prepare(files, 'draft')).loaded
  const manifest = loaded.manifest
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const prompt = new FakePrompt()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === manifest.id && hash === loaded.adapterHash },
    audit,
    prompt,
    authRunner: vi.fn(async () => ({ status: 'ok' as const })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    pacingSleep: clock.pacingSleep,
  })
  const broker = fakeBroker({
    egress: manifest.egress,
    privateHosts: manifest.privateHosts ?? [],
    endpoints: rawEndpoints(manifest),
  })
  const resolved: SecretValue[] = []
  host.register({
    definition: loaded.definition,
    bundleHash: loaded.adapterHash,
    driver: noBrowserDriver(),
    ...(imap === undefined ? {} : { imap }),
    ...(manifest.runtime === 'raw'
      ? {
          raw: {
            script: loaded.script,
            start: (openTunnels: OpenTunnels) => rawProcess(rawEndpoints(manifest), openTunnels),
            tunnels: (run, options) => broker.tunnels(run, options),
          },
        }
      : { http: broker, isolation: { script: loaded.script, start: sandbox } }),
    credentialGrants: {
      findGrant: async (credential) => {
        const declared = manifest.credentials?.[credential]
        const given = grants[credential]
        if (declared === undefined || given === undefined) return null
        return {
          adapterId: manifest.id,
          adapterHash: loaded.adapterHash,
          credential,
          kind: given.kind,
          custody: declared.custody,
          provider: 'keychain-copy',
          itemRef: `test:${credential}`,
          targets:
            'header' in declared.use
              ? [...declared.use.hosts]
              : 'protocol' in declared.use
                ? [declared.use.endpoint]
                : 'entrusted' in declared.use
                  ? [...declared.use.entrusted.endpoints]
                  : [],
          grantedAt: '2026-11-17T00:00:00.000Z',
        }
      },
      resolve: async (grant, field) => {
        const value = grants[grant.credential]?.fields[field]
        if (value === undefined) throw new Error(`no ${field}`)
        const secret = SecretValue.fromString(value)
        resolved.push(secret)
        return secret
      },
    },
  })
  let n = 0
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    host.call({ adapterId: manifest.id, tool, input, client: 'claude-code', callId: `c-${++n}` })
  return { call, audit, prompt, manifest }
}

async function draftFiles(h: Awaited<ReturnType<typeof fromExample>>): Promise<PackageFiles> {
  return h.store.files(h.draftId)
}

const used = (events: readonly AuditEvent[]) => events.filter((e) => e.type === 'secret-used')

describe('the examples', () => {
  it('are embedded, each with its cases', () => {
    expect([...EXAMPLES.keys()]).toEqual([
      'cache-reader',
      'feed-reader',
      'hacker-news',
      'home-hub',
      'icloud-calendar',
      'icloud-contacts',
      'icloud-mail-read',
    ])
    for (const example of EXAMPLES.values()) {
      expect(example.files['manifest.json']).toBeDefined()
      expect(example.files['src/tools.ts']).toBeDefined()
      expect(example.description.length).toBeGreaterThan(20)
      expect(example.files['README.md']).toContain('valet_create_draft')
    }
  })

  it('leaves out a package without cases, and one whose manifest isn’t JSON', () => {
    const found = examplesFrom({
      '/x/examples/plain/manifest.json': '{"description":"d"}',
      '/x/examples/plain/src/tools.ts': '',
      '/x/examples/broken/manifest.json': '{',
      '/x/examples/broken/test/a.json': '{}',
      '/x/examples/good/manifest.json': '{"description":"An example","runtime":"http"}',
      '/x/examples/good/test/a.json': '{}',
      '/x/elsewhere/manifest.json': '{}',
    })
    expect([...found.keys()]).toEqual(['good'])
    expect(found.get('good')).toMatchObject({ description: 'An example', runtime: 'http' })
  })

  it('refuses an example that does not exist, naming the ones that do', async () => {
    const h = await harness()
    await expect(
      h.authoring.createDraft(AGENT, { adapterId: 'x', from: 'example', example: 'nope' }),
    ).rejects.toThrow(/No example "nope"\. The examples are: .*hacker-news/)
  })

  it('takes the draft’s own id and name', async () => {
    const h = await harness()
    const { draft } = await h.authoring.createDraft(AGENT, {
      adapterId: 'hn',
      from: 'example',
      example: 'hacker-news',
      name: 'HN',
    })
    const manifest = JSON.parse(
      (await h.authoring.readFile(AGENT, false, draft.draftId, 'manifest.json')).content,
    )
    expect(manifest).toMatchObject({ id: 'hn', name: 'HN', runtime: 'http' })
  })
})

describe('Hacker News (http)', () => {
  it('passes its check and every case', async () => {
    await expectPasses(await fromExample('hacker-news'))
  }, 60_000)

  it('reads the fake API in a live trial, through the broker', async () => {
    const h = await fromExample('hacker-news')
    const before = services.seen.length
    const report = await h.authoring.liveTrial(AGENT, h.draftId, 'list_stories', { list: 'top', limit: 4 })
    expect(report).toMatchObject({ ok: true })
    const stories = (report as { output: { fromSite: { stories: { id: number }[] } } }).output.fromSite
      .stories
    expect(stories.map((s) => s.id)).toEqual([41001, 41002, 41003])
    const seen = services.seen.slice(before)
    expect(seen.map((s) => s.url)).toEqual([
      '/v0/topstories.json',
      '/v0/item/41001.json',
      '/v0/item/41002.json',
      '/v0/item/41003.json',
      '/v0/item/41004.json',
    ])
    expect(seen.every((s) => s.host === 'hacker-news.firebaseio.com' && s.servername === s.host)).toBe(true)
    const story = await h.authoring.liveTrial(AGENT, h.draftId, 'get_story', { id: 41001 })
    expect(story).toMatchObject({
      ok: true,
      output: { fromSite: { comments: [{ by: 'alice', text: expect.stringContaining('CalDAV') }] } },
    })
  }, 60_000)
})

describe('the feed reader (http, RSS and Atom)', () => {
  it('passes its check and every case', async () => {
    await expectPasses(await fromExample('feed-reader'))
  }, 60_000)

  it('reads RSS from one host and Atom from another in live trials', async () => {
    const h = await fromExample('feed-reader')
    const news = await h.authoring.liveTrial(AGENT, h.draftId, 'get_headlines', { section: 'technology' })
    expect(news).toMatchObject({
      ok: true,
      output: { fromSite: { headlines: [{ title: 'New phone has a bigger screen' }] } },
    })
    const releases = await h.authoring.liveTrial(AGENT, h.draftId, 'list_releases', {
      owner: 'nodejs',
      repo: 'node',
    })
    expect(releases).toMatchObject({
      ok: true,
      output: {
        fromSite: { releases: [{ tag: 'v24.11.1', summary: 'Security release.' }, { tag: 'v24.11.0' }] },
      },
    })
    // A section the manifest's paths don't cover is refused before anything is sent.
    const before = services.seen.length
    await h.write(
      'src/tools.ts',
      (await h.read('src/tools.ts')).replace("'/news/world/rss.xml'", "'/sport/rss.xml'"),
    )
    const refused = await h.authoring.liveTrial(AGENT, h.draftId, 'get_headlines', { section: 'world' })
    expect(refused).toMatchObject({ ok: false })
    expect(JSON.stringify(refused)).toContain('undeclared-request')
    expect(services.seen.length).toBe(before)
  }, 60_000)
})

describe('iCloud Calendar (http, CalDAV, a kept password)', () => {
  it('passes its check and every case, the cases with a placeholder for the kept credential', async () => {
    await expectPasses(await fromExample('icloud-calendar'))
  }, 60_000)

  it('gets no credential in a live trial, so nothing reaches iCloud', async () => {
    const h = await fromExample('icloud-calendar')
    const before = services.seen.length
    const report = await h.authoring.liveTrial(AGENT, h.draftId, 'list_calendars', {})
    expect(report).toMatchObject({ ok: false })
    expect(JSON.stringify(report)).toContain('not-granted')
    expect(services.seen.length).toBe(before)
  }, 60_000)
})

describe('iCloud Contacts (http, CardDAV, a kept password)', () => {
  it('passes its check and every case', async () => {
    await expectPasses(await fromExample('icloud-contacts'))
  }, 60_000)
})

describe('the home hub (http, a pinned private host, a WebSocket and a kept token)', () => {
  it('passes its check and every case, the socket scripted by its cases', async () => {
    await expectPasses(await fromExample('home-hub'))
  }, 60_000)

  it('never reaches the hub in a live trial', async () => {
    const h = await fromExample('home-hub')
    const before = services.seen.length
    const report = await h.authoring.liveTrial(AGENT, h.draftId, 'list_devices', {})
    expect(report).toMatchObject({ ok: false })
    expect(services.seen.length).toBe(before)
  }, 60_000)
})

const ICLOUD: Grants = {
  icloud: { kind: 'password', fields: { username: ICLOUD_USER, password: ICLOUD_APP_PASSWORD } },
}

describe('the http examples as installed, with their credentials', () => {
  it('iCloud Calendar: lists calendars, reads a week and adds an event once, the password added by Valet', async () => {
    const before = services.seen.length
    const { call, audit } = await installed('icloud-calendar', ICLOUD)
    expect(await call('list_calendars')).toMatchObject({
      status: 'ok',
      output: {
        server: 'p01-caldav.icloud.com',
        reachable: true,
        calendars: [
          { id: 'home', name: 'Home', color: '#34AADC' },
          { id: 'work', name: 'Work', color: '#FF2968' },
        ],
      },
    })
    const week = await call('list_events', { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' })
    expect(week).toMatchObject({ status: 'ok' })
    const titles = (week as { output: { events: { title: string }[] } }).output.events.map((e) => e.title)
    expect(titles).toEqual(['Dentist', 'Stand-up', 'Dinner, with friends'])
    const event = {
      calendar: 'home',
      title: 'Lunch, then a walk; with Sam',
      start: '2026-11-21T01:00:00Z',
      end: '2026-11-21T02:00:00Z',
      location: 'The botanic gardens, by the long pond near the café',
    }
    expect(await call('add_event', event)).toMatchObject({ status: 'ok', output: { created: true } })
    expect(services.calendars[0]?.events.at(-1)).toMatchObject({
      summary: 'Lunch, then a walk; with Sam',
      start: '20261121T010000Z',
      location: 'The botanic gardens, by the long pond near the café',
    })
    expect(await call('add_event', event)).toMatchObject({ status: 'ok', output: { created: false } })
    expect(services.calendars[0]?.events.filter((e) => e.summary.startsWith('Lunch'))).toHaveLength(1)
    // Every request carried the Basic header Valet built, and the value never reached the audit.
    const seen = services.seen.slice(before)
    const basic = `Basic ${Buffer.from(`${ICLOUD_USER}:${ICLOUD_APP_PASSWORD}`).toString('base64')}`
    expect(seen.length).toBeGreaterThan(5)
    expect(seen.every((r) => r.headers['authorization'] === basic)).toBe(true)
    expect(used(audit.events).length).toBe(seen.length)
    expect(JSON.stringify(audit.events)).not.toContain(ICLOUD_APP_PASSWORD)
    expect(JSON.stringify(audit.events)).not.toContain(basic.slice(6))
  }, 60_000)

  it('iCloud Calendar: an account on another server gets that server’s name, and nothing is sent there', async () => {
    const { call } = await installed('icloud-calendar', ICLOUD, (files) => ({
      ...files,
      // This version knows a different server from the one the account is on.
      'src/tools.ts': (files['src/tools.ts'] ?? '').replace(
        "['p01-caldav.icloud.com']",
        "['p02-caldav.icloud.com']",
      ),
    }))
    expect(await call('list_calendars')).toMatchObject({
      status: 'ok',
      output: { server: 'p01-caldav.icloud.com', reachable: false, calendars: [] },
    })
    expect(
      await call('list_events', { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' }),
    ).toMatchObject({
      status: 'failed',
      errorClass: 'host-not-allowed',
    })
  }, 60_000)

  it('iCloud Contacts: finds people by name', async () => {
    const { call } = await installed('icloud-contacts', ICLOUD)
    expect(await call('find_contacts', { name: 'sam' })).toMatchObject({
      status: 'ok',
      output: {
        contacts: [
          { name: 'Sam Lee', emails: ['sam@example.org'], organisation: 'Example Pty Ltd' },
          { name: 'Samira Khan', emails: ['samira@example.net', 'sk@example.org'] },
        ],
      },
    })
  }, 60_000)

  it('iCloud Contacts: a wrong app-specific password fails as auth-failed', async () => {
    const { call } = await installed('icloud-contacts', {
      icloud: { kind: 'password', fields: { username: ICLOUD_USER, password: 'wrong-wrong-wrong-wrong' } },
    })
    expect(await call('find_contacts', { name: 'sam' })).toMatchObject({
      status: 'failed',
      errorClass: 'auth-failed',
    })
  }, 60_000)

  it('the home hub: reads over REST and switches a light over the pinned WebSocket, with the kept token', async () => {
    const pin = (files: PackageFiles) => ({
      ...files,
      'manifest.json': (files['manifest.json'] ?? '').replace('0'.repeat(64), pinOf(services.cert)),
    })
    const hub = { hub: { kind: 'token' as const, fields: { token: HUB_TOKEN } } }
    const { call, audit } = await installed('home-hub', hub, pin)
    const listed = await call('list_devices', { kind: 'light' })
    expect(listed).toMatchObject({
      status: 'ok',
      output: { devices: [{ id: 'light.kitchen' }, { id: 'light.porch' }] },
    })
    const kitchen = services.entities.find((e) => e.entity_id === 'light.kitchen')
    const was = kitchen?.state
    expect(await call('switch_light', { light: 'light.kitchen', on: was !== 'on' })).toMatchObject({
      status: 'ok',
      output: { light: 'light.kitchen', state: was === 'on' ? 'off' : 'on' },
    })
    expect(services.hubMessages.at(-2)).toContain('call_service')
    expect(JSON.stringify(audit.events)).not.toContain(HUB_TOKEN)
    // A hub that shows another certificate is refused before the token goes anywhere.
    const before = services.seen.length
    const wrongPin = await installed('home-hub', hub, (files) => ({
      ...files,
      'manifest.json': (files['manifest.json'] ?? '').replace('0'.repeat(64), 'a'.repeat(64)),
    }))
    expect(await wrongPin.call('list_devices')).toMatchObject({ status: 'failed' })
    expect(services.seen.length).toBe(before)
  }, 60_000)
})

describe('the cache reader (raw, an npm dependency, an entrusted password)', () => {
  const withCa = (files: PackageFiles) => ({
    ...files,
    'src/tools.ts': (files['src/tools.ts'] ?? '').replace(
      'export const TLS_OPTIONS: Record<string, unknown> = {}',
      `export const TLS_OPTIONS: Record<string, unknown> = { ca: ${JSON.stringify(services.cert)} }`,
    ),
  })

  it('needs its npm package, added with valet_add_dependency from the registry, and then passes', async () => {
    const h = await fromExample('cache-reader')
    const first = await h.authoring.check(AGENT, h.draftId)
    expect(first.ok).toBe(false)
    expect(JSON.stringify(first.findings)).toContain('redis-parser')
    const added = await h.authoring.addDependency(AGENT, h.draftId, { name: 'redis-parser', range: '3.0.0' })
    expect(added).toMatchObject({ name: 'redis-parser', packages: 2 })
    const lock = JSON.parse(await h.read('valet-lock.json'))
    expect(Object.keys(lock.packages).sort()).toEqual(['redis-errors@1.2.0', 'redis-parser@3.0.0'])
    expect(npm.requests).toEqual(
      expect.arrayContaining(['/redis-parser', '/redis-errors', '/redis-parser/-/redis-parser-3.0.0.tgz']),
    )
    await expectPasses(h)
    // A trial is never entrusted with a credential, so nothing signs in to the cache.
    const before = services.redisCommands.length
    const trial = await h.authoring.liveTrial(AGENT, h.draftId, 'get_key', { key: 'weather:sydney' })
    expect(trial).toMatchObject({ ok: false })
    expect(JSON.stringify(trial)).toContain('not-granted')
    expect(services.redisCommands.length).toBe(before)
  }, 120_000)

  it('reads the cache as installed, signing in with the entrusted password over its own TLS', async () => {
    const cache = {
      cache: { kind: 'password' as const, fields: { username: REDIS_USER, password: REDIS_PASSWORD } },
    }
    const { call, audit } = await installed('cache-reader', cache, withCa, [
      { name: 'redis-parser', range: '3.0.0' },
    ])
    const before = services.redisCommands.length
    expect(await call('get_key', { key: 'weather:sydney' })).toEqual({
      status: 'ok',
      output: { key: 'weather:sydney', value: '{"tempC":24,"sky":"sunny"}' },
    })
    expect(await call('get_key', { key: 'secret:admin' })).toMatchObject({
      status: 'failed',
      errorClass: 'not-granted',
    })
    expect(await call('scan_keys', { pattern: 'weather:*' })).toMatchObject({
      status: 'ok',
      output: { keys: ['weather:hobart', 'weather:sydney'], complete: true },
    })
    expect(services.redisCommands.slice(before)).toEqual([
      ['AUTH', REDIS_USER, '***'],
      ['GET', 'weather:sydney'],
      ['AUTH', REDIS_USER, '***'],
      ['GET', 'secret:admin'],
      ['AUTH', REDIS_USER, '***'],
      ['SCAN', '0', 'MATCH', 'weather:*', 'COUNT', '1000'],
    ])
    expect(services.redisServernames.at(-1)).toBe('cache.example.com')
    expect(used(audit.events)).toHaveLength(3)
    expect(JSON.stringify(audit.events)).not.toContain(REDIS_PASSWORD)
  }, 120_000)
})

/** An iCloud-like message for the fake IMAP server. */
const mail = (from: string, subject: string, day: number) => ({
  raw: [
    `From: ${from}`,
    'To: nick@icloud.test',
    `Subject: ${subject}`,
    `Date: ${day} Nov 2026 08:00:00 +0000`,
    `Message-ID: <m${day}@example.test>`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The body, which no tool reads.',
    '',
  ].join('\r\n'),
  internalDate: new Date(Date.UTC(2026, 10, day, 8)),
})

describe('iCloud Mail, read only (protocol, IMAP, a kept password)', () => {
  it('passes its check and every case, ctx.imap answered by the cases’ scripts', async () => {
    await expectPasses(await fromExample('icloud-mail-read'))
  })

  it('a case whose script the tool doesn’t follow fails, and a write from a read tool is refused', async () => {
    const h = await fromExample('icloud-mail-read')
    const cases = JSON.parse(await h.read('test/inbox.json')) as { cases: Record<string, unknown>[] }
    const first = cases.cases[0] as Record<string, unknown>
    // The tool makes status, not search: the script doesn't match.
    await h.write(
      'test/inbox.json',
      JSON.stringify({ cases: [{ ...first, imap: [{ op: 'search', answer: { uids: [] } }] }] }),
    )
    const wrong = await h.authoring.check(AGENT, h.draftId)
    expect(wrong.ok).toBe(false)
    expect(wrong.cases[0]?.reason).toContain('IMAP step 1 is search')
    // Tool code that tries to mark mail read from a read tool: refused before the script is asked.
    const tools = await h.read('src/tools.ts')
    await h.write(
      'src/tools.ts',
      tools.replace(
        'const status = await imap(ctx).status(INBOX)',
        "await imap(ctx).setFlags(INBOX, [1], { add: ['\\\\Seen'] })\n      const status = await imap(ctx).status(INBOX)",
      ),
    )
    await h.write(
      'test/inbox.json',
      JSON.stringify({
        cases: [
          { ...first, expect: { error: { stage: 'request-surface', errorClass: 'command-not-allowed' } } },
        ],
      }),
    )
    const refused = await h.authoring.check(AGENT, h.draftId)
    expect(refused.cases.filter((c) => !c.passed)).toEqual([])
  })

  it('as installed: reads the inbox through the real protocol host, signs in itself and changes nothing', async () => {
    const server = await startFakeImap({
      mailboxes: {
        INBOX: [
          mail('Shop <receipts@shop.example>', 'Your receipt', 15),
          mail('Ann <ann@example.com>', 'Lunch tomorrow?', 16),
          mail('Bank <alerts@bank.example>', 'Statement ready', 17),
        ],
        Private: [mail('Someone <x@example.com>', 'Not for this adapter', 17)],
      },
    })
    const home = mkdtempSync(join(tmpdir(), 'ex-mail-home-'))
    const hostDir = mkdtempSync(join(tmpdir(), 'ex-mail-host-'))
    dirs.push(home, hostDir)
    try {
      const host = {
        nodeBinary: process.execPath,
        hostScript: await writeProtocolHost(join(hostDir, 'protocol-host.cjs')),
        home,
        withoutSeatbelt: !mac,
        testCa: server.cert ?? undefined,
        operationTimeoutMs: 10_000,
      } as ProtocolHostOptions
      const broker = {
        lookup: (_n: string, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
          cb(null, [{ address: '127.0.0.1', family: 4 }]),
        testing: {
          allowAddresses: ['127.0.0.1'],
          route: () => ({ address: '127.0.0.1', port: server.port }),
        },
      }
      const { call, audit } = await installed(
        'icloud-mail-read',
        {
          mail: {
            kind: 'password',
            fields: { username: DEFAULT_USER.username, password: DEFAULT_USER.password },
          },
        },
        (f) => f,
        [],
        imapBackend({
          protocol: { endpoint: 'imap.mail.me.com:993', credential: 'mail', folders: ['INBOX'] },
          host,
          broker,
        }),
      )
      const overview = await call('inbox_overview')
      expect(overview).toMatchObject({ status: 'ok', output: { messages: 3, unread: 3 } })
      const recent = await call('recent_mail', { count: 2 })
      expect(recent).toMatchObject({
        status: 'ok',
        output: {
          total: 3,
          messages: [
            { from: 'alerts@bank.example', subject: 'Statement ready', read: false },
            { from: 'ann@example.com', subject: 'Lunch tomorrow?', read: false },
          ],
        },
      })
      // Nothing changed on the server: no flag set, INBOX only ever examined, no body fetched.
      for (const m of server.mailboxes.get('INBOX')?.messages ?? []) expect([...m.flags]).toEqual([])
      const verbs = server.commands.map((c) => c.verb)
      expect(verbs).toContain('EXAMINE')
      for (const v of [
        'SELECT',
        'STORE',
        'UID STORE',
        'APPEND',
        'COPY',
        'UID COPY',
        'MOVE',
        'UID MOVE',
        'EXPUNGE',
        'UID EXPUNGE',
      ])
        expect(verbs).not.toContain(v)
      expect(server.commands.some((c) => /BODY\[\]|RFC822(?!\.SIZE)|BODY\[TEXT\]/i.test(c.line))).toBe(false)
      expect(server.commands.some((c) => c.line.includes('Private'))).toBe(false)
      // Signed in by Valet with the kept password, which no output or audit target carries.
      expect(server.logins).toEqual([
        { username: DEFAULT_USER.username, ok: true },
        { username: DEFAULT_USER.username, ok: true },
      ])
      expect(JSON.stringify([overview, recent, audit.events])).not.toContain(DEFAULT_USER.password)
      expect(used(audit.events).length).toBe(2)
    } finally {
      await server.close()
    }
  })
})
