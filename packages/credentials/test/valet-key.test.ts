import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { MemoryKeychain } from '../src/memory-keychain'
import { isValetKeyRef, KEY_SERVICE, ValetKeys } from '../src/valet-key'

/** Reads SSH wire-format fields in order. */
class Reader {
  at = 0
  constructor(readonly buf: Buffer) {}
  string(): Buffer {
    const length = this.buf.readUInt32BE(this.at)
    const out = this.buf.subarray(this.at + 4, this.at + 4 + length)
    this.at += 4 + length
    return out
  }
  uint32(): number {
    const value = this.buf.readUInt32BE(this.at)
    this.at += 4
    return value
  }
  rest(): Buffer {
    return this.buf.subarray(this.at)
  }
}

/** Parses an unencrypted openssh-key-v1 Ed25519 key, the way OpenSSH's sshkey.c does. */
function parseOpenSsh(pem: string): { seed: Buffer; publicKey: Buffer; comment: string } {
  const lines = pem.trim().split('\n')
  expect(lines[0]).toBe('-----BEGIN OPENSSH PRIVATE KEY-----')
  expect(lines.at(-1)).toBe('-----END OPENSSH PRIVATE KEY-----')
  for (const line of lines.slice(1, -1)) expect(line.length).toBeLessThanOrEqual(70)
  const raw = Buffer.from(lines.slice(1, -1).join(''), 'base64')
  const magic = Buffer.from('openssh-key-v1\0')
  expect(raw.subarray(0, magic.length).equals(magic)).toBe(true)
  const outer = new Reader(raw)
  outer.at = magic.length
  expect(outer.string().toString()).toBe('none')
  expect(outer.string().toString()).toBe('none')
  expect(outer.string().length).toBe(0)
  expect(outer.uint32()).toBe(1)
  const publicBlob = outer.string()
  const section = outer.string()
  expect(outer.rest().length).toBe(0)
  expect(section.length % 8).toBe(0)
  const inner = new Reader(section)
  expect(inner.uint32()).toBe(inner.uint32())
  expect(inner.string().toString()).toBe('ssh-ed25519')
  const publicKey = inner.string()
  const secret = inner.string()
  const comment = inner.string()
  // Padding is 1, 2, 3, ...
  expect([...inner.rest()]).toEqual(Array.from({ length: inner.rest().length }, (_, i) => i + 1))
  expect(secret.length).toBe(64)
  expect(secret.subarray(32).equals(publicKey)).toBe(true)
  const blob = new Reader(publicBlob)
  expect(blob.string().toString()).toBe('ssh-ed25519')
  expect(blob.string().equals(publicKey)).toBe(true)
  return {
    seed: Buffer.from(secret.subarray(0, 32)),
    publicKey: Buffer.from(publicKey),
    comment: comment.toString(),
  }
}

function keysWith(keychain = new MemoryKeychain()) {
  return { keychain, keys: new ValetKeys({ keychain, now: () => new Date('2026-11-17T01:02:03.000Z') }) }
}

