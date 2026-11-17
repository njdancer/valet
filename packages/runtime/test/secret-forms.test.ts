import { SecretValue, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { REDACTED, redactOutput, SecretRedactionSet, sensitiveMatcher } from '../src/redaction'
import { encodedForms } from '../src/secret-forms'

const SECRET = 'hunter2-Correct-Horse-Battery!'

function matcherFor(...secrets: string[]) {
  const set = new SecretRedactionSet()
  for (const s of secrets) {
    const value = SecretValue.fromString(s)
    set.register(value)
    value.dispose()
  }
  return { set, sensitive: sensitiveMatcher([], set) }
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64')
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const hex = (s: string) => Buffer.from(s).toString('hex')

describe('encoded copies of a secret', () => {
  const { sensitive } = matcherFor(SECRET)

  const encodings: [string, string][] = [
    ['plain', SECRET],
    ['base64', b64(SECRET)],
    ['base64 without padding', b64(SECRET).replace(/=+$/, '')],
    ['base64url', b64url(SECRET)],
    ['hex', hex(SECRET)],
    ['HEX', hex(SECRET).toUpperCase()],
    ['encodeURIComponent', encodeURIComponent(SECRET)],
    ['every byte percent-encoded', [...Buffer.from(SECRET)].map((b) => `%${b.toString(16)}`).join('')],
    [
      'every byte percent-encoded, upper case',
      [...Buffer.from(SECRET)].map((b) => `%${b.toString(16).toUpperCase()}`).join(''),
    ],
    ['reversed', [...SECRET].reverse().join('')],
    ['\\u escapes', [...SECRET].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')],
    [
      '\\u escapes, upper case',
      [...SECRET].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join(''),
    ],
  ]

  it.each(encodings)('finds the %s form on its own and inside other text', (_, form) => {
    expect(sensitive(form)).toBe(true)
    expect(sensitive(`prefix ${form} suffix`)).toBe(true)
  })

  it.each([0, 1, 2, 3, 4, 5])(
    'finds it inside a longer string base64-encoded as a whole, offset %i',
    (offset) => {
      const before = 'x'.repeat(offset)
      for (const after of ['', 'y', 'yy', 'yyy and more']) {
        const whole = `${before}${SECRET}${after}`
        expect(sensitive(b64(whole)), `${offset}/${after.length}`).toBe(true)
        expect(sensitive(b64url(whole)), `${offset}/${after.length} url`).toBe(true)
      }
    },
  )

  it('finds it in a JSON document that was encoded as a whole', () => {
    expect(sensitive(b64(JSON.stringify({ user: 'nick', password: SECRET, n: 1 })))).toBe(true)
  })

  it('leaves unrelated text alone', () => {
    for (const text of [
      'hello world',
      b64('hello world'),
      hex('hunter3'),
      'Correct Horse',
      SECRET.slice(0, 10),
    ]) {
      expect(sensitive(text), text).toBe(false)
    }
  })
})

describe('a secret with characters that encode differently', () => {
  const tricky = 'pa ss"wörd\\/+?&=日本'
  const { sensitive } = matcherFor(tricky)

  it.each([
    ['URL form encoding', encodeURIComponent(tricky).replaceAll('%20', '+')],
    ['URL encoding', encodeURIComponent(tricky)],
    ['JSON escaping', JSON.stringify(tricky).slice(1, -1)],
    ['base64', b64(tricky)],
    ['hex', hex(tricky)],
    ['reversed', [...tricky].reverse().join('')],
  ])('finds the %s form', (_, form) => {
    expect(sensitive(form)).toBe(true)
  })

  it('survives redactOutput’s own JSON check', () => {
    expect(redactOutput({ a: `x${tricky}y` }, sensitive)).toEqual({ a: REDACTED })
  })
})

describe('a multi-line secret (an SSH key)', () => {
  const body = Array.from(
    { length: 5 },
    (_, i) => `${'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop'.slice(i)}0123456789+/`,
  )
  const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
  const { sensitive } = matcherFor(key)

  it('finds any one long line of it, and the lines run together', () => {
    for (const line of body) expect(sensitive(`... ${line} ...`), line).toBe(true)
    expect(sensitive(body.join(''))).toBe(true)
    expect(sensitive(key.replace(/\n/g, '\r\n'))).toBe(true)
  })

  it('does not match the armour lines every key shares', () => {
    expect(sensitive('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(false)
  })
})

describe('redactOutput with encoded secrets', () => {
  it('redacts each string that holds an encoding, keys included', () => {
    const { sensitive } = matcherFor(SECRET)
    const out = redactOutput(
      {
        ok: 'fine',
        leak: b64(SECRET),
        nested: [{ x: hex(SECRET) }, `?q=${encodeURIComponent(SECRET)}`],
        [b64url(SECRET)]: 1,
      },
      sensitive,
    )
    expect(JSON.stringify(out)).not.toContain(b64(SECRET).slice(0, 12))
    expect(out).toMatchObject({ ok: 'fine', leak: REDACTED, nested: [{ x: REDACTED }, REDACTED] })
    expect(Object.keys(out as object)).toContain(REDACTED)
  })

  it('catches an encoding split across two strings only by the whole-output check', () => {
    const { sensitive } = matcherFor(SECRET)
    const hexed = hex(SECRET)
    // Each half alone is not the secret; the serialised whole has them apart, so this is not caught.
    expect(() => redactOutput({ a: hexed.slice(0, 20), b: hexed.slice(20) }, sensitive)).not.toThrow()
  })

  it('throws rather than send anything if a form survives redaction', () => {
    const { sensitive } = matcherFor(SECRET)
    // A toJSON that hides the secret from the per-string pass can't: the plain JSON is redacted.
    expect(redactOutput({ toJSON: () => ({ v: b64(SECRET) }) }, sensitive)).toEqual({ v: REDACTED })
  })

  it('refuses output that is not plain JSON rather than guess at it', () => {
    const { sensitive } = matcherFor(SECRET)
    expect(() => redactOutput({ bytes: Buffer.from(SECRET) }, sensitive)).toThrow(ValetError)
  })
})

describe('the forms’ lifetime', () => {
  it('zeroes every form when the set is disposed', () => {
    const { set, sensitive } = matcherFor(SECRET)
    expect(sensitive(b64(SECRET))).toBe(true)
    set.dispose()
    expect(sensitive(b64(SECRET))).toBe(false)
    expect(sensitive(SECRET)).toBe(false)
  })

  it('hands back forms the caller owns, never the plain value, and not for a disposed secret', () => {
    const value = SecretValue.fromString(SECRET)
    const forms = encodedForms(value)
    expect(forms.length).toBeGreaterThan(5)
    expect(forms.every((f) => !f.value.disposed)).toBe(true)
    expect(forms.some((f) => f.value.reveal((v) => v === SECRET))).toBe(false)
    for (const f of forms) f.value.dispose()
    value.dispose()
    expect(() => encodedForms(value)).toThrow()
  })

  it('fails closed for a value it can no longer read', () => {
    const value = SecretValue.fromString(SECRET)
    value.dispose()
    const set = new SecretRedactionSet()
    set.register(value)
    expect(sensitiveMatcher([], set)('anything at all')).toBe(true)
  })

  it('drops base64 fragments too short to be the secret rather than chance', () => {
    const { sensitive } = matcherFor('abcd')
    // Shifted fragments of a four-character secret's base64 are shorter than six characters and
    // are not kept, so ordinary base64 passes; the secret encoded on its own is still found.
    expect(sensitive(b64('xxxx hello'))).toBe(false)
    expect(sensitive(b64('abcd'))).toBe(true)
  })
})
