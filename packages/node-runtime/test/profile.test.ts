// The Seatbelt profile a raw adapter's Node process runs under (docs/node-runtime.md#the-profile).
// The generated text is checked everywhere; on macOS a probe process runs under it with no shim and
// without Node's permission model, so each refusal below is Seatbelt's alone. These tests never skip
// on macOS: CI runs them on its macOS runner.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { runIsolated } from '@valet/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ancestors, nodeRuntimeProfile, sbplString } from '../src/profile'
import { forbiddenUnderHome, nodeArguments, nodeRuntimeProcess } from '../src/spawn'
import { context, forwardingTunnels, mac, tcpServer } from './helpers'

const PROBE = join(import.meta.dirname, 'fixtures', 'probe-host.cjs')

describe('the generated profile', () => {
  const input = {
    nodeBinary: '/Applications/Valet.app/Contents/Resources/node-runtime/node',
    hostScript: '/Applications/Valet.app/Contents/Resources/node-runtime/runtime-host.cjs',
    tempDir: '/private/var/folders/xy/T/valet-node-abc',
    readPaths: ['/Users/tess/Documents/Recipes'],
    readWritePaths: ['/Users/tess/Downloads/Valet'],
    tunnelPorts: [50123, 50124, 50123],
    forbidden: ['/Users/tess/.ssh', '/Users/tess/Library/Keychains'],
  }

  it('denies by default and allows back only what the process needs', () => {
    const profile = nodeRuntimeProfile(input)
    const lines = profile.split('\n')
    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe('(deny default)')
    // Only Node itself may run; nothing may fork.
    expect(profile).toContain(`(allow process-exec (literal ${sbplString(input.nodeBinary)}))`)
    expect(profile.match(/process-exec/g)).toHaveLength(1)
    expect(profile).not.toContain('process-fork')
    // No Mach service at all: no pasteboard, Keychain, launch services or Apple Events.
    expect(profile).not.toContain('mach-lookup')
    expect(profile).not.toContain('appleevent')
    expect(profile).not.toContain('iokit')
    // The network: the tunnels' ports on loopback, once each, and nothing else.
    expect(profile).toContain(
      '(allow network-outbound (remote ip "localhost:50123") (remote ip "localhost:50124"))',
    )
    expect(profile.match(/network/g)).toHaveLength(1)
    expect(profile).not.toContain('network-bind')
    expect(profile).not.toContain('network-inbound')
    // Writes: the temporary folder, the declared read-write path and two character devices.
    const writes = lines.filter((l) => l.includes('file-write'))
    expect(writes).toEqual([
      `(allow file-read* file-write* (subpath ${sbplString(input.tempDir)}))`,
      '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper"))',
      '(allow file-read* file-write* (subpath "/Users/tess/Downloads/Valet"))',
      '(deny file-read* file-write* (subpath "/Users/tess/.ssh") (subpath "/Users/tess/Library/Keychains"))',
    ])
    // The never-grantable places are denied last, so no rule above can reopen them.
    expect(lines.filter((l) => l !== '').at(-1)).toContain('(deny file-read* file-write*')
  })

  it('lets path resolution stat the folders on the way, and no others', () => {
    const profile = nodeRuntimeProfile(input)
    const metadata = profile.split('\n').find((l) => l.startsWith('(allow file-read-metadata'))
    expect(metadata).toContain('(literal "/Users/tess")')
    expect(metadata).toContain('(literal "/Users/tess/Documents")')
    // Literals, never subpaths: listing or reading inside these folders stays denied.
    expect(metadata).not.toContain('subpath')
    expect(ancestors('/a/b/c')).toEqual(['/', '/a', '/a/b'])
  })

  it('has no network rule at all without tunnels', () => {
    const profile = nodeRuntimeProfile({ ...input, tunnelPorts: [] })
    expect(profile).not.toContain('network')
    expect(profile).not.toContain('system-socket')
  })

  it('refuses paths that aren’t absolute and resolved, quotes the rest, and refuses bad ports', () => {
    expect(() => nodeRuntimeProfile({ ...input, readPaths: ['relative/path'] })).toThrow()
    expect(() => nodeRuntimeProfile({ ...input, readPaths: ['/Users/tess/../x'] })).toThrow()
    expect(() => nodeRuntimeProfile({ ...input, readPaths: ['/x\n(allow default)'] })).toThrow()
    expect(() => nodeRuntimeProfile({ ...input, tunnelPorts: [0] })).toThrow()
    expect(() => nodeRuntimeProfile({ ...input, tunnelPorts: [70000] })).toThrow()
    expect(sbplString('/a "b" \\c')).toBe('"/a \\"b\\" \\\\c"')
    // A quote can't end the string early and add a rule of its own.
    const profile = nodeRuntimeProfile({ ...input, readPaths: ['/Users/tess/x") (allow default) ("'] })
    expect(profile).not.toMatch(/^\(allow default\)/m)
    expect(profile).toContain('(subpath "/Users/tess/x\\") (allow default) (\\"")')
  })

  it('names every never-grantable place under the home', async () => {
    const forbidden = await forbiddenUnderHome('/Users/tess')
    expect(forbidden).toContain('/Users/tess/.ssh')
    expect(forbidden).toContain('/Users/tess/Library/Application Support/Valet')
    expect(forbidden).toContain('/Users/tess/Library/Keychains')
    expect(forbidden.every((f) => f.startsWith('/Users/tess/'))).toBe(true)
  })

  it('gives Node its permission model with the same paths', () => {
    const args = nodeArguments({
      hostScript: '/h.cjs',
      tempDir: '/t',
      readPaths: ['/r'],
      readWritePaths: ['/w'],
      heapMb: 128,
    })
    expect(args).toEqual([
      '--permission',
      '--allow-fs-read=/h.cjs',
      '--allow-fs-read=/t',
      '--allow-fs-read=/r',
      '--allow-fs-read=/w',
      '--allow-fs-write=/t',
      '--allow-fs-write=/w',
      '--no-addons',
      '--max-old-space-size=128',
      '--disable-warning=ExperimentalWarning',
      '--no-deprecation',
      '/h.cjs',
    ])
    expect(args.some((a) => a.startsWith('--allow-child') || a.startsWith('--allow-worker'))).toBe(false)
  })
})

