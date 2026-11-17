// The SFTP host end to end: the bundled host script in its own Node process (under Seatbelt on
// macOS), reaching the fake server only through the egress broker's tunnel, the host key pinned,
// signed in just in time with a key, and refusing what its purpose and roots don't allow at every
// layer.

import { readFile } from 'node:fs/promises'
import { SecretValue, ValetError } from '@valet/core'
import { MemoryKeychain, ValetKeys } from '@valet/credentials'
import { type FakeSftp, keyPair, startFakeSftp } from '@valet/fake-sftp'
import { afterEach, describe, expect, it } from 'vitest'
import { SftpHostSession } from '../src/host-session'
import { sftpBackend } from '../src/sftp-backend'
import { run } from './helpers'
import { brokerToSftp, FILES, fakeSftp, keySignIn, mac, sftpHostOptions } from './sftp-helpers'

let server: FakeSftp | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const endpoint = 'nas.example.test:22'

function protocol(s: FakeSftp, extra: Record<string, unknown> = {}) {
  return {
    endpoint,
    credential: 'nas',
    hostKeySha256: s.hostKeySha256,
    username: s.username,
    roots: [
      { path: '/docs', access: 'read' as const },
      { path: '/inbox', access: 'write' as const },
      { path: '/scratch', access: 'irreversible' as const },
    ],
    ...extra,
  }
}

async function backend(extra: Record<string, unknown> = {}, s?: FakeSftp) {
  server = s ?? (await fakeSftp())
  return sftpBackend({
    protocol: protocol(server, extra),
    host: await sftpHostOptions(),
    broker: brokerToSftp(server),
  })
}

const call = (
  purpose: 'read' | 'write' | 'irreversible',
  r = run(),
  signIn = keySignIn(server as FakeSftp),
) => ({
  purpose,
  run: r,
  admit: async () => {},
  signIn,
  signal: r.controller.signal,
})

