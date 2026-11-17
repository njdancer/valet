// The Node runtime end to end (docs/node-runtime.md): real Node processes, one per call, driven by
// the same runIsolated, describeIsolated and checkInputIsolated as every other isolated runtime. On
// macOS each one runs under its Seatbelt profile, as the app runs it; elsewhere without it, so the
// protocol, the shim and Node's permission model are still checked.

import { readFileSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValetError } from '@valet/core'
import { checkInputIsolated, describeIsolated, runIsolated } from '@valet/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type NodeRuntimeOptions, nodeRuntimeProcess } from '../src/spawn'
import { context, forwardingTunnels, mac, scriptFor, tcpServer } from './helpers'

const fixtures = join(import.meta.dirname, 'fixtures')
const cert = readFileSync(join(fixtures, 'test-cert.pem'), 'utf8')
const key = readFileSync(join(fixtures, 'test-key.pem'), 'utf8')

let script = ''
let echo: Awaited<ReturnType<typeof tcpServer>>
let other: Awaited<ReturnType<typeof tcpServer>>
let httpPort = 0
let httpsPort = 0
const closers: (() => void)[] = []
const requests: { host: string | undefined; url: string | undefined }[] = []

beforeAll(async () => {
  script = await scriptFor('probes.ts')
  echo = await tcpServer('pong')
  other = await tcpServer('should never be reached')
  const http = createHttpServer((req, res) => {
    requests.push({ host: req.headers.host, url: req.url })
    res.end(`hello from ${req.url}`)
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  httpPort = (http.address() as { port: number }).port
  const https = createHttpsServer({ cert, key }, (req, res) => res.end(`secure ${req.headers.host}`))
  await new Promise<void>((r) => https.listen(0, '127.0.0.1', r))
  httpsPort = (https.address() as { port: number }).port
  closers.push(
    () => echo.close(),
    () => other.close(),
    () => http.close(),
    () => https.close(),
  )
})
afterAll(() => {
  for (const close of closers) close()
})

function runtime(overrides: Partial<NodeRuntimeOptions> = {}) {
  const tunnels = forwardingTunnels({
    'echo.example.test:7000': { host: '127.0.0.1', port: echo.port },
    'api.example.test:80': { host: '127.0.0.1', port: httpPort },
    'api.example.test:443': { host: '127.0.0.1', port: httpsPort },
  })
  const stderr: string[] = []
  const profiles: string[] = []
  const start = nodeRuntimeProcess({
    nodeBinary: process.execPath,
    endpoints: ['echo.example.test:7000', 'api.example.test:80', 'api.example.test:443'],
    openTunnels: tunnels,
    home: homedir(),
    withoutSeatbelt: !mac,
    onStderr: (t) => stderr.push(t),
    onProfile: (p) => profiles.push(p),
    ...overrides,
  })
  const run = (tool: string, input: unknown = {}, signal?: AbortSignal) =>
    runIsolated(start, script, context(signal), tool, input)
  return { start, run, tunnels, stderr, profiles }
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'succeeded',
    (e: unknown) => (e instanceof ValetError ? `${e.stage}/${e.errorClass}` : String(e)),
  )

describe('a raw adapter’s tool call in the Node runtime', () => {
  it('runs the tool in a fresh process and answers its capability calls', async () => {
    const r = runtime()
    expect(await r.run('echo', { a: 1 })).toEqual({ echoed: { a: 1 } })
    expect(await r.run('confirm', { note: 'Go?' })).toEqual({ answer: true })
    // Each call had its own tunnels, closed when it ended.
    expect(r.tunnels.stats.opened).toBe(2)
    await expect.poll(() => r.tunnels.stats.closed).toBe(2)
  })

  it('describes the tools and checks input with their own schemas', async () => {
    const r = runtime()
    const described = await describeIsolated(r.start, script)
    expect(Object.keys(described)).toContain('echo')
    expect(await checkInputIsolated(r.start, script, 'echo', { a: 1 })).toEqual({ ok: true })
    expect((await checkInputIsolated(r.start, script, 'echo', 'not an object')).ok).toBe(false)
  })

  it('keeps nothing between calls', async () => {
    const r = runtime()
    expect(await r.run('globalState')).toEqual({ count: 1 })
    expect(await r.run('globalState')).toEqual({ count: 1 })
    const temp = (await r.run('temp')) as { path: string }
    // The process's temporary folder is gone once the call is over.
    await expect
      .poll(async () => (await readdir(join(temp.path, '..')).catch(() => null)) === null)
      .toBe(true)
  })

  it('starts with an empty environment, a throwaway home and Node’s permission model on', async () => {
    const r = runtime()
    const seen = (await r.run('environment')) as {
      env: Record<string, string>
      cwd: string
      home: string
      argv: string[]
      permission: boolean
    }
    expect(Object.keys(seen.env).sort()).toEqual(['HOME', 'LANG', 'TMPDIR'])
    expect(seen.home).toBe(seen.cwd)
    expect(seen.home.startsWith(await realpath(tmpdir()))).toBe(true)
    expect(seen.argv).toContain('--permission')
    expect(seen.argv).toContain('--no-addons')
    expect(seen.permission).toBe(false)
  })
})

describe('the network shim', () => {
  it('carries a TCP connection to a declared endpoint through its tunnel', async () => {
    const r = runtime()
    expect(await r.run('tcp', { host: 'echo.example.test', port: 7000, send: 'ping' })).toEqual({
      ok: true,
      value: 'pong',
    })
    expect(echo.received).toContain('ping')
    expect(r.tunnels.stats.connections).toEqual(['echo.example.test:7000'])
  })

  it('carries fetch and https, with the real host name for the Host header, SNI and the certificate', async () => {
    const r = runtime()
    expect(await r.run('fetch', { url: 'http://api.example.test/items?x=1' })).toEqual({
      ok: true,
      value: { status: 200, body: 'hello from /items?x=1' },
    })
    expect(requests.at(-1)).toEqual({ host: 'api.example.test', url: '/items?x=1' })
    expect(await r.run('https', { url: 'https://api.example.test/', ca: cert })).toEqual({
      ok: true,
      value: { status: 200, body: 'secure api.example.test' },
    })
  })

  it('refuses a host or port the adapter didn’t declare, before anything is sent', async () => {
    const r = runtime()
    expect(await r.run('tcp', { host: 'evil.example.test', port: 7000 })).toEqual({
      ok: false,
      code: 'EVALETDENIED',
    })
    expect(await r.run('tcp', { host: 'echo.example.test', port: 7001 })).toEqual({
      ok: false,
      code: 'EVALETDENIED',
    })
    // Loopback directly, at a port that isn't a tunnel: another local service, or Valet's own.
    expect(await r.run('tcp', { host: '127.0.0.1', port: other.port })).toEqual({
      ok: false,
      code: 'EVALETDENIED',
    })
    expect(await r.run('fetch', { url: 'http://evil.example.test/' })).toMatchObject({ ok: false })
    expect(other.received).toEqual([])
    expect(r.tunnels.stats.connections).toEqual([])
  })

  it('answers DNS for declared hosts only, with addresses that are never routed', async () => {
    const r = runtime()
    const found = (await r.run('lookup', { host: 'api.example.test' })) as {
      ok: boolean
      value: { address: string }
    }
    expect(found.ok).toBe(true)
    expect(found.value.address).toMatch(/^198\.18\./)
    expect(await r.run('lookupCallback', { host: 'API.example.test.' })).toEqual({
      ok: true,
      value: [{ address: found.value.address, family: 4 }],
    })
    expect(await r.run('lookup', { host: 'evil.example.test' })).toEqual({ ok: false, code: 'ENOTFOUND' })
  })

  it('a connection to a synthetic address goes to the host it stands for', async () => {
    const r = runtime()
    const found = (await r.run('lookup', { host: 'echo.example.test' })) as { value: { address: string } }
    // The address is fixed by the sorted host list, so a later process maps it the same way.
    expect(await r.run('tcp', { host: found.value.address, port: 7000, send: 'by address' })).toEqual({
      ok: true,
      value: 'pong',
    })
  })
})

describe('what Node’s permission model refuses inside the profile', () => {
  it('refuses child processes, workers and native addons', async () => {
    const r = runtime()
    expect(await r.run('spawn')).toEqual({ ok: false, code: 'ERR_ACCESS_DENIED' })
    expect(await r.run('worker')).toEqual({ ok: false, code: 'ERR_ACCESS_DENIED' })
    expect(await r.run('addon', { path: '/tmp/evil.node' })).toMatchObject({ ok: false })
  })

  it('refuses files outside the temporary folder and the declared paths', async () => {
    const r = runtime()
    expect(await r.run('read', { path: '/etc/hosts' })).toEqual({ ok: false, code: 'ERR_ACCESS_DENIED' })
    expect(await r.run('write', { path: join(homedir(), 'valet-pwned.txt') })).toEqual({
      ok: false,
      code: 'ERR_ACCESS_DENIED',
    })
    expect(await r.run('list', { path: homedir() })).toEqual({ ok: false, code: 'ERR_ACCESS_DENIED' })
  })

  it('reads a declared path', async () => {
    const r = runtime({ readPaths: [fixtures] })
    expect(await r.run('read', { path: join(fixtures, 'test-cert.pem') })).toMatchObject({ ok: true })
  })

  it('refuses to start with a declared path in a never-grantable place', async () => {
    const r = runtime({ readPaths: [join(homedir(), '.ssh')] })
    expect(await failure(r.run('echo'))).toBe('tool-run/internal')
    expect(r.stderr.join('')).toContain('tool-run/denied-path')
  })
})

describe('limits', () => {
  it('ends a call that is aborted, killing its process', async () => {
    const r = runtime()
    const controller = new AbortController()
    const held = r.run('hold', {}, controller.signal)
    setTimeout(() => controller.abort(), 300)
    expect(await failure(held)).toBe('tool-run/aborted')
    await expect.poll(() => r.tunnels.stats.closed).toBe(1)
  })

  it('ends a process at its lifetime cap', async () => {
    const r = runtime({ maxLifetimeMs: 1_500 })
    expect(await failure(r.run('spin'))).toBe('tool-run/internal')
  })

  it('ends a process at its heap cap', async () => {
    const r = runtime({ heapMb: 64 })
    expect(await failure(r.run('heap'))).toBe('tool-run/internal')
  })

  it('treats garbage on the channel as a violation', async () => {
    const r = runtime()
    expect(await failure(r.run('garble'))).toBe('tool-run/invalid')
  })

  it('is unavailable, never unconfined, without the macOS sandbox', async () => {
    const r = runtime({ withoutSeatbelt: false, platform: 'linux' })
    expect(await failure(r.run('echo'))).toBe('tool-run/internal')
    expect(r.stderr.join('')).toContain('tool-run/unavailable')
    expect(r.tunnels.stats.opened).toBe(0)
  })
})
