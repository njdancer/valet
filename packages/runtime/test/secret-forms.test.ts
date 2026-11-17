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
    // The value itself appears only as its caseless form; the set keeps the exact clone itself.
    expect(forms.filter((f) => f.value.reveal((v) => v === SECRET)).map((f) => f.ignoreCase)).toEqual([true])
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

describe('red team B4 and B5: the forms that slipped past the first cut', () => {
  const TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUv/+x~!'
  const { sensitive } = matcherFor(TOKEN)
  const leaks: [string, string][] = [
    ['upper-cased', TOKEN.toUpperCase()],
    ['reversed and upper-cased', [...TOKEN].reverse().join('').toUpperCase()],
    [
      'full-width',
      [...TOKEN]
        .map((c) => (c >= '!' && c <= '~' ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c))
        .join(''),
    ],
    ['zero-width spaces between characters', [...TOKEN].join('​')],
    [
      'MIME base64 wrapped at 76',
      (b64(`prefix ${TOKEN} and a long tail to wrap`).match(/.{1,76}/g) ?? []).join('\r\n'),
    ],
    ['base64 of UTF-16LE', Buffer.from(TOKEN, 'utf16le').toString('base64')],
    ['base64 twice', b64(b64(TOKEN))],
    [
      'lower-case percent escapes',
      [...Buffer.from(TOKEN)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''),
    ],
    ['URLSearchParams encoding', new URLSearchParams({ q: TOKEN }).toString()],
    ['double percent-encoding', encodeURIComponent(encodeURIComponent(TOKEN))],
    ['PHP slash escaping', TOKEN.replaceAll('/', '\\/')],
    ['HTML numeric entities', [...TOKEN].map((c) => `&#${c.charCodeAt(0)};`).join('')],
    ['hex entities', [...TOKEN].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join('')],
    ['one character dropped from each end', TOKEN.slice(1, -1)],
    ['the middle 24 characters', TOKEN.slice(8, 32)],
  ]

  it.each(leaks)('catches the %s form', (_, form) => {
    expect(sensitive(form)).toBe(true)
  })

  it('catches a secret split across two values: each long half is redacted, else the call fails', () => {
    for (const cut of [4, 12, 20, 30]) {
      const out = redactOutput({ a: TOKEN.slice(0, cut), b: TOKEN.slice(cut) }, sensitive) as Record<
        string,
        string
      >
      expect(`${out['a']}${out['b']}`).not.toContain(TOKEN.slice(cut - 4, cut + 4))
    }
    // A secret too short for windows, split in two, fails the call.
    const { sensitive: s } = matcherFor('short-secret-20chars')
    expect(() => redactOutput(['short-secret', '-20chars'], s)).toThrow(ValetError)
  })

  it('catches a password the way Python’s json.dumps escapes it, and in NFD', () => {
    const { sensitive: s } = matcherFor('päss-wörd-ünïcode')
    expect(
      s(
        JSON.stringify('päss-wörd-ünïcode').replace(
          /[^\x00-\x7f]/g,
          (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
        ),
      ),
    ).toBe(true)
    expect(s('päss-wörd-ünïcode'.normalize('NFD'))).toBe(true)
    expect(s(Buffer.from('päss-wörd-ünïcode', 'latin1').toString('base64'))).toBe(true)
  })

  it('catches an SSH key rewrapped at 64 columns', () => {
    const bodyText =
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBbc2VjcmV0LWtleS1tYXRlcmlhbC1oZXJlXQ'
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${(bodyText.match(/.{1,70}/g) ?? []).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
    const { sensitive: s } = matcherFor(pem)
    const rewrapped = (bodyText.match(/.{1,64}/g) ?? []).join('\n')
    expect(s(rewrapped)).toBe(true)
    expect(s(bodyText.slice(10, 40))).toBe(true)
  })

  it('doesn’t fail a call because a short secret is part of the redaction marker', () => {
    const { sensitive: s } = matcherFor('acted')
    expect(redactOutput({ a: 'this was acted on', b: 'fine' }, s)).toEqual({ a: REDACTED, b: 'fine' })
  })

  it('still leaves ordinary text alone', () => {
    for (const text of [
      'hello world',
      'Mail from nick@icloud.example',
      b64('an unrelated document body'),
      '%20%2F',
    ]) {
      expect(sensitive(text), text).toBe(false)
    }
  })
})
