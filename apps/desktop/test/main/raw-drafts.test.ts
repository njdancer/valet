// @vitest-environment node
// Raw drafts in the authoring tools (docs/adapter-kinds.md#raw): the blank raw draft builds for
// Node, is described in the Node runtime and passes its case with no network; a raw case can't
// name pages or responses; a live trial reaches the draft's public endpoints through the broker's
// tunnels, with a read's upload budget and no credential, and never its private hosts.

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore, buildRecord } from '@valet/adapter-store'
import { type AuditSink, rawEndpoints } from '@valet/core'
import { EgressBroker, type OpenTunnels } from '@valet/egress'
import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import type { ClientIdentity } from '@valet/mcp-server'
import { loadDependencies, memoryTarballStore, nodeRuntimeProcess } from '@valet/node-runtime'
import type { SiteGuards } from '@valet/runtime'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { inProcessQuickJS, nodeQuickJS } from '@valet/sandbox'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type AuthoringDeps, DraftAuthoring } from '../../src/main/core/drafts/authoring'
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
let api: FakeApi
beforeAll(async () => {
  prelude = await buildToolLibrary()
  const factory = inProcessQuickJS(await nodeQuickJS())
  sandbox = () => factory()
  api = await startFakeApi()
}, 60_000)
afterAll(async () => {
  await api.close()
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

const site = (acquired: number[]) =>
  ({
    budget: { acquire: async () => void acquired.push(1), spentForMs: () => 0 },
    breaker: {
      isOpen: () => false,
      admit: () => 0,
      recordSuccess: () => undefined,
      trip: () => undefined,
      status: () => ({ retryAfterMs: 0 }),
    },
  }) as unknown as SiteGuards

async function harness(withTrials = false) {
  const dir = mkdtempSync(join(tmpdir(), 'valet-raw-drafts-'))
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
  const acquired: number[] = []
  const brokers: string[][] = []
  const trials: AuthoringDeps['trials'] = {
    start: sandbox,
    driver: async () => {
      throw new Error('a raw trial opens no browser')
    },
    guards: () => site(acquired),
    signedIn: async () => new Map(),
    raw: {
      start: (manifest, openTunnels) => rawProcess(rawEndpoints(manifest), openTunnels),
      tunnels: (endpoints) => {
        brokers.push([...endpoints])
        const broker = new EgressBroker(
          { egress: [], endpoints },
          {
            lookup: (_name, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
            testing: {
              allowAddresses: ['127.0.0.1'],
              route: () => ({ address: '127.0.0.1', port: api.port }),
            },
          },
        )
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
    ...(withTrials ? { trials } : {}),
  })
  const { draft } = await authoring.createDraft(AGENT, {
    adapterId: 'status',
    from: 'blank',
    name: 'Status',
    runtime: 'raw',
  })
  const read = async (path: string) => (await authoring.readFile(AGENT, false, draft.draftId, path)).content
  const write = (path: string, text: string) => authoring.writeFile(AGENT, draft.draftId, path, text)
  return { authoring, draftId: draft.draftId, read, write, acquired, brokers }
}

/** The blank draft's code, pointed at the fake API and trusting its certificate. */
async function pointAtFake(h: Awaited<ReturnType<typeof harness>>, extra = '') {
  const manifest = JSON.parse(await h.read('manifest.json'))
  manifest.endpoints = ['api.example.test:443']
  await h.write('manifest.json', JSON.stringify(manifest))
  const tools = (await h.read('src/tools.ts'))
    .replace("host: 'api.example.com'", `host: 'api.example.test', ca: ${JSON.stringify(api.cert)}`)
    .replace("get('/status')", "get('/v1/items')")
  await h.write('src/tools.ts', `${tools}\n${extra}`)
}

describe('raw drafts', () => {
  it('passes the blank raw draft: built for Node, described in the Node runtime, its case run with no network', async () => {
    const h = await harness()
    const manifest = JSON.parse(await h.read('manifest.json'))
    expect(manifest.runtime).toBe('raw')
    expect(manifest.endpoints).toEqual(['api.example.com:443'])
    const report = await h.authoring.check(AGENT, h.draftId)
    expect(report.findings.filter((f) => f.level === 'error')).toEqual([])
    expect(report.cases.map((c) => c.passed)).toEqual([true])
    expect(report.ok).toBe(true)
  }, 60_000)

  it('fails a case that names responses, and one whose code reaches for the network', async () => {
    const h = await harness()
    const cases = {
      cases: [
        {
          name: 'with a response',
          tool: 'get_status',
          input: {},
          fetch: [
            { method: 'GET', url: 'https://api.example.com/status', status: 200, body: { inline: 'ok' } },
          ],
          expect: { output: { status: 'ok' } },
        },
        { name: 'over the network', tool: 'get_status', input: {}, expect: { output: { status: 'ok' } } },
      ],
    }
    await h.write('test/example.json', JSON.stringify(cases))
    const report = await h.authoring.check(AGENT, h.draftId)
    expect(report.cases[0]).toMatchObject({
      passed: false,
      reason: expect.stringContaining('has no network'),
    })
    expect(report.cases[1]).toMatchObject({ passed: false })
  }, 60_000)

  it('runs a live trial through the broker’s tunnel to its public endpoint, paced, with no browser', async () => {
    const h = await harness(true)
    await pointAtFake(h)
    const before = api.seen.length
    const report = await h.authoring.liveTrial(AGENT, h.draftId, 'get_status', {})
    expect(report).toMatchObject({
      ok: true,
      output: { fromSite: { status: expect.stringContaining('First item') } },
    })
    expect(api.seen.slice(before)).toEqual([
      expect.objectContaining({ url: '/v1/items', servername: 'api.example.test' }),
    ])
    expect(h.acquired.length).toBeGreaterThan(0)
    expect(h.brokers).toEqual([['api.example.test:443']])
  }, 60_000)

  it('never reaches a private host in a trial, nor gives a credential', async () => {
    const h = await harness(true)
    await pointAtFake(h)
    const manifest = JSON.parse(await h.read('manifest.json'))
    manifest.privateHosts = [{ address: '192.168.1.20', port: 8123 }]
    manifest.credentials = {
      api: {
        description: 'The API token',
        kind: 'token',
        custody: 'entrusted',
        use: { entrusted: { endpoints: ['api.example.test:443'] } },
      },
    }
    await h.write('manifest.json', JSON.stringify(manifest))
    const tools = (await h.read('src/tools.ts')).replace(
      'async run(_ctx, input) {',
      'async run(ctx, input) {\n      if (input.answer === "secret") return { status: (await ctx.secrets.get("api")).value }',
    )
    await h.write('src/tools.ts', tools)
    const secret = await h.authoring.liveTrial(AGENT, h.draftId, 'get_status', { answer: 'secret' })
    expect(secret).toMatchObject({ ok: false })
    expect(JSON.stringify(secret)).toContain('not-granted')
    // The trial's tunnels were for the public endpoint alone.
    expect(h.brokers.every((b) => b.join() === 'api.example.test:443')).toBe(true)
  }, 60_000)

  it('fails a trial that sends past a read’s upload budget', async () => {
    const h = await harness(true)
    await pointAtFake(h)
    const tools = (await h.read('src/tools.ts'))
      .replace('https.get({', "https.request({ method: 'POST',")
      .replace(
        "request.on('error', reject)",
        "request.on('error', reject)\n    request.end('x'.repeat(200_000))",
      )
    await h.write('src/tools.ts', tools)
    const before = api.seen.length
    const report = await h.authoring.liveTrial(AGENT, h.draftId, 'get_status', {})
    expect(report).toMatchObject({ ok: false })
    expect(JSON.stringify(report)).toContain('upload-budget')
    expect(api.seen.slice(before).some((s) => s.body.length >= 200_000)).toBe(false)
  }, 60_000)
})
