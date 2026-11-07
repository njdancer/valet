import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValetError } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPrivateFile, writePrivateFile } from '../src/private-file'
import { generateToken, isWellFormedToken, readTokenFile, tokensEqual, writeTokenFile } from '../src/token'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-token-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('generateToken', () => {
  it('encodes 32 random bytes as unpadded base64url', () => {
    const token = generateToken(() => Buffer.alloc(32, 0xff))
    expect(token).toBe(`${'_'.repeat(42)}8`)
    expect(isWellFormedToken(token)).toBe(true)
  })

  it('asks for exactly 32 bytes', () => {
    const sizes: number[] = []
    generateToken((size) => {
      sizes.push(size)
      return Buffer.alloc(size)
    })
    expect(sizes).toEqual([32])
  })

  it('makes a different token each time by default', () => {
    expect(generateToken()).not.toBe(generateToken())
    expect(isWellFormedToken(generateToken())).toBe(true)
  })
})

describe('isWellFormedToken', () => {
  it('rejects tokens of the wrong length or alphabet', () => {
    expect(isWellFormedToken('')).toBe(false)
    expect(isWellFormedToken(TOKEN.slice(1))).toBe(false)
    expect(isWellFormedToken(`${TOKEN}A`)).toBe(false)
    expect(isWellFormedToken(`${TOKEN.slice(1)}=`)).toBe(false)
    expect(isWellFormedToken(`${TOKEN.slice(1)}+`)).toBe(false)
  })
})

describe('tokensEqual', () => {
  it('accepts the same token', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true)
  })

  it('rejects a token differing in one character', () => {
    expect(tokensEqual(`${TOKEN.slice(0, -1)}R`, TOKEN)).toBe(false)
  })

  it('rejects a prefix or an extension without throwing on the length difference', () => {
    expect(tokensEqual(TOKEN.slice(0, 10), TOKEN)).toBe(false)
    expect(tokensEqual(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false)
    expect(tokensEqual('', TOKEN)).toBe(false)
  })

  it('compares bytes, not a case-folded or normalised form', () => {
    expect(tokensEqual(TOKEN.toUpperCase(), TOKEN)).toBe(false)
    expect(tokensEqual('é', 'é')).toBe(false)
  })
})

describe('writeTokenFile and readTokenFile', () => {
  it('round-trips a token through a 0600 file', async () => {
    const path = join(dir, 'token')
    await writeTokenFile(path, TOKEN)
    expect(await readTokenFile(path)).toBe(TOKEN)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('refuses to write a malformed token', async () => {
    await expect(writeTokenFile(join(dir, 'token'), 'short')).rejects.toEqual(
      new ValetError('config', 'invalid'),
    )
  })

  it('refuses to read a file holding something other than a token', async () => {
    const path = join(dir, 'token')
    await writePrivateFile(path, 'not a token')
    await expect(readTokenFile(path)).rejects.toEqual(new ValetError('config', 'invalid'))
  })

  it('refuses a token file other accounts could read', async () => {
    const path = join(dir, 'token')
    await writeTokenFile(path, TOKEN)
    await chmod(path, 0o644)
    await expect(readTokenFile(path)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('reports a missing file as not-found', async () => {
    await expect(readTokenFile(join(dir, 'missing'))).rejects.toEqual(new ValetError('config', 'not-found'))
  })
})

describe('writePrivateFile', () => {
  it('tightens a pre-existing file with a looser mode by replacing it', async () => {
    const path = join(dir, 'token')
    await writeFile(path, 'old', { mode: 0o644 })
    await writePrivateFile(path, 'new')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(path, 'utf8')).toBe('new')
  })

  it('replaces a planted symlink instead of writing through it', async () => {
    const target = join(dir, 'elsewhere')
    await writeFile(target, 'untouched')
    const path = join(dir, 'token')
    await symlink(target, path)

    await writePrivateFile(path, 'secret-ish')

    expect(await readFile(target, 'utf8')).toBe('untouched')
    expect(await readFile(path, 'utf8')).toBe('secret-ish')
  })

  it('leaves no temp file behind when the rename fails', async () => {
    const path = join(dir, 'token')
    await mkdir(path)
    await mkdir(join(path, 'occupied'))
    await expect(writePrivateFile(path, 'x')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['token'])
  })

  it('creates the file 0600 even under a permissive umask', async () => {
    const previous = process.umask(0)
    try {
      const path = join(dir, 'token')
      await writePrivateFile(path, 'x')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      process.umask(previous)
    }
  })
})

describe('readPrivateFile', () => {
  it('refuses a file other accounts could read', async () => {
    const path = join(dir, 'token')
    await writePrivateFile(path, TOKEN)
    await chmod(path, 0o640)
    await expect(readPrivateFile(path)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('refuses a file other accounts could write', async () => {
    const path = join(dir, 'token')
    await writePrivateFile(path, TOKEN)
    await chmod(path, 0o602)
    await expect(readPrivateFile(path)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('refuses a file owned by another account', async () => {
    const path = join(dir, 'token')
    await writePrivateFile(path, TOKEN)
    const otherUid = (process.getuid?.() ?? 0) + 1
    await expect(readPrivateFile(path, otherUid)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('refuses a directory', async () => {
    const path = join(dir, 'token')
    await mkdir(path, { mode: 0o700 })
    await expect(readPrivateFile(path)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('refuses a symlink, even to a private file of this account', async () => {
    const target = join(dir, 'elsewhere')
    await writePrivateFile(target, TOKEN)
    const path = join(dir, 'token')
    await symlink(target, path)
    await expect(readPrivateFile(path)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('refuses a FIFO without blocking on it', async () => {
    const path = join(dir, 'token')
    execFileSync('/usr/bin/mkfifo', ['-m', '600', path])
    await expect(readPrivateFile(path)).rejects.toEqual(new ValetError('config', 'insecure-file'))
  })

  it('reports a file it may not open as unavailable, not missing', async () => {
    const path = join(dir, 'token')
    await writePrivateFile(path, TOKEN)
    await chmod(path, 0o000)
    await expect(readPrivateFile(path)).rejects.toEqual(new ValetError('config', 'unavailable'))
  })
})
