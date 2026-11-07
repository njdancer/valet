// The egress canary. The fake's exfil sink listens behind evil.test, which an e2e launch maps to
// 127.0.0.1 like the demo's own hosts (src/main/core/launch.ts, demoResolverRules), so anything the
// app let out to it would arrive rather than fail to resolve. In front of the sink is a TCP door that
// counts every connection and passes it on: an https attempt (the sink speaks plain HTTP, so no
// request would parse and the sink would record nothing) still counts as having got out.
//
// Then the hostile variant: the fake's own www pages turn hostile, as a compromised site's script
// would (the fake's page beacon, turned on through the demo's e2e hook), and beacon the page's cookies
// to evil.test every 200 ms by every route a page has (beacon, fetch over http and https, image,
// WebSocket). It is the site's own inline script, in the page's main world. Every attempt must be
// blocked, none may reach the sink, and each must be audited as request-blocked with initiator page
// and partition tool, the origin only (never the query) as target: the ones made during a tool's run
// with its call id (the runtime's), the ones between runs with none (the app's). The script counts its
// rounds on <html>, so the test knows it really ran before it looks for leaks.

import { readFileSync, rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { BEACON_ROUNDS_ATTRIBUTE, type ExfilSink, startExfilSink } from '@valet/fake-woolworths-site'
import {
  appWindows,
  CONTROL,
  callTool,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

let userData: string
let launched: Launched
let control: Page
let client: McpClient
let sink: ExfilSink
/** evil.test's front door: every connection is counted, then piped to the sink. */
let door: Server
let doorPort = 0
let connections = 0

test.beforeAll(async () => {
  sink = await startExfilSink({ hostname: 'evil.test' })
  door = createServer((socket) => {
    connections += 1
    const upstream = connect(sink.port, '127.0.0.1')
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  await new Promise<void>((done) => door.listen(0, '127.0.0.1', done))
  const address = door.address()
  doorPort = typeof address === 'object' && address !== null ? address.port : 0

  userData = tempDir('egress')
  launched = await launch(userData)
  control = await windowWithTitle(launched.app, CONTROL)
  client = await connectMcp(control, userData)
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
  await sink?.close()
  door?.close()
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of appWindows(launched.app).entries())
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

function auditEvents(): { type: string; [key: string]: unknown }[] {
  return readFileSync(join(userData, 'audit.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: { type: string } }).event)
}

/** The most beacon rounds any open tool-partition page has counted (read from an isolated world). */
function beaconRounds(): Promise<number> {
  return launched.app.evaluate(async ({ session, webContents }, attribute) => {
    const tool = session.fromPartition('persist:tool:woolworths')
    let most = 0
    for (const contents of webContents.getAllWebContents()) {
      if (contents.isDestroyed() || contents.session !== tool) continue
      const rounds = await contents
        .executeJavaScriptInIsolatedWorld(999, [
          { code: `Number(document.documentElement.getAttribute(${JSON.stringify(attribute)}) ?? 0)` },
        ])
        .catch(() => 0)
      most = Math.max(most, Number(rounds) || 0)
    }
    return most
  }, BEACON_ROUNDS_ATTRIBUTE)
}

/** What reached evil.test after the self-tests: connections through the door, requests at the sink. */
function leaks(): { connections: number; requests: string[] } {
  return {
    connections: connections - 2,
    requests: sink.requests
      .filter((r) => !r.path.startsWith('/self-test'))
      .map((r) => `${r.method} ${r.path}`),
  }
}

test('the canary works: evil.test, as the app resolves it, reaches the sink', async () => {
  const response = await fetch(`http://127.0.0.1:${doorPort}/self-test`, {
    headers: { connection: 'close' },
  })
  expect(response.status).toBe(200)
  expect(connections).toBe(1)
  // Through Chromium's own network stack, in a throwaway session no policy covers: the resolver rule
  // takes evil.test to the door. So a request the adapter's partitions let out would land here too.
  const status = await launched.app.evaluate(async ({ session }, port) => {
    const unguarded = session.fromPartition('e2e-canary-self-test')
    const answer = await unguarded.fetch(`http://evil.test:${port}/self-test-chromium`)
    return answer.status
  }, doorPort)
  expect(status).toBe(200)
  expect(sink.requests.map((r) => r.path)).toEqual(['/self-test', '/self-test-chromium'])
  expect(connections).toBe(2)
})

test('approved and searched, the app itself sends nothing to evil.test', async () => {
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  const hash = pending?.[0]?.to.hash ?? ''
  await control.evaluate((hash) => window.valet?.approvals.approve('woolworths', hash), hash)
  await expect.poll(async () => (await client.listTools()).tools.length).toBe(6)
  const found = await callTool(client, 'woolworths_search_products', { query: 'bread' })
  expect(found.isError, found.text).toBe(false)
  expect(leaks()).toEqual({ connections: 0, requests: [] })
})

test('a hostile page script beaconing to evil.test is blocked, and audited as the page’s', async () => {
  // From now on every www page the fake serves carries the beacon, as its own script.
  await launched.app.evaluate((_electron, port) => {
    const hook = (globalThis as { __valetE2e?: { pageBeacon(t: { host: string; port: number }): void } })
      .__valetE2e
    if (hook === undefined) throw new Error('not an e2e launch of a demo build')
    hook.pageBeacon({ host: 'evil.test', port })
  }, doorPort)
  // The tool page from the search loaded before that: close it, so the next run opens a fresh one.
  await launched.app.evaluate(({ BrowserWindow, session }) => {
    const tool = session.fromPartition('persist:tool:woolworths')
    for (const window of BrowserWindow.getAllWindows())
      if (window.webContents.session === tool) window.destroy()
  })

  // Tool runs while the page keeps beaconing: each run's policy refuses them and the runtime audits
  // them with the call's id.
  for (const query of ['milk', 'eggs', 'butter']) {
    const result = await callTool(client, 'woolworths_search_products', { query })
    // The site's own script calling an off-list host is normal for a site, and only recorded: the
    // tool still answers.
    expect(result.isError, result.text).toBe(false)
  }
  // The beacon really ran: rounds are counted on the tool page.
  await expect.poll(beaconRounds, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  // And between runs, with no tool running: the app audits those, with no call id.
  const before = await beaconRounds()
  await new Promise((done) => setTimeout(done, 1500))
  expect(await beaconRounds()).toBeGreaterThan(before)

  expect(leaks()).toEqual({ connections: 0, requests: [] })

  const blocked = auditEvents().filter((e) => e.type === 'request-blocked')
  const toEvil = blocked.filter((e) => String(e['target']).includes('evil.test'))
  expect(toEvil.length).toBeGreaterThan(0)
  for (const event of toEvil) {
    expect(event['initiator']).toBe('page')
    expect(event['adapterId']).toBe('woolworths')
    expect(event['partition']).toBe('tool')
    expect(event['callId'] === null || typeof event['callId'] === 'string').toBe(true)
    // The origin only: the cookie in the query (and the path) never reach the log.
    expect(String(event['target'])).toMatch(/^(https?|wss?):\/\/evil\.test:\d+$/)
  }
  expect(toEvil.some((e) => typeof e['callId'] === 'string')).toBe(true)
  expect(toEvil.some((e) => e['callId'] === null)).toBe(true)
  // Chromium upgrades or refuses the http:// attempts from an https page itself (mixed content);
  // what reaches the network layer is https, and that is what the policy refuses.
  const targets = new Set(toEvil.map((e) => String(e['target'])))
  expect(targets).toContain(`https://evil.test:${doorPort}`)
})

test('the audit log shows the blocked beacons under Blocked', async () => {
  await control
    .getByRole('complementary', { name: 'Sections' })
    .getByRole('link', { name: /^Audit log/ })
    .click()
  await control.getByRole('button', { name: 'Blocked' }).click()
  await expect(control.getByText(`evil.test:${doorPort}`).first()).toBeVisible()
  await expect(control.getByText('request-blocked').first()).toBeVisible()
})
