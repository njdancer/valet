import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { SecretValue } from '../src/secret'

describe('SecretValue', () => {
  it('reveals its plaintext only inside reveal()', () => {
    const secret = SecretValue.fromString('hunter2')
    expect(secret.reveal((plaintext) => plaintext.length)).toBe(7)
  })

  it('never stringifies, serialises or inspects to its contents', () => {
    const secret = SecretValue.fromString('hunter2')
    expect(String(secret)).toBe('[secret]')
    expect(`${secret}`).toBe('[secret]')
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}')
    expect(inspect(secret)).toBe('[secret]')
    expect(inspect({ nested: { secret } })).not.toContain('hunter2')
  })

  it('has no enumerable properties that could leak the value', () => {
    const secret = SecretValue.fromString('hunter2')
    expect(Object.keys(secret)).toEqual([])
    expect(JSON.stringify(Object.entries(secret))).not.toContain('hunter2')
  })

  it('zeroes the bytes it owns on dispose', () => {
    const buffer = Buffer.from('hunter2', 'utf8')
    const secret = SecretValue.fromBuffer(buffer)
    secret.dispose()
    expect([...buffer].every((byte) => byte === 0)).toBe(true)
    expect(secret.disposed).toBe(true)
  })

  it('refuses to reveal once disposed', () => {
    const secret = SecretValue.fromString('hunter2')
    secret.dispose()
    expect(() => secret.reveal((p) => p)).toThrow('secret already disposed')
  })

  it('can be disposed twice', () => {
    const secret = SecretValue.fromString('hunter2')
    secret.dispose()
    expect(() => secret.dispose()).not.toThrow()
  })

  it('detects its own occurrence in text, for redaction', () => {
    const secret = SecretValue.fromString('hunter2')
    expect(secret.occursIn('the password is hunter2!')).toBe(true)
    expect(secret.occursIn('nothing here')).toBe(false)
  })

  it('reports no occurrence once disposed or when empty', () => {
    const disposed = SecretValue.fromString('hunter2')
    disposed.dispose()
    expect(disposed.occursIn('hunter2')).toBe(false)
    expect(SecretValue.fromString('').occursIn('anything')).toBe(false)
  })

  it('reveals one character at a time, including multi-byte ones', async () => {
    const secret = SecretValue.fromString('aé€😀z')
    const seen: string[] = []
    await secret.revealEach(async (character) => {
      seen.push(character)
    })
    expect(seen).toEqual(['a', 'é', '€', '😀', 'z'])
  })

  it('stops revealing characters once disposed mid-way', async () => {
    const secret = SecretValue.fromString('abc')
    const seen: string[] = []
    await expect(
      secret.revealEach(async (character) => {
        seen.push(character)
        secret.dispose()
      }),
    ).rejects.toThrow('secret already disposed')
    expect(seen).toEqual(['a'])
    await expect(secret.revealEach(async () => {})).rejects.toThrow('secret already disposed')
  })

  it('clones into an independent copy that survives the original being disposed', () => {
    const secret = SecretValue.fromString('hunter2')
    const copy = secret.clone()
    secret.dispose()
    expect(copy.occursIn('the password is hunter2')).toBe(true)
    copy.dispose()
    expect(() => copy.clone()).toThrow('secret already disposed')
  })
})