describe.runIf(mac)('Seatbelt alone, on macOS', () => {
  let place = ''
  let secret = ''
  let readable = ''
  let writable = ''
  let other: Awaited<ReturnType<typeof tcpServer>>
  let tunnelTarget: Awaited<ReturnType<typeof tcpServer>>

  beforeAll(async () => {
    // A stand-in for the person's files: under the home, declared or not.
    place = await realpath(await mkdtemp(join(homedir(), 'valet-node-runtime-test-')))
    secret = join(place, 'secret.txt')
    readable = join(place, 'declared-read')
    writable = join(place, 'declared-write')
    await writeFile(secret, 'secret')
    await mkdir(readable)
    await mkdir(writable)
    await writeFile(join(readable, 'ok.txt'), 'fine')
    other = await tcpServer('not for you')
    tunnelTarget = await tcpServer('tunnel')
  })
  afterAll(async () => {
    other.close()
    tunnelTarget.close()
    await rm(place, { recursive: true, force: true })
  })

  async function probe(attempts: readonly Record<string, unknown>[], permission = false) {
    const profiles: string[] = []
    const start = nodeRuntimeProcess({
      nodeBinary: process.execPath,
      hostScript: PROBE,
      endpoints: ['echo.example.test:7000'],
      openTunnels: forwardingTunnels({
        'echo.example.test:7000': { host: '127.0.0.1', port: tunnelTarget.port },
      }),
      home: homedir(),
      readPaths: [readable],
      readWritePaths: [writable],
      withoutNodePermission: !permission,
      onProfile: (p) => profiles.push(p),
    })
    const results = (await runIsolated(start, JSON.stringify(attempts), context(), 'probe', {})) as Record<
      string,
      string
    >
    return { results, profile: profiles[0] ?? '' }
  }

  it('runs Node at all: time zones, randomness, signals to itself', async () => {
    const { results } = await probe([
      { name: 'date', action: 'date' },
      { name: 'crypto', action: 'crypto' },
      { name: 'self', action: 'self' },
    ])
    expect(results).toEqual({ date: 'ok', crypto: 'ok', self: 'ok' })
  })

  it('connects to its tunnel only: no other loopback port, no internet, no UDP, no Unix socket', async () => {
    const { results } = await probe([
      { name: 'tunnel', action: 'connect', host: '127.0.0.1', port: 'tunnel' },
      { name: 'otherLoopback', action: 'connect', host: '127.0.0.1', port: other.port },
      { name: 'internet', action: 'connect', host: '1.1.1.1', port: 443 },
      { name: 'v6', action: 'connect', host: '::1', port: other.port },
      { name: 'udp', action: 'udp', host: '127.0.0.1', port: 53 },
      { name: 'mDNSResponder', action: 'unix', path: '/var/run/mDNSResponder' },
    ])
    expect(results['tunnel']).toBe('ok')
    for (const name of ['otherLoopback', 'internet', 'v6', 'udp', 'mDNSResponder'])
      expect([name, results[name]]).toEqual([name, 'EPERM'])
    expect(other.received).toEqual([])
  })

  it('reads only what it needs and what was declared', async () => {
    const { results } = await probe([
      { name: 'declared', action: 'read', path: join(readable, 'ok.txt') },
      { name: 'secret', action: 'read', path: secret },
      { name: 'listHome', action: 'list', path: homedir() },
      { name: 'listRoot', action: 'list', path: '/' },
      { name: 'hosts', action: 'read', path: '/etc/hosts' },
      { name: 'keychains', action: 'list', path: '/Library/Keychains' },
      { name: 'userKeychains', action: 'list', path: join(homedir(), 'Library/Keychains') },
      { name: 'ssh', action: 'list', path: join(homedir(), '.ssh') },
      { name: 'otherUsers', action: 'list', path: '/Users' },
    ])
    expect(results['declared']).toBe('ok')
    // The root folder's names are the one listing allowed: Node aborts at start without it.
    expect(results['listRoot']).toBe('ok')
    for (const name of ['secret', 'listHome', 'hosts', 'keychains', 'userKeychains', 'ssh', 'otherUsers'])
      expect([name, results[name]]).toEqual([name, 'EPERM'])
  })

  it('writes only in its temporary folder and the declared read-write path', async () => {
    const { results } = await probe([
      { name: 'temp', action: 'write', path: 'temp' },
      { name: 'declared', action: 'write', path: join(writable, 'out.txt') },
      { name: 'declaredRead', action: 'write', path: join(readable, 'out.txt') },
      { name: 'home', action: 'write', path: join(place, 'pwned.txt') },
      { name: 'launchAgent', action: 'write', path: join(homedir(), 'Library/LaunchAgents/x.plist') },
      { name: 'sharedTmp', action: 'write', path: '/tmp/valet-pwned.txt' },
      { name: 'renameOut', action: 'renameOut', to: join(place, 'moved.txt') },
    ])
    expect(results['temp']).toBe('ok')
    expect(results['declared']).toBe('ok')
    for (const name of ['declaredRead', 'home', 'launchAgent', 'sharedTmp', 'renameOut'])
      expect([name, results[name]]).toEqual([name, 'EPERM'])
  })

  it('can’t reach a file through a link it made in its temporary folder', async () => {
    const { results } = await probe([
      { name: 'symlink', action: 'symlinkRead', target: secret },
      { name: 'hardlink', action: 'hardlinkRead', target: secret },
    ])
    expect(results['symlink']).toBe('EPERM')
    expect(results['hardlink']).toBe('EPERM')
  })

  it('runs no other program, not even another Node, and signals no other process', async () => {
    const { results } = await probe([
      { name: 'echo', action: 'spawn', program: '/bin/echo', args: ['hi'] },
      { name: 'shell', action: 'spawn', program: '/bin/sh', args: ['-c', 'true'] },
      { name: 'osascript', action: 'spawn', program: '/usr/bin/osascript', args: ['-e', '1'] },
      { name: 'node', action: 'spawn', program: process.execPath, args: ['-e', '1'] },
      { name: 'parent', action: 'signal', pid: 'parent' },
      { name: 'launchd', action: 'signal', pid: 1 },
    ])
    for (const name of ['echo', 'shell', 'osascript', 'node', 'parent', 'launchd'])
      expect([name, results[name]]).toEqual([name, 'EPERM'])
  })

  it('learns nothing about the person from the system', async () => {
    const { results } = await probe([
      { name: 'userInfo', action: 'userInfo' },
      { name: 'interfaces', action: 'interfaces' },
    ])
    // Either may fail, or answer from what little it can see; neither may crash the process.
    expect(Object.keys(results).sort()).toEqual(['interfaces', 'userInfo'])
  })
})

it('runs on macOS in CI: the Seatbelt tests above are never skipped there', () => {
  if (process.env['CI'] === 'true' && process.env['RUNNER_OS'] === 'macOS') expect(mac).toBe(true)
  expect(typeof tmpdir()).toBe('string')
})
