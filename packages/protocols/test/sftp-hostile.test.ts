// A hostile or unusual SFTP server (docs/sftp.md#a-hostile-server): one whose REALPATH only tidies
// the path, one that sends names Valet can't address, empty or endless data, and one that lies.

import { symlink } from 'node:fs/promises'
import type { FakeSftp, FakeSftpOptions } from '@valet/fake-sftp'
import { utils } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeSftp, signedIn } from './sftp-helpers'

const { STATUS_CODE } = utils.sftp

let server: FakeSftp | null = null
let close: (() => void) | null = null
afterEach(async () => {
  close?.()
  close = null
  await server?.close()
  server = null
})

async function session(purpose: 'read' | 'write' | 'irreversible', options: FakeSftpOptions = {}) {
  server = await fakeSftp(options)
  const s = await signedIn(server, purpose)
  close = s.close
  return { ...s, server }
}

/** REALPATH as some servers do it: the path tidied, links not followed. */
const lexicalRealpath: FakeSftpOptions['hostile'] = ({ request, reqid, sftp }) => {
  if (request.type !== 'REALPATH' || request.path === undefined) return false
  const parts: string[] = []
  for (const p of request.path.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  const tidy = `/${parts.join('/')}`
  sftp.name(reqid, [{ filename: tidy, longname: tidy, attrs: {} as never }])
  return true
}

describe('a server whose REALPATH doesn’t follow links', () => {
  it('still can’t lead a read through a link out of the roots', async () => {
    const { ops, server } = await session('read', { hostile: lexicalRealpath })
    await symlink('../private', server.at('/docs/out'))
    await symlink('../private/secret.txt', server.at('/docs/secret'))
    await expect(ops.run('read', ['/docs/out/secret.txt'])).rejects.toMatchObject({ failure: 'not-allowed' })
    await expect(ops.run('read', ['/docs/secret'])).rejects.toMatchObject({ failure: 'not-allowed' })
    await expect(ops.run('list', ['/docs/out'])).rejects.toMatchObject({ failure: 'not-allowed' })
    expect(
      server.requests.some((r) => (r.type === 'OPEN' || r.type === 'OPENDIR') && r.path?.includes('out')),
    ).toBe(false)
  })

  it('nor a write through a linked folder', async () => {
    const { ops, server } = await session('write', { hostile: lexicalRealpath })
    await symlink('../docs', server.at('/inbox/docs'))
    await expect(ops.run('write', ['/inbox/docs/new.txt', 'x'])).rejects.toMatchObject({
      failure: 'not-allowed',
    })
    await expect(ops.run('mkdir', ['/inbox/docs/new'])).rejects.toMatchObject({ failure: 'not-allowed' })
  })
})

describe('a server that sends odd names and data', () => {
  it('leaves out names Valet can’t address, and counts them', async () => {
    const odd = ['ok.txt', 'bad\nname', 'back\\slash', 'nul\u0000', 'del\u007f', 'ünïcode', '.', '..']
    const { ops } = await session('read', {
      hostile: ({ request, reqid, sftp }) => {
        if (request.type !== 'READDIR') return false
        if ((globalThis as { sent?: boolean }).sent === true) {
          sftp.status(reqid, STATUS_CODE.EOF)
          return true
        }
        ;(globalThis as { sent?: boolean }).sent = true
        sftp.name(
          reqid,
          odd.map((n) => ({ filename: n, longname: n, attrs: { mode: 0o100644, size: 1 } as never })),
        )
        return true
      },
    })
    ;(globalThis as { sent?: boolean }).sent = false
    const listed = (await ops.run('list', ['/docs'])) as { entries: { name: string }[]; skipped: number }
    expect(listed.entries.map((e) => e.name)).toEqual(['ok.txt', 'ünïcode'])
    expect(listed.skipped).toBe(4)
  })

  it('stops listing a folder that never ends', async () => {
    let n = 0
    const { ops } = await session('read', {
      hostile: ({ request, reqid, sftp }) => {
        if (request.type !== 'READDIR') return false
        const names = Array.from({ length: 50 }, () => `f${n++}`)
        sftp.name(
          reqid,
          names.map((x) => ({ filename: x, longname: x, attrs: {} as never })),
        )
        return true
      },
    })
    const listed = (await ops.run('list', ['/docs', { limit: 1000 }])) as {
      entries: unknown[]
      truncated: boolean
    }
    expect(listed.entries).toHaveLength(1000)
    expect(listed.truncated).toBe(true)
  })

  it('refuses empty data, which would never end', async () => {
    const { ops } = await session('read', {
      hostile: ({ request, reqid, sftp }) => {
        if (request.type !== 'READ') return false
        sftp.data(reqid, Buffer.alloc(0))
        return true
      },
    })
    await expect(ops.run('read', ['/docs/readme.txt'])).rejects.toMatchObject({ failure: 'malformed' })
  })

  it('reads no more than asked from a file that never ends', async () => {
    const { ops } = await session('read', {
      hostile: ({ request, reqid, sftp }) => {
        if (request.type !== 'READ') return false
        sftp.data(reqid, Buffer.alloc(32 * 1024, 1))
        return true
      },
    })
    const r = (await ops.run('read', ['/docs/readme.txt', { length: 3 * 32 * 1024 }])) as { bytes: number }
    expect(r.bytes).toBe(3 * 32 * 1024)
  })

  it('takes a server’s answer that a path is somewhere else as the place it is', async () => {
    // A REALPATH that says /docs/readme.txt is really /private/secret.txt: refused, never opened.
    const { ops, server } = await session('read', {
      hostile: ({ request, reqid, sftp }) => {
        if (request.type !== 'REALPATH' || request.path !== '/docs/readme.txt') return false
        sftp.name(reqid, [{ filename: '/private/secret.txt', longname: '', attrs: {} as never }])
        return true
      },
    })
    await expect(ops.run('read', ['/docs/readme.txt'])).rejects.toMatchObject({ failure: 'not-allowed' })
    expect(server.requests.some((r) => r.path === '/private/secret.txt' && r.type !== 'REALPATH')).toBe(false)
  })
})
