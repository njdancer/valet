import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Grant, SiteAdapterError } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileGrantStore, type GrantFs, isValidGrant } from '../src/grant-store'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const grant: Grant = {
  adapterId: 'woolworths',
  adapterHash: HASH_A,
  secret: 'login',
  provider: 'onepassword-cli',
  itemRef: 'op://siteadapter/Woolworths',
  origins: ['https://www.woolworths.com.au'],
  grantedAt: '2026-11-07T00:00:00.000Z',
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'siteadapter-grants-'))
  path = join(dir, 'grants.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function errorOf(promise: Promise<unknown>): Promise<SiteAdapterError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SiteAdapterError) return error
    throw error
  }
  throw new Error('expected a SiteAdapterError')
}

async function writeRaw(value: unknown, mode = 0o600): Promise<void> {
  await fs.writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), { mode })
  await fs.chmod(path, mode)
}

describe('FileGrantStore', () => {
  it('starts empty when the file does not exist', async () => {
    const store = new FileGrantStore({ path })
    expect(await store.list()).toEqual([])
    expect(await store.find('woolworths', HASH_A, 'login')).toBeNull()
  })

  it('finds a grant it stored', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    expect(await store.find('woolworths', HASH_A, 'login')).toEqual(grant)
    expect(await new FileGrantStore({ path }).list()).toEqual([grant])
  })

  it('does not hand a grant to a changed adapter', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    expect(await store.find('woolworths', HASH_B, 'login')).toBeNull()
  })

  it('does not hand a grant to another adapter or another secret', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    expect(await store.find('coles', HASH_A, 'login')).toBeNull()
    expect(await store.find('woolworths', HASH_A, 'otp')).toBeNull()
  })

  it('does not match on a hash prefix or different case', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    expect(await store.find('woolworths', HASH_A.slice(0, 63), 'login')).toBeNull()
    expect(await store.find('woolworths', HASH_A.toUpperCase(), 'login')).toBeNull()
    expect(await store.find('Woolworths', HASH_A, 'login')).toBeNull()
  })

  it('writes the file with mode 0600 and a versioned shape', async () => {
    await new FileGrantStore({ path }).put(grant)
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ version: 1, grants: [grant] })
  })

  it('creates missing parent directories', async () => {
    const nested = join(dir, 'a', 'b', 'grants.json')
    await new FileGrantStore({ path: nested }).put(grant)
    expect(await new FileGrantStore({ path: nested }).list()).toEqual([grant])
  })

  it('leaves no temporary files behind', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    await store.put({ ...grant, secret: 'other' })
    expect(await fs.readdir(dir)).toEqual(['grants.json'])
  })

  it('replaces a grant in the same slot and keeps grants for other hashes', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    await store.put({ ...grant, adapterHash: HASH_B })
    await store.put({ ...grant, itemRef: 'op://siteadapter/Woolworths 2' })
    expect(await store.list()).toEqual([
      { ...grant, adapterHash: HASH_B },
      { ...grant, itemRef: 'op://siteadapter/Woolworths 2' },
    ])
  })

  it('revokes every grant for an adapter and secret, whatever the hash', async () => {
    const store = new FileGrantStore({ path })
    await store.put(grant)
    await store.put({ ...grant, adapterHash: HASH_B })
    await store.put({ ...grant, secret: 'rewards' })
    await store.put({ ...grant, adapterId: 'coles' })
    await store.revoke('woolworths', 'login')
    expect(await store.list()).toEqual([
      { ...grant, secret: 'rewards' },
      { ...grant, adapterId: 'coles' },
    ])
  })

  it('does not create a file when revoking nothing', async () => {
    await new FileGrantStore({ path }).revoke('woolworths', 'login')
    await expect(fs.access(path)).rejects.toThrow()
  })

  it('keeps every grant when puts race', async () => {
    const store = new FileGrantStore({ path })
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.put({ ...grant, secret: `secret_${i}` })))
    expect((await store.list()).map((g) => g.secret).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `secret_${i}`).sort(),
    )
  })

  it('hands out grants that cannot be mutated, and is unaffected by mutating its input', async () => {
    const store = new FileGrantStore({ path })
    const input = { ...grant, origins: [...grant.origins] }
    await store.put(input)
    input.origins.push('https://evil.example')
    const found = await store.find('woolworths', HASH_A, 'login')
    expect(found?.origins).toEqual(['https://www.woolworths.com.au'])
    expect(() => (found!.origins as string[]).push('https://evil.example')).toThrow()
    expect(Object.isFrozen(found)).toBe(true)
  })

  describe('put refuses a malformed grant and leaves the file alone', () => {
    const bad: [string, unknown][] = [
      ['an http origin', { ...grant, origins: ['http://www.woolworths.com.au'] }],
      ['an origin with a path', { ...grant, origins: ['https://www.woolworths.com.au/login'] }],
      ['an origin with a query', { ...grant, origins: ['https://www.woolworths.com.au?x=1'] }],
      ['an origin with credentials', { ...grant, origins: ['https://user@www.woolworths.com.au'] }],
      ['a wildcard origin', { ...grant, origins: ['https://*.woolworths.com.au'] }],
      ['an IPv4 literal origin', { ...grant, origins: ['https://192.168.1.1'] }],
      ['a hex IPv4 literal origin', { ...grant, origins: ['https://0x7f.1'] }],
      ['an IPv6 literal origin', { ...grant, origins: ['https://[::1]'] }],
      ['no origins', { ...grant, origins: [] }],
      ['a non-string origin', { ...grant, origins: [42] }],
      ['a short hash', { ...grant, adapterHash: 'abc' }],
      ['an upper-case hash', { ...grant, adapterHash: HASH_A.toUpperCase() }],
      ['an unknown provider', { ...grant, provider: 'keychain' }],
      ['an empty item ref', { ...grant, itemRef: '' }],
      ['a control character in the item ref', { ...grant, itemRef: 'op://v/i\n' }],
      ['an overlong item ref', { ...grant, itemRef: `op://v/${'i'.repeat(510)}` }],
      ['a bad adapter id', { ...grant, adapterId: 'Woolworths' }],
      ['a bad secret name', { ...grant, secret: 'Login' }],
      ['a timestamp that is not ISO', { ...grant, grantedAt: 'yesterday' }],
      ['an impossible date', { ...grant, grantedAt: '2026-13-45T00:00:00Z' }],
      ['an extra field', { ...grant, field: 'password' }],
      ['a missing field', { adapterId: 'woolworths' }],
      ['not an object', 'grant'],
      ['an array', [grant]],
    ]
    for (const [name, value] of bad) {
      it(name, async () => {
        const store = new FileGrantStore({ path })
        await store.put(grant)
        const before = await fs.readFile(path, 'utf8')
        const error = await errorOf(store.put(value as Grant))
        expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
        expect(await fs.readFile(path, 'utf8')).toBe(before)
      })
    }
  })

  it('accepts an origin with a trailing slash and a timestamp without milliseconds', async () => {
    const store = new FileGrantStore({ path })
    const variant = {
      ...grant,
      origins: ['https://www.woolworths.com.au/'],
      grantedAt: '2026-11-07T00:00:00Z',
    }
    await store.put(variant)
    expect(await store.list()).toEqual([variant])
  })

  it('accepts an origin on a non-default port, which is part of the origin granted', async () => {
    const store = new FileGrantStore({ path })
    const onPort = { ...grant, origins: ['https://www.woolworths.com.au:8443'] }
    await store.put(onPort)
    expect(await store.list()).toEqual([onPort])
  })

  describe('refuses a grant file that was tampered with', () => {
    const tampered: [string, unknown][] = [
      ['invalid JSON', '{"version":1,'],
      ['the wrong version', { version: 2, grants: [grant] }],
      ['no grants array', { version: 1, grants: {} }],
      ['an extra top-level key', { version: 1, grants: [grant], note: 'x' }],
      ['an array at the top', [grant]],
      [
        'a grant with an http origin',
        { version: 1, grants: [{ ...grant, origins: ['http://evil.example'] }] },
      ],
      ['a grant with an extra field', { version: 1, grants: [{ ...grant, field: 'password' }] }],
      [
        'a grant with a __proto__ key',
        `{"version":1,"grants":[${JSON.stringify(grant).replace('{', '{"__proto__":{},')}]}`,
      ],
      ['two grants in one slot', { version: 1, grants: [grant, { ...grant, itemRef: 'op://v/other' }] }],
    ]
    for (const [name, contents] of tampered) {
      it(name, async () => {
        await writeRaw(contents)
        const store = new FileGrantStore({ path })
        const error = await errorOf(store.find('woolworths', HASH_A, 'login'))
        expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
        // A put must not paper over a corrupt file by rewriting it.
        await errorOf(store.put(grant))
        expect(await fs.readFile(path, 'utf8')).toBe(
          typeof contents === 'string' ? contents : JSON.stringify(contents),
        )
      })
    }
  })

  it('refuses a grant file that others can write', async () => {
    await writeRaw({ version: 1, grants: [grant] }, 0o622)
    const error = await errorOf(new FileGrantStore({ path }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('reads a grant file that others can only read', async () => {
    await writeRaw({ version: 1, grants: [grant] }, 0o644)
    expect(await new FileGrantStore({ path }).list()).toEqual([grant])
  })

  it('refuses a symlink in place of the grant file', async () => {
    const elsewhere = join(dir, 'planted.json')
    await fs.writeFile(elsewhere, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 })
    await fs.symlink(elsewhere, path)
    const error = await errorOf(new FileGrantStore({ path }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('refuses a directory in place of the grant file', async () => {
    await fs.mkdir(path)
    const error = await errorOf(new FileGrantStore({ path }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('refuses a grant file owned by another user', async () => {
    await writeRaw({ version: 1, grants: [grant] })
    const otherOwner: GrantFs = {
      ...fs,
      open: (async (p: string, flags?: number, mode?: number) => {
        const handle = await fs.open(p, flags, mode)
        const stat = handle.stat.bind(handle)
        return Object.assign(handle, {
          stat: async () => Object.assign(await stat(), { uid: (await stat()).uid + 1 }),
        })
      }) as GrantFs['open'],
    }
    const error = await errorOf(new FileGrantStore({ path, fs: otherOwner }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('checks the file through the handle it reads, opened without following links', async () => {
    await writeRaw({ version: 1, grants: [grant] })
    const flags: unknown[] = []
    const recording: GrantFs = {
      ...fs,
      open: (async (p: string, f?: number, mode?: number) => {
        flags.push(f)
        return fs.open(p, f, mode)
      }) as GrantFs['open'],
    }
    await new FileGrantStore({ path, fs: recording }).list()
    const opened = flags[0] as number
    expect(opened & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(opened & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    expect(opened & (constants.O_WRONLY | constants.O_RDWR)).toBe(0)
  })

  it('refuses a FIFO in place of the grant file, without blocking on it', async () => {
    execFileSync('/usr/bin/mkfifo', [path])
    const error = await errorOf(new FileGrantStore({ path }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('refuses a grant file in a directory others can write, on read and on put', async () => {
    await writeRaw({ version: 1, grants: [grant] })
    const before = await fs.readFile(path, 'utf8')
    for (const mode of [0o777, 0o770, 0o702]) {
      await fs.chmod(dir, mode)
      const store = new FileGrantStore({ path })
      const error = await errorOf(store.list())
      expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
      await errorOf(store.put({ ...grant, secret: 'other' }))
      expect(await fs.readFile(path, 'utf8')).toBe(before)
    }
    await fs.chmod(dir, 0o700)
  })

  it('refuses to create the first grant in a directory others can write', async () => {
    await fs.chmod(dir, 0o777)
    const error = await errorOf(new FileGrantStore({ path }).put(grant))
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
    expect(await fs.readdir(dir)).toEqual([])
    await fs.chmod(dir, 0o700)
  })

  it('reads a grant file in a directory others can only read', async () => {
    await writeRaw({ version: 1, grants: [grant] })
    await fs.chmod(dir, 0o755)
    expect(await new FileGrantStore({ path }).list()).toEqual([grant])
  })

  it('refuses a directory owned by another user', async () => {
    await writeRaw({ version: 1, grants: [grant] })
    const otherOwner: GrantFs = {
      ...fs,
      lstat: (async (p: string) => {
        const info = await fs.lstat(p)
        return Object.assign(info, { uid: info.uid + 1 })
      }) as GrantFs['lstat'],
    }
    const error = await errorOf(new FileGrantStore({ path, fs: otherOwner }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('refuses a symlinked directory', async () => {
    const real = join(dir, 'real')
    await fs.mkdir(real, { mode: 0o700 })
    await fs.writeFile(join(real, 'grants.json'), JSON.stringify({ version: 1, grants: [grant] }), {
      mode: 0o600,
    })
    await fs.symlink(real, join(dir, 'link'))
    const error = await errorOf(new FileGrantStore({ path: join(dir, 'link', 'grants.json') }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
  })

  it('starts empty when the directory does not exist yet', async () => {
    expect(await new FileGrantStore({ path: join(dir, 'missing', 'grants.json') }).list()).toEqual([])
  })

  it('reports a directory it cannot inspect as unavailable', async () => {
    const failing: GrantFs = {
      ...fs,
      lstat: (async () => {
        throw Object.assign(new Error(`EACCES ${dir}`), { code: 'EACCES' })
      }) as GrantFs['lstat'],
    }
    const error = await errorOf(new FileGrantStore({ path, fs: failing }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'unavailable'])
    expect(error.message).not.toContain(dir)
  })

  it('reports an unreadable file as unavailable', async () => {
    await writeRaw({ version: 1, grants: [grant] })
    const failing: GrantFs = {
      ...fs,
      open: (async () => {
        throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' })
      }) as GrantFs['open'],
    }
    const error = await errorOf(new FileGrantStore({ path, fs: failing }).list())
    expect([error.stage, error.errorClass]).toEqual(['grant', 'unavailable'])
    expect(error.message).not.toContain(path)
  })

  it('reports a failure to create the directory as unavailable', async () => {
    const failing: GrantFs = {
      ...fs,
      mkdir: (async () => {
        throw new Error('EROFS')
      }) as GrantFs['mkdir'],
    }
    const error = await errorOf(
      new FileGrantStore({ path: join(dir, 'new', 'grants.json'), fs: failing }).put(grant),
    )
    expect([error.stage, error.errorClass]).toEqual(['grant', 'unavailable'])
  })

  it('leaves the old file intact and cleans up when the rename fails', async () => {
    await new FileGrantStore({ path }).put(grant)
    const before = await fs.readFile(path, 'utf8')
    const failing: GrantFs = {
      ...fs,
      rename: async () => {
        throw new Error('EIO')
      },
    }
    const store = new FileGrantStore({ path, fs: failing })
    const error = await errorOf(store.put({ ...grant, secret: 'other' }))
    expect([error.stage, error.errorClass]).toEqual(['grant', 'unavailable'])
    expect(await fs.readFile(path, 'utf8')).toBe(before)
    expect(await fs.readdir(dir)).toEqual(['grants.json'])
  })

  it('reports a failure to create the temporary file as unavailable', async () => {
    const failing: GrantFs = {
      ...fs,
      open: (async (p: string, flags?: string | number, mode?: number) => {
        if (flags === 'wx') throw new Error('EMFILE')
        return fs.open(p, flags, mode)
      }) as GrantFs['open'],
    }
    const error = await errorOf(new FileGrantStore({ path, fs: failing }).put(grant))
    expect(error.errorClass).toBe('unavailable')
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('keeps working after a failed write', async () => {
    let failNext = true
    const flaky: GrantFs = {
      ...fs,
      rename: async (from, to) => {
        if (failNext) {
          failNext = false
          throw new Error('EIO')
        }
        return fs.rename(from, to)
      },
    }
    const store = new FileGrantStore({ path, fs: flaky })
    const first = store.put(grant)
    const second = store.put({ ...grant, secret: 'other' })
    await errorOf(first)
    await second
    expect(await store.list()).toEqual([{ ...grant, secret: 'other' }])
  })

  it('tolerates a platform that cannot fsync a directory', async () => {
    const noDirSync: GrantFs = {
      ...fs,
      open: (async (p: string, flags?: string, mode?: number) => {
        if (p === dir) throw new Error('EISDIR')
        return fs.open(p, flags, mode)
      }) as GrantFs['open'],
    }
    await new FileGrantStore({ path, fs: noDirSync }).put(grant)
    expect(await new FileGrantStore({ path }).list()).toEqual([grant])
  })
})

describe('isValidGrant', () => {
  it('accepts every provider kind', () => {
    for (const provider of ['onepassword-service-account', 'onepassword-cli', 'fake']) {
      expect(isValidGrant({ ...grant, provider })).toBe(true)
    }
  })

  it('rejects null', () => {
    expect(isValidGrant(null)).toBe(false)
  })
})
