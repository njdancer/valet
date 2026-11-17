// ctx.sftp's operations against the fake server, over a real SSH connection (ssh2 both ends), in
// this process: what each one does, and what each refuses before the server is asked.

import { readFile, symlink, writeFile } from 'node:fs/promises'
import type { FakeSftp } from '@valet/fake-sftp'
import { afterEach, describe, expect, it } from 'vitest'
import { SftpError } from '../src/sftp/wire'
import { fakeSftp, signedIn } from './sftp-helpers'

let server: FakeSftp | null = null
let close: (() => void) | null = null
afterEach(async () => {
  close?.()
  close = null
  await server?.close()
  server = null
})

async function session(purpose: 'read' | 'write' | 'irreversible') {
  server = await fakeSftp()
  const s = await signedIn(server, purpose)
  close = s.close
  return { ...s, server }
}

const fails = (failure: string, code: string | null = null) =>
  expect.objectContaining({ name: 'SftpError', failure, ...(code === null ? {} : { code }) })

describe('reading', () => {
  it('lists a folder, sorted, with types and sizes', async () => {
    const { ops } = await session('read')
    const listed = (await ops.run('list', ['/docs'])) as { entries: { name: string; type: string; size: number }[] }
    expect(listed.entries.map((e) => [e.name, e.type])).toEqual([
      ['notes', 'directory'],
      ['readme.txt', 'file'],
    ])
    expect(listed.entries[1]?.size).toBe(20)
    expect(listed).toMatchObject({ path: '/docs', truncated: false, skipped: 0 })
  })

  it('stats and reads a file as base64 or text', async () => {
    const { ops } = await session('read')
    expect(await ops.run('stat', ['/docs/readme.txt'])).toMatchObject({ type: 'file', size: 20 })
    const b = (await ops.run('read', ['/docs/readme.txt'])) as { base64: string; bytes: number; truncated: boolean }
    expect(Buffer.from(b.base64, 'base64').toString()).toBe('Hello from the NAS.\n')
    expect(b).toMatchObject({ bytes: 20, truncated: false })
    const t = await ops.run('read', ['/docs/readme.txt', { encoding: 'utf8', offset: 6, length: 4 }])
    expect(t).toMatchObject({ text: 'from', bytes: 4, offset: 6, truncated: true })
  })

  it('reads a large file in pieces, and says when it stopped short', async () => {
    const { ops, server } = await session('read')
    const big = Buffer.alloc(200_000, 7)
    await writeFile(server.at('/docs/big.bin'), big)
    const r = (await ops.run('read', ['/docs/big.bin', { length: 100_000 }])) as { base64: string; truncated: boolean }
    expect(Buffer.from(r.base64, 'base64')).toEqual(big.subarray(0, 100_000))
    expect(r.truncated).toBe(true)
  })

  it('refuses paths outside the roots, and paths not in Valet’s form, before asking the server', async () => {
    const { ops, server } = await session('read')
    const before = server.requests.length
    for (const bad of ['/private/secret.txt', '/', '/docs/../private/secret.txt', '/docs/./readme.txt', 'docs', '/docs/', '/docs//readme.txt', '/docs\\x']) {
      await expect(ops.run('read', [bad])).rejects.toEqual(fails(bad.startsWith('/private') || bad === '/' ? 'not-allowed' : 'invalid'))
    }
    expect(server.requests.length).toBe(before)
  })

  it('follows a link that stays inside the roots, and refuses one that leads out', async () => {
    const { ops, server } = await session('read')
    await symlink('readme.txt', server.at('/docs/inside'))
    await symlink('../private/secret.txt', server.at('/docs/outside'))
    await symlink('../private', server.at('/docs/outdir'))
    expect(await ops.run('read', ['/docs/inside', { encoding: 'utf8' }])).toMatchObject({ text: 'Hello from the NAS.\n' })
    await expect(ops.run('read', ['/docs/outside'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('list', ['/docs/outdir'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('read', ['/docs/outdir/secret.txt'])).rejects.toEqual(fails('not-allowed'))
    // The secret was never opened.
    expect(server.requests.some((r) => r.type === 'OPEN' && r.path?.includes('private'))).toBe(false)
  })

  it('refuses every change from a read session', async () => {
    const { ops, server } = await session('read')
    await expect(ops.run('write', ['/inbox/new.txt', 'x'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('mkdir', ['/inbox/new'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('remove', ['/scratch/old.txt'])).rejects.toEqual(fails('not-allowed'))
    expect(server.requests.filter((r) => r.type !== 'REALPATH')).toEqual([])
  })
})

describe('writing', () => {
  it('creates a file, and never over one that is there', async () => {
    const { ops, server } = await session('write')
    expect(await ops.run('write', ['/inbox/a.txt', 'hello'])).toEqual({ path: '/inbox/a.txt', bytes: 5, mode: 'create' })
    expect(await readFile(server.at('/inbox/a.txt'), 'utf8')).toBe('hello')
    await expect(ops.run('write', ['/inbox/a.txt', 'again'])).rejects.toEqual(fails('no', 'ALREADYEXISTS'))
    expect(await readFile(server.at('/inbox/a.txt'), 'utf8')).toBe('hello')
  })

  it('appends to a file, and writes base64', async () => {
    const { ops, server } = await session('write')
    await ops.run('write', ['/inbox/log.txt', 'one\n'])
    await ops.run('write', ['/inbox/log.txt', Buffer.from('two\n').toString('base64'), { mode: 'append', encoding: 'base64' }])
    expect(await readFile(server.at('/inbox/log.txt'), 'utf8')).toBe('one\ntwo\n')
    await expect(ops.run('write', ['/inbox/missing.txt', 'x', { mode: 'append' }])).rejects.toEqual(fails('no', 'NONEXISTENT'))
  })

  it('writes a file larger than one packet', async () => {
    const { ops, server } = await session('write')
    const data = Buffer.alloc(300_000, 1).toString('base64')
    await ops.run('write', ['/inbox/big.bin', data, { encoding: 'base64' }])
    expect((await readFile(server.at('/inbox/big.bin'))).length).toBe(300_000)
  })

  it('needs an irreversible session to replace a file', async () => {
    const { ops } = await session('write')
    await expect(ops.run('write', ['/scratch/old.txt', 'new', { mode: 'replace' }])).rejects.toEqual(fails('not-allowed'))
  })

  it('refuses to write in a read-only root, or to write through a link', async () => {
    const { ops, server } = await session('write')
    await expect(ops.run('write', ['/docs/new.txt', 'x'])).rejects.toEqual(fails('not-allowed'))
    await symlink('../docs/readme.txt', server.at('/inbox/link'))
    await expect(ops.run('write', ['/inbox/link', 'x', { mode: 'append' }])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('write', ['/inbox/link', 'x'])).rejects.toEqual(fails('no', 'ALREADYEXISTS'))
    expect(await readFile(server.at('/docs/readme.txt'), 'utf8')).toBe('Hello from the NAS.\n')
  })

  it('makes folders and renames, never over something, never a root', async () => {
    const { ops, server } = await session('write')
    await ops.run('mkdir', ['/inbox/sub'])
    await expect(ops.run('mkdir', ['/inbox/sub'])).rejects.toEqual(fails('no', 'ALREADYEXISTS'))
    await ops.run('write', ['/inbox/sub/x.txt', 'x'])
    expect(await ops.run('rename', ['/inbox/sub/x.txt', '/inbox/y.txt'])).toEqual({ from: '/inbox/sub/x.txt', to: '/inbox/y.txt' })
    expect(await readFile(server.at('/inbox/y.txt'), 'utf8')).toBe('x')
    await ops.run('write', ['/inbox/z.txt', 'z'])
    await expect(ops.run('rename', ['/inbox/z.txt', '/inbox/y.txt'])).rejects.toEqual(fails('no', 'ALREADYEXISTS'))
    await expect(ops.run('rename', ['/inbox', '/scratch/inbox'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('rename', ['/docs/readme.txt', '/inbox/readme.txt'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('mkdir', ['/inbox'])).rejects.toEqual(fails('not-allowed'))
  })
})

describe('removing', () => {
  it('removes a file and an empty folder, from an irreversible session in an irreversible root', async () => {
    const { ops, server } = await session('irreversible')
    expect(await ops.run('remove', ['/scratch/old.txt'])).toEqual({ path: '/scratch/old.txt' })
    await ops.run('mkdir', ['/scratch/empty'])
    await ops.run('removeDir', ['/scratch/empty'])
    expect(server.requests.map((r) => r.type)).toContain('RMDIR')
    await expect(ops.run('remove', ['/inbox/anything'])).rejects.toEqual(fails('not-allowed'))
    await expect(ops.run('removeDir', ['/scratch'])).rejects.toEqual(fails('not-allowed'))
  })

  it('removes a link, never what it points to', async () => {
    const { ops, server } = await session('irreversible')
    await symlink('../docs/readme.txt', server.at('/scratch/link'))
    await ops.run('remove', ['/scratch/link'])
    expect(await readFile(server.at('/docs/readme.txt'), 'utf8')).toBe('Hello from the NAS.\n')
  })

  it('replaces a file', async () => {
    const { ops, server } = await session('irreversible')
    expect(await ops.run('write', ['/scratch/old.txt', 'new', { mode: 'replace' }])).toMatchObject({ bytes: 3, mode: 'replace' })
    expect(await readFile(server.at('/scratch/old.txt'), 'utf8')).toBe('new')
  })

  it('refuses a non-empty folder and a file passed as a folder', async () => {
    const { ops } = await session('irreversible')
    await ops.run('mkdir', ['/scratch/full'])
    await ops.run('write', ['/scratch/full/f', 'f'])
    await expect(ops.run('removeDir', ['/scratch/full'])).rejects.toEqual(fails('no', 'NOTEMPTY'))
    await expect(ops.run('removeDir', ['/scratch/full/f'])).rejects.toEqual(fails('invalid'))
    await expect(ops.run('remove', ['/scratch/full'])).rejects.toEqual(fails('invalid'))
  })
})

describe('the wire', () => {
  it('never sends what Valet doesn’t use', async () => {
    const { ops, server } = await session('irreversible')
    await ops.run('list', ['/docs'])
    await ops.run('write', ['/scratch/n', 'n'])
    await ops.run('rename', ['/scratch/n', '/scratch/m'])
    await ops.run('remove', ['/scratch/m'])
    const types = new Set(server.requests.map((r) => r.type))
    for (const never of ['SETSTAT', 'FSETSTAT', 'FSTAT', 'READLINK', 'SYMLINK']) expect(types.has(never)).toBe(false)
  })
})

void SftpError
