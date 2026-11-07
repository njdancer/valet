import { SecretValue, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  REDACTED,
  redactDeep,
  redactOutput,
  redactString,
  SecretRedactionSet,
  sensitiveMatcher,
} from '../src/redaction'

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

  it('with ignoreCase, matches session values whatever their case', () => {
    const sensitive = sensitiveMatcher(['Sess-AbCdEf123'], new SecretRedactionSet(), { ignoreCase: true })
    expect(sensitive('https://sess-abcdef123.evil.test/')).toBe(true)
    expect(sensitive('https://SESS-ABCDEF123.evil.test/')).toBe(true)
    expect(sensitive('https://www.example.com/')).toBe(false)
  })

  it('with ignoreCase, still matches secrets exactly, since a SecretValue cannot be folded unrevealed', () => {
    const secrets = new SecretRedactionSet()
    secrets.register(SecretValue.fromString('Canary-Pa55word'))
    const sensitive = sensitiveMatcher([], secrets, { ignoreCase: true })

    expect(sensitive('x Canary-Pa55word x')).toBe(true)
    expect(sensitive('x canary-pa55word x')).toBe(false)
  })

  it('ignores short session values that are flags, not credentials', () => {
    const sensitive = sensitiveMatcher(['1', 'en-AU', ''], new SecretRedactionSet())
    expect(sensitive('Pack of 1, en-AU')).toBe(false)
  })

  it('matches a registered secret', () => {
    const secrets = new SecretRedactionSet()
    secrets.register(SecretValue.fromString('canary-pa55word'))
    const sensitive = sensitiveMatcher([], secrets)

    expect(sensitive('my password is canary-pa55word ok')).toBe(true)
    expect(sensitive('canary-pa55wor')).toBe(false)
  })
})

describe('SecretRedactionSet', () => {
  it('keeps matching a secret after the auth flow disposes its own copy', () => {
    const secrets = new SecretRedactionSet()
    const secret = SecretValue.fromString('canary-pa55word')
    secrets.register(secret)
    secret.dispose()

    expect(secrets.occursIn('canary-pa55word')).toBe(true)
    expect(secrets.size).toBe(1)
  })

  it('forgets every secret once the call ends, and ignores registrations after that', () => {
    const secrets = new SecretRedactionSet()
    secrets.register(SecretValue.fromString('canary-pa55word'))
    secrets.dispose()
    secrets.register(SecretValue.fromString('late-canary-91'))

    expect(secrets.occursIn('canary-pa55word late-canary-91')).toBe(false)
    expect(secrets.size).toBe(0)
  })

  it('treats everything as sensitive once it was handed a secret it could not keep', () => {
    const secrets = new SecretRedactionSet()
    const gone = SecretValue.fromString('canary-pa55word')
    gone.dispose()
    secrets.register(gone)

    expect(secrets.occursIn('anything at all')).toBe(true)
  })

  it('treats a value that is not a SecretValue as one it could not keep', () => {
    const secrets = new SecretRedactionSet()
    secrets.register('canary-pa55word' as never)
    expect(secrets.occursIn('Milk')).toBe(true)
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
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('walks objects with a null prototype', () => {
    const output = Object.assign(Object.create(null), { note: cookie })
    expect(redactDeep(output, sensitive)).toEqual({ note: REDACTED })
  })

  it('redacts a top-level string', () => {
    expect(redactDeep(cookie, sensitive)).toBe(REDACTED)
  })
})

// Each of these is a way tool code could hand back a cookie that a walk over "plain objects only"
// would miss. Every one must come out redacted, or not come out at all.
describe('redactOutput', () => {
  const sensitive = sensitiveMatcher([cookie], new SecretRedactionSet())
  const fails = (value: unknown, errorClass: string) => {
    let thrown: unknown
    try {
      redactOutput(value, sensitive)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ValetError)
    expect(thrown).toMatchObject({ stage: 'tool-output', errorClass })
  }

  it('redacts a cookie held by a class instance', () => {
    class Box {
      constructor(readonly v: string) {}
    }
    expect(redactOutput({ a: new Box(cookie) }, sensitive)).toEqual({ a: { v: REDACTED } })
  })

  it('redacts what a toJSON function returns, not the function', () => {
    expect(redactOutput({ b: { toJSON: () => cookie } }, sensitive)).toEqual({ b: REDACTED })
  })

  it('redacts a getter’s value, reading it only once', () => {
    let reads = 0
    const output = {
      get note() {
        reads++
        return reads === 1 ? cookie : 'harmless'
      },
    }
    expect(redactOutput(output, sensitive)).toEqual({ note: REDACTED })
    expect(reads).toBe(1)
  })

  it('refuses Buffers and typed arrays, whose bytes no string match can see', () => {
    fails({ buf: Buffer.from(cookie) }, 'invalid')
    fails([new Uint8Array(Buffer.from(cookie))], 'invalid')
    fails(new TextEncoder().encode(cookie).buffer, 'invalid')
  })

  it('redacts a cookie in an Error’s own enumerable properties and drops the rest', () => {
    const error = Object.assign(new Error(cookie), { detail: cookie })
    expect(redactOutput({ error }, sensitive)).toEqual({ error: { detail: REDACTED } })
  })

  it('redacts a cookie reached through a prototype-created object', () => {
    const output = Object.create({ inherited: cookie }, { own: { value: cookie, enumerable: true } })
    expect(redactOutput(output, sensitive)).toEqual({ own: REDACTED })
  })

  it('turns Maps and Sets into what the transport would send', () => {
    expect(redactOutput({ map: new Map([[cookie, cookie]]), set: new Set([cookie]) }, sensitive)).toEqual({
      map: {},
      set: {},
    })
  })

  it('keeps dates as their ISO strings', () => {
    expect(redactOutput({ at: new Date(0) }, sensitive)).toEqual({ at: '1970-01-01T00:00:00.000Z' })
  })

  it('refuses output with a cycle', () => {
    const output: { self?: unknown } = {}
    output.self = output
    fails(output, 'invalid')
  })

  it('refuses output that cannot be serialised', () => {
    fails({ n: 1n }, 'invalid')
    fails(
      {
        get boom() {
          throw new Error(cookie)
        },
      },
      'invalid',
    )
    fails(
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('trap')
          },
        },
      ),
      'invalid',
    )
  })

  it('returns undefined for output with nothing to serialise', () => {
    expect(redactOutput(undefined, sensitive)).toBeUndefined()
    expect(redactOutput(() => cookie, sensitive)).toBeUndefined()
  })

  it('fails closed if anything sensitive survives redaction', () => {
    // A matcher that only recognises the needle in the serialised whole stands in for a value the
    // per-string pass cannot see.
    const wholeOnly = (text: string) => text.startsWith('{') && text.includes('a","b')
    let thrown: unknown
    try {
      redactOutput({ x: ['a', 'b'] }, wholeOnly)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ stage: 'tool-output', errorClass: 'internal' })
  })

  it('does not change its input', () => {
    const output = { note: cookie, nested: { note: cookie } }
    redactOutput(output, sensitive)
    expect(output).toEqual({ note: cookie, nested: { note: cookie } })
  })
})