describe('the SFTP host', () => {
  it('reads through the tunnel, signed in with the key, and records the connection', async () => {
    const b = await backend()
    const r = run()
    const connection = await b.connect(call('read', r))
    const listed = (await connection.operation('list', ['/docs'])) as { entries: { name: string }[] }
    expect(listed.entries.map((e) => e.name)).toEqual(['notes', 'readme.txt'])
    const read = (await connection.operation('read', ['/docs/readme.txt', { encoding: 'utf8' }])) as {
      text: string
    }
    expect(read.text).toBe(FILES['/docs/readme.txt'])
    await connection.end()
    expect(server?.logins.filter((l) => l.ok)).toEqual([{ username: 'nick', method: 'publickey', ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.records).toEqual([expect.objectContaining({ endpoint, kind: 'tunnel', errorClass: null })])
    expect(r.records[0]?.bytesUp).toBeGreaterThan(0)
  })

  it('signs in with a key Valet made, with the manifest’s username', async () => {
    const keys = new ValetKeys({ keychain: new MemoryKeychain() })
    const made = await keys.generate('valet-nas')
    const fake = await startFakeSftp({ files: FILES, authorizedKey: made.publicKey })
    const b = await backend({}, fake)
    const signIn = async () => ({ username: null, secret: await keys.resolve(made.itemRef, 'ssh-key') })
    const connection = await b.connect(call('read', run(), signIn))
    expect(await connection.operation('stat', ['/docs/readme.txt'])).toMatchObject({ type: 'file' })
    await connection.end()
    expect(fake.logins.filter((l) => l.ok)).toEqual([{ username: 'nick', method: 'publickey', ok: true }])
  })

  it('lets the item’s own username win over the manifest’s', async () => {
    const b = await backend({ username: 'someone-else' })
    const connection = await b.connect(call('read', run(), keySignIn(server as FakeSftp, 'nick')))
    await connection.end()
    expect(server?.logins.map((l) => l.username)).toEqual(['nick'])
  })

  it('refuses a server whose host key isn’t the pinned one, before signing in', async () => {
    server = await fakeSftp()
    const other = keyPair()
    const fp = (await import('@valet/fake-sftp')).fingerprint(other.public)
    const b = sftpBackend({
      protocol: protocol(server, { hostKeySha256: fp }),
      host: await sftpHostOptions(),
      broker: brokerToSftp(server),
    })
    await expect(b.connect(call('read'))).rejects.toMatchObject({
      stage: 'egress',
      errorClass: 'host-key-mismatch',
    })
    expect(server.logins).toEqual([])
  })

  it('reports a refused key as auth-failed', async () => {
    const b = await backend()
    const wrong = keyPair()
    const signIn = async () => ({ username: null, secret: SecretValue.fromString(wrong.private) })
    await expect(b.connect(call('read', run(), signIn))).rejects.toMatchObject({
      stage: 'credential',
      errorClass: 'auth-failed',
    })
  })

  it('needs a username from the item or the manifest', async () => {
    const b = await backend({ username: undefined })
    await expect(b.connect(call('read'))).rejects.toMatchObject({ errorClass: 'field-missing' })
  })

  it('refuses a change from a read session, and a replace from a write session, in the host itself', async () => {
    const b = await backend()
    const reader = await b.connect(call('read'))
    await expect(reader.operation('write', ['/inbox/a.txt', 'x'])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await reader.end()
    const writer = await b.connect(call('write'))
    expect(await writer.operation('write', ['/inbox/a.txt', 'x'])).toEqual({
      path: '/inbox/a.txt',
      bytes: 1,
      mode: 'create',
    })
    await expect(
      writer.operation('write', ['/scratch/old.txt', 'y', { mode: 'replace' }]),
    ).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await expect(writer.operation('remove', ['/scratch/old.txt'])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await writer.end()
    expect(await readFile((server as FakeSftp).at('/scratch/old.txt'), 'utf8')).toBe('old')
    expect(
      server?.requests.some(
        (r) => r.type === 'REMOVE' || (r.type === 'OPEN' && r.path === '/scratch/old.txt'),
      ),
    ).toBe(false)
  })

  it('removes from an irreversible session, inside an irreversible root only', async () => {
    const b = await backend()
    const remover = await b.connect(call('irreversible'))
    expect(await remover.operation('remove', ['/scratch/old.txt'])).toEqual({ path: '/scratch/old.txt' })
    await expect(remover.operation('remove', ['/docs/readme.txt'])).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    await remover.end()
  })

  it('maps the server’s answers to Valet’s errors', async () => {
    const b = await backend()
    const c = await b.connect(call('write'))
    await expect(c.operation('stat', ['/docs/missing'])).rejects.toMatchObject({ errorClass: 'not-found' })
    await expect(c.operation('write', ['/inbox/x', 'x'])).resolves.toBeTruthy()
    await expect(c.operation('write', ['/inbox/x', 'x'])).rejects.toMatchObject({ errorClass: 'invalid' })
    await c.end()
  })

  it('holds a write to the run’s upload budget', async () => {
    const b = await backend()
    const r = run(64 * 1024)
    const c = await b.connect(call('write', r))
    const big = Buffer.alloc(200_000, 3).toString('base64')
    await expect(
      c.operation('write', ['/inbox/big.bin', big, { encoding: 'base64' }]),
    ).rejects.toBeInstanceOf(ValetError)
    await c.end().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(r.records.some((x) => x.errorClass === 'upload-budget')).toBe(true)
  })

  it('reaches a NAS at a private address, as a private host', async () => {
    server = await fakeSftp()
    const b = sftpBackend({
      protocol: protocol(server, { endpoint: '192.168.1.20:22' }),
      host: await sftpHostOptions(),
      broker: {
        testing: {
          allowAddresses: ['127.0.0.1', '192.168.1.20'],
          route: () => ({ address: '127.0.0.1', port: (server as FakeSftp).port }),
        },
      },
    })
    const c = await b.connect(call('read'))
    expect(await c.operation('stat', ['/docs'])).toMatchObject({ type: 'directory' })
    await c.end()
  })

  it('stops when the call ends', async () => {
    const b = await backend()
    const r = run()
    const c = await b.connect(call('read', r))
    r.controller.abort()
    await expect(c.operation('list', ['/docs'])).rejects.toBeInstanceOf(ValetError)
  })

  it('reaches nothing but its tunnel', async () => {
    server = await fakeSftp()
    const r = run()
    await expect(
      SftpHostSession.start({
        host: await sftpHostOptions(),
        endpoint: 'evil.example.test:22',
        purpose: 'read',
        roots: [{ path: '/docs', access: 'read' }],
        hostKeySha256: server.hostKeySha256,
        openTunnels: async (endpoints) => {
          if (endpoints.some((e) => e !== endpoint)) throw new ValetError('egress', 'host-not-allowed')
          return { ports: new Map<string, number>(), close: () => {} }
        },
        signIn: keySignIn(server),
        username: 'nick',
        signal: r.controller.signal,
      }),
    ).rejects.toBeInstanceOf(ValetError)
    expect(server.connections).toBe(0)
  })

  it.runIf(mac)('runs under the Seatbelt profile on macOS', async () => {
    server = await fakeSftp()
    const profiles: string[] = []
    const b = sftpBackend({
      protocol: protocol(server),
      host: await sftpHostOptions({ onProfile: (p) => profiles.push(p) }),
      broker: brokerToSftp(server),
    })
    const c = await b.connect(call('read'))
    expect(await c.operation('stat', ['/docs/readme.txt'])).toMatchObject({ type: 'file' })
    await c.end()
    expect(profiles[0]).toContain('(deny default)')
  })
})
