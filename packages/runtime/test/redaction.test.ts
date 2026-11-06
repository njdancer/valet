import { SecretValue } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { REDACTED, redactDeep, redactString, SecretRedactionSet, sensitiveMatcher } from '../src/redaction'

const cookie = 'wow-session-3f9a1c7e2b'

describe('sensitiveMatcher', () => {
  it('matches a string containing a cookie value anywhere', () => {
    const sensitive = sensitiveMatcher([cookie], new SecretRedactionSet())
    expect(sensitive(cookie)).toBe(true)
    expect(sensitive(`token=${cookie};`)).toBe(true)
    expect(sensitive('nothing here')).toBe(false)
  })

  it('matches exactly, not case-insensitively', () => {
    const sensitive = sensitiveMatcher([cookie], new SecretRedactionSet())
    expect(sensitive(cookie.toUpperCase())).toBe(false)
  })

  it('ignores short cookie values that are flags, not credentials', () => {
    const sensitive = sensitiveMatcher(['1', 'en-AU', ''], new SecretRedactionSet())
    expect(sensitive('Pack of 1, en-AU')).toBe(false)
  })

  it('matches a remembered secret', () => {
    const secrets = new SecretRedactionSet()
    secrets.remember(SecretValue.fromString('canary-pa55word'))
    const sensitive = sensitiveMatcher([], secrets)

    expect(sensitive('my password is canary-pa55word ok')).toBe(true)
    expect(sensitive('canary-pa55wor')).toBe(false)
  })
})

describe('SecretRedactionSet', () => {
  it('forgets secrets once they are disposed', () => {
    const secrets = new SecretRedactionSet()
    const secret = SecretValue.fromString('canary-pa55word')
    secrets.remember(secret)
    expect(secrets.size).toBe(1)

    secret.dispose()
    expect(secrets.occursIn('canary-pa55word')).toBe(false)
    expect(secrets.size).toBe(0)
  })
})

describe('redactString', () => {
  it('replaces the whole string, not just the match', () => {
    const sensitive = sensitiveMatcher([cookie], new SecretRedactionSet())
    expect(redactString(`prefix ${cookie} suffix`, sensitive)).toBe(REDACTED)
    expect(redactString('clean', sensitive)).toBe('clean')
  })
})

describe('redactDeep', () => {
  const sensitive = sensitiveMatcher([cookie], new SecretRedactionSet())

  it('walks nested arrays and objects', () => {
    const output = {
      items: [{ name: 'Milk', note: `see ${cookie}` }, { name: 'Bread' }],
      count: 2,
      ok: true,
      missing: null,
    }
    expect(redactDeep(output, sensitive)).toEqual({
      items: [{ name: 'Milk', note: REDACTED }, { name: 'Bread' }],
      count: 2,
      ok: true,
      missing: null,
    })
  })

  it('does not change its input', () => {
    const output = { note: cookie }
    redactDeep(output, sensitive)
    expect(output).toEqual({ note: cookie })
  })

  it('redacts object keys, keeping colliding keys apart', () => {
    const output = { [cookie]: 1, [`x${cookie}`]: 2, [`${REDACTED}-2`]: 3 }
    expect(redactDeep(output, sensitive)).toEqual({
      [REDACTED]: 1,
      [`${REDACTED}-2`]: 2,
      [`${REDACTED}-2-2`]: 3,
    })
  })

  it('treats a __proto__ key as data, not a prototype', () => {
    const output = JSON.parse(`{"__proto__": {"polluted": "${cookie}"}}`)
    const redacted = redactDeep(output, sensitive) as Record<string, unknown>

    expect(Object.hasOwn(redacted, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('walks Maps and Sets', () => {
    const output = { map: new Map([[cookie, cookie]]), set: new Set([cookie, 'ok']) }
    expect(redactDeep(output, sensitive)).toEqual({
      map: new Map([[REDACTED, REDACTED]]),
      set: new Set([REDACTED, 'ok']),
    })
  })

  it('walks objects with a null prototype', () => {
    const output = Object.assign(Object.create(null), { note: cookie })
    expect(redactDeep(output, sensitive)).toEqual({ note: REDACTED })
  })

  it('cuts cycles', () => {
    const output: Record<string, unknown> = { name: 'loop' }
    output['self'] = output
    expect(redactDeep(output, sensitive)).toEqual({ name: 'loop', self: REDACTED })
  })

  it('keeps shared references that are not cycles', () => {
    const shared = { note: cookie }
    expect(redactDeep({ a: shared, b: shared }, sensitive)).toEqual({
      a: { note: REDACTED },
      b: { note: REDACTED },
    })
  })

  it('leaves non-plain objects such as dates alone', () => {
    const at = new Date(0)
    expect(redactDeep({ at }, sensitive)).toEqual({ at })
  })

  it('redacts a top-level string', () => {
    expect(redactDeep(cookie, sensitive)).toBe(REDACTED)
  })
})
