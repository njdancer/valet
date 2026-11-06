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
})
