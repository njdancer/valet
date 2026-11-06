// Canary tests: seed unique secrets, run flows that succeed and flows that fail in every way that
// touches a secret, and scan everything that leaves the interpreter for them. The page is the one
// place a canary may reach, and only as a SecretValue.

import { inspect } from 'node:util'
import { CredentialError, type SecretValue } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { CANARY, EVIL, LOGIN_PAGE, manifestWithSteps, START, world } from './fixtures'

type World = ReturnType<typeof world>

const ALL_CANARIES = Object.values(CANARY)

/** The full flow: username, password, a TOTP code and an SMS code. */
const EVERY_SECRET = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
  { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
  { op: 'otp', selector: '#otp', source: { secret: 'login' } },
  {
    op: 'otp',
    selector: '#otp',
    source: { messages: { sender: 'ShopSMS', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 } },
  },
  { op: 'click', selector: '#submit' },
  { op: 'assertLoggedIn' },
])

function arrange(w: World): void {
  w.input.manifest = EVERY_SECRET
  w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `Your Shop code is ${CANARY.sms}` })
}

/** Each scenario breaks the flow in one way, after at least one secret is in play where possible. */
const SCENARIOS: Record<string, (w: World) => void> = {
  'a successful login': () => {},
  'typing fails with the secret in the error': (w) => {
    vi.spyOn(w.page, 'type').mockImplementation(async (text: string | SecretValue) => {
      throw new Error(`could not type ${typeof text === 'string' ? text : text.reveal((p) => p)}`)
    })
  },
  'focus fails after the secret is resolved': (w) => {
    vi.spyOn(w.page, 'focus').mockRejectedValue(new Error(`focus failed near ${CANARY.username}`))
  },
  'the provider fails with the secret in the error': (w) => {
    vi.spyOn(w.provider, 'resolve').mockRejectedValue(new Error(`op read failed: ${CANARY.password}`))
  },
  'the provider throws a CredentialError subclass carrying the secret': (w) => {
    class LeakyError extends CredentialError {
      readonly value = CANARY.password
    }
    vi.spyOn(w.provider, 'resolve').mockRejectedValue(new LeakyError('locked'))
  },
  'the Messages reader fails with the code in the error': (w) => {
    vi.spyOn(w.otpReader, 'latest').mockRejectedValue(new Error(`row: ${CANARY.sms}`))
  },
  'the audit log fails on a secret use, with the secret in the error': (w) => {
    const append = w.audit.append.bind(w.audit)
    vi.spyOn(w.audit, 'append').mockImplementation(async (event) => {
      if (event.type === 'secret-used' && event.field === 'password') throw new Error(CANARY.password)
      return append(event)
    })
  },
  'the probe fails with the secret in the error': (w) => {
    w.input.probe = async () => {
      throw new Error(`probe saw ${CANARY.password} in the page`)
    }
  },
  'the probe says not logged in': (w) => {
    w.input.probe = async () => false
  },
  'the page moves off the allowlist after the password is typed': (w) => {
    w.page.site[LOGIN_PAGE] = {
      ...w.page.site[LOGIN_PAGE],
      clicks: { '#submit': `${EVIL}/?leaked=${CANARY.password}` },
    }
  },
  'the page moves to an attacker clone while the secret is resolved': (w) => {
    w.page.site[`${EVIL}/login`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.provider.beforeResolve = () => w.page.navigate(`${EVIL}/login`)
  },
  'the site blocks after the password is typed': (w) => {
    w.page.site['https://www.shop.test/account'] = { blocked: true }
  },
  'the flow times out while waiting for the SMS': (w) => {
    w.otpReader.messages.length = 0
    w.input.flowTimeoutMs = 3000
  },
  'the page reports the secret in its text and an error': (w) => {
    vi.spyOn(w.page, 'textPresent').mockRejectedValue(new Error(`page text: ${CANARY.password}`))
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      { op: 'waitFor', condition: { textPresent: 'Welcome' }, timeoutMs: 1000 },
    ])
  },
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const

describe('canaries', () => {
  let logged: unknown[][] = []

  beforeEach(() => {
    logged = []
    for (const method of CONSOLE_METHODS) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  for (const [name, breakIt] of Object.entries(SCENARIOS)) {
    it(`${name}: no canary leaves the interpreter`, async () => {
      const w = world()
      arrange(w)
      breakIt(w)

      let outcome: unknown
      let thrown: unknown = null
      try {
        outcome = await runAuthFlow(w.input)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeNull()
      const escaped = [outcome, w.audit.events, logged, w.page.visited, w.page.clicked, w.page.handedToUser]
      const text = [
        JSON.stringify(escaped),
        inspect(escaped, { depth: Number.POSITIVE_INFINITY }),
        String(outcome),
      ]
      for (const canary of ALL_CANARIES) {
        for (const view of text) expect(view).not.toContain(canary)
      }
      // A canary may reach the page, and only as a SecretValue.
      for (const typed of w.page.typed) {
        if (ALL_CANARIES.some((canary) => typed.text.includes(canary))) expect(typed.secret).toBe(true)
      }
      expect([...w.provider.issued, ...w.otpReader.issued].every((secret) => secret.disposed)).toBe(true)
    })
  }

  it('is not vacuous: the successful login really typed every canary', async () => {
    const w = world()
    arrange(w)
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.map((t) => t.text)).toEqual([
      CANARY.username,
      CANARY.password,
      CANARY.otp,
      CANARY.sms,
    ])
    expect(w.page.typed.every((t) => t.secret)).toBe(true)
  })

  it('is not vacuous: the leaky scenarios really carried canaries in their errors', async () => {
    const w = world()
    arrange(w)
    SCENARIOS['the provider fails with the secret in the error']?.(w)
    await expect(w.provider.resolve('op://siteadapter/Shop', 'password')).rejects.toThrow(CANARY.password)
  })
})