describe('ValetKeys', () => {
  it('makes an Ed25519 key whose private half signs for the public half it shows', async () => {
    const { keys } = keysWith()
    const info = await keys.generate('valet.nas-files.nas')
    expect(isValetKeyRef(info.itemRef)).toBe(true)
    expect(info.publicKey).toMatch(
      /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} valet\.nas-files\.nas$/,
    )
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(info.createdAt).toBe('2026-11-17T01:02:03.000Z')

    const secret = await keys.resolve(info.itemRef, 'ssh-key')
    const parsed = secret.reveal(parseOpenSsh)
    expect(parsed.comment).toBe('valet.nas-files.nas')
    // Rebuild Node keys from the raw halves (RFC 8410 DER prefixes) and check they belong together.
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), parsed.seed]),
      format: 'der',
      type: 'pkcs8',
    })
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), parsed.publicKey]),
      format: 'der',
      type: 'spki',
    })
    const message = Buffer.from('challenge')
    expect(verify(null, message, publicKey, sign(null, message, privateKey))).toBe(true)
    // The public line names the same key.
    const blob = Buffer.from(info.publicKey.split(' ')[1] as string, 'base64')
    expect(blob.subarray(-32).equals(parsed.publicKey)).toBe(true)
  })

  it('stores only the private half in the Keychain item, and only public facts in its comment', async () => {
    const { keys, keychain } = keysWith()
    const info = await keys.generate('label')
    const [item] = keychain.items()
    expect(item?.service).toBe(KEY_SERVICE)
    expect(`valet-key:${item?.account}`).toBe(info.itemRef)
    expect(item?.secret).toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(JSON.parse(item?.comment ?? '')).toEqual({
      v: 1,
      publicKey: info.publicKey,
      createdAt: info.createdAt,
    })
    expect(await keys.info(info.itemRef)).toEqual(info)
  })

  it('makes a different key every time', async () => {
    const { keys } = keysWith()
    const a = await keys.generate('a')
    const b = await keys.generate('a')
    expect(a.itemRef).not.toBe(b.itemRef)
    expect(a.publicKey).not.toBe(b.publicKey)
  })

  it('has only the ssh-key field', async () => {
    const { keys } = keysWith()
    const { itemRef } = await keys.generate('a')
    for (const field of ['password', 'username', 'token', 'otp'] as const) {
      await expect(keys.resolve(itemRef, field)).rejects.toMatchObject({ failure: 'field-missing' })
    }
  })

  it('refuses references that are not its own', async () => {
    const { keys } = keysWith()
    for (const ref of ['op://valet/x', 'valet-key:', 'valet-key:not-a-uuid', 'valet-key:../x']) {
      await expect(keys.resolve(ref, 'ssh-key')).rejects.toBeInstanceOf(CredentialError)
      expect(await keys.info(ref)).toBeNull()
    }
  })

  it('refuses a label that could break the public line', async () => {
    const { keys } = keysWith()
    for (const label of ['', 'two words', 'a\nb', 'UPPER', 'x'.repeat(101), '-leading']) {
      await expect(keys.generate(label)).rejects.toBeInstanceOf(CredentialError)
    }
  })

  it('forgets one key, or every key', async () => {
    const { keys, keychain } = keysWith()
    const a = await keys.generate('a')
    const b = await keys.generate('b')
    await keys.forget(a.itemRef)
    await expect(keys.resolve(a.itemRef, 'ssh-key')).rejects.toMatchObject({ failure: 'not-found' })
    expect(await keys.info(b.itemRef)).not.toBeNull()
    await keys.forgetAll()
    expect(keychain.items()).toEqual([])
  })

  it('treats a damaged comment as no key info', async () => {
    const keychain = new MemoryKeychain({
      items: [
        {
          service: KEY_SERVICE,
          account: '2f1c6a2e-5d4b-4c3a-9b1e-0a1b2c3d4e5f',
          secret: 'x',
          comment: '{"v":1,"publicKey":"ssh-rsa AAAA evil","createdAt":"2026-11-17T00:00:00Z"}',
        },
      ],
    })
    const { keys } = keysWith(keychain)
    expect(await keys.info('valet-key:2f1c6a2e-5d4b-4c3a-9b1e-0a1b2c3d4e5f')).toBeNull()
  })

  it('is read by OpenSSH itself, where ssh-keygen is installed (the macOS runner)', async () => {
    let hasKeygen = true
    try {
      execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' })
    } catch (error) {
      hasKeygen = (error as { code?: string }).code !== 'ENOENT'
    }
    if (!hasKeygen) {
      expect(process.platform).not.toBe('darwin')
      return
    }
    const { keys } = keysWith()
    const info = await keys.generate('valet.test')
    const dir = mkdtempSync(join(tmpdir(), 'valet-key-'))
    try {
      const file = join(dir, 'id')
      const secret = await keys.resolve(info.itemRef, 'ssh-key')
      secret.reveal((pem) => writeFileSync(file, pem, { mode: 0o600 }))
      const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim()
      expect(derived.split(' ').slice(0, 2)).toEqual(info.publicKey.split(' ').slice(0, 2))
      writeFileSync(`${file}.pub`, `${info.publicKey}\n`)
      const fingerprint = execFileSync('ssh-keygen', ['-l', '-f', `${file}.pub`], { encoding: 'utf8' })
      expect(fingerprint).toContain(info.fingerprint)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
