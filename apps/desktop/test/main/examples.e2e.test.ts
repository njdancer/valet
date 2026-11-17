// @vitest-environment node
// The worked examples (docs/adapter-kinds.md#h-example-adapters), end to end against fakes only
// (@valet/fake-example-services): each one starts as a draft from the example, as an agent would,
// passes valet_check_draft with every case, and then runs for real. A live trial reaches the fake
// through the real egress broker, for the examples a trial can run (public hosts, no credential).
// The rest run as installed, through ToolHost with the real broker, the real credential gate over a
// test grant, and for the raw one the Node runtime with its npm dependency fetched from a fake
// registry (the real tarballs, vendored as fixtures).

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore, buildRecord } from '@valet/adapter-store'
import { type AuditSink, rawEndpoints } from '@valet/core'
import { EgressBroker, type OpenTunnels } from '@valet/egress'
import { type ExampleServices, startExampleServices } from '@valet/fake-example-services'
import type { ClientIdentity } from '@valet/mcp-server'
import { loadDependencies, memoryTarballStore, nodeRuntimeProcess } from '@valet/node-runtime'
import type { SiteGuards } from '@valet/runtime'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { inProcessQuickJS, nodeQuickJS } from '@valet/sandbox'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type AuthoringDeps, DraftAuthoring } from '../../src/main/core/drafts/authoring'
import { EXAMPLES } from '../../src/main/core/drafts/examples'
import { DraftStore } from '../../src/main/core/drafts/store'
import { PackageManager } from '../../src/main/core/packages'

const AGENT: ClientIdentity = { origin: 'local', clientId: 'claude-code' }
const mac = process.platform === 'darwin'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let prelude: string
let sandbox: () => ReturnType<ReturnType<typeof inProcessQuickJS>>
let services: ExampleServices
beforeAll(async () => {
  prelude = await buildToolLibrary()
  const factory = inProcessQuickJS(await nodeQuickJS())
  sandbox = () => factory()
  services = await startExampleServices()
}, 60_000)
afterAll(async () => {
  await services.close()
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
  const packages = new PackageManager({
    store: new AdapterStore(join(dir, 'adapters')),
    runtime: {
      prelude,
      start: sandbox,
      raw: { dependencies: (lock) => loadDependencies(lock, memoryTarballStore()), start: rawStart },
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
  const authoring = new DraftAuthoring({
    store: new DraftStore(join(dir, 'drafts')),
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
  })
  return { authoring, packages }
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

describe('the examples', () => {
  it('are embedded, one per kind', () => {
    expect([...EXAMPLES.keys()]).toEqual(expect.arrayContaining(['hacker-news', 'local-portfolio']))
    for (const example of EXAMPLES.values()) {
      expect(example.files['manifest.json']).toBeDefined()
      expect(example.files['src/tools.ts']).toBeDefined()
      expect(example.description.length).toBeGreaterThan(20)
    }
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
