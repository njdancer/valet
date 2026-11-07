import { CredentialError, MESSAGES_SECRET } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { OTP_POLL_MS } from '../src/secret-fill'
import {
  CANARY,
  EVIL,
  HASH,
  LOGIN,
  LOGIN_PAGE,
  MESSAGES_GRANT,
  manifestWithSteps,
  SENDER,
  START,
  unparsedWithSteps,
  WWW,
  world,
} from './fixtures'

// These flows type a code and stop. Every flow finishes with the probe, so tests that expect ok
// start with the auth partition's session cookie already set.

const TOTP = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  { op: 'otp', selector: '#otp', source: { secret: 'login' } },
])

const SMS = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  {
    op: 'otp',
    selector: '#otp',
    source: { messages: { sender: SENDER, pattern: 'code is (\\d{6})', maxAgeSeconds: 300 } },
  },
])

describe('otp from a 1Password TOTP field', () => {
  it('fills the code like any other secret', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = TOTP
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.provider.calls).toEqual([{ itemRef: 'op://valet/Shop', field: 'otp' }])
    expect(w.page.typed).toEqual([
      {
        selector: '#otp',
        url: LOGIN_PAGE,
        text: CANARY.otp,
        secret: true,
        delayMs: 40,
        allowedOrigins: [LOGIN],
      },
    ])
    expect(w.provider.issued[0]?.disposed).toBe(true)
  })

  it('audits the use with the otp field', async () => {
    const w = world()
    w.input.manifest = TOTP
    await runAuthFlow(w.input)
    expect(w.audit.events.find((e) => e.type === 'secret-used')).toEqual({
      type: 'secret-used',
      adapterId: 'shop',
      adapterHash: HASH,
      secret: 'login',
      field: 'otp',
      origin: LOGIN,
      callId: 'call-1',
    })
  })

  it('needs a grant like any other secret', async () => {
    const w = world()
    w.grants.grants.length = 0
    w.input.manifest = TOTP
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'not-granted',
    })
    expect(w.provider.calls).toEqual([])
  })

  it('refuses a manifest whose secret does not request the otp field', async () => {
    const w = world()
    w.input.manifest = {
      ...TOTP,
      secrets: { login: { description: 'Shop account', fields: ['username', 'password'], origins: [LOGIN] } },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
  })

  it('refuses to type the code into the search box', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'otp', selector: '#search', source: { secret: 'login' } },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expect(w.provider.calls).toEqual([])
  })

  it('does not apply the password form-action rule to codes', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.site[LOGIN_PAGE] = {
      elements: { '#otp': { inputType: 'text', autocomplete: 'one-time-code' } },
    }
    w.input.manifest = TOTP
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })
})

describe('otp from Messages', () => {
  it('waits for the code to arrive, then types it on the granted origins only', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.otpReader.messages.push({
      at: START + 3000,
      sender: 'ShopSMS',
      body: `Your Shop code is ${CANARY.sms}`,
    })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed).toEqual([
      {
        selector: '#otp',
        url: LOGIN_PAGE,
        text: CANARY.sms,
        secret: true,
        delayMs: 40,
        allowedOrigins: [LOGIN],
      },
    ])
    expect(w.clock.sleeps).toEqual([OTP_POLL_MS, OTP_POLL_MS, OTP_POLL_MS])
  })

  it('asks only for codes that arrived after the flow started', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START + 1000, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    w.clock.now = START
    await runAuthFlow(w.input)
    expect(w.otpReader.calls.length).toBeGreaterThan(0)
    expect(w.otpReader.calls.every((call) => call.notBefore.getTime() === START)).toBe(true)
  })

  it('passes the manifest sender, pattern and age through', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    await runAuthFlow(w.input)
    expect(w.otpReader.calls[0]?.query).toEqual({
      sender: 'ShopSMS',
      pattern: 'code is (\\d{6})',
      maxAgeSeconds: 300,
    })
  })

  it('refuses a Messages source that names no sender, before reading anything', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: 'anyone', body: `code is ${CANARY.sms}` })
    w.input.manifest = unparsedWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'otp',
        selector: '#otp',
        source: { messages: { pattern: 'code is (\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
    expect(w.otpReader.calls).toEqual([])
    expect(w.page.typed).toEqual([])
  })

  it('never reuses a code from before the flow started, and gives up at the flow deadline', async () => {
    const w = world()
    w.input.flowTimeoutMs = 5000
    w.otpReader.messages.push({ at: START - 30_000, sender: 'ShopSMS', body: 'code is 111111' })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'otp', errorClass: 'not-found' })
    expect(w.page.typed).toEqual([])
    expect(w.clock.now).toBe(START + 5000)
    expect(w.clock.sleeps).toEqual([OTP_POLL_MS, OTP_POLL_MS, OTP_POLL_MS, OTP_POLL_MS, OTP_POLL_MS])
  })

  it('ignores a code from another sender', async () => {
    const w = world()
    w.input.flowTimeoutMs = 3000
    w.otpReader.messages.push({ at: START + 500, sender: 'Mallory', body: 'code is 666666' })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'otp', errorClass: 'not-found' })
    expect(w.page.typed).toEqual([])
  })

  it('never sleeps past the flow deadline while polling', async () => {
    const w = world()
    w.input.flowTimeoutMs = 2500
    w.input.manifest = SMS
    await runAuthFlow(w.input)
    expect(w.clock.sleeps).toEqual([OTP_POLL_MS, OTP_POLL_MS, 500])
  })

  it('reports a locked reader at once, without polling', async () => {
    const w = world()
    w.otpReader.failWith = new CredentialError('locked')
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'otp', errorClass: 'locked' })
    expect(w.otpReader.calls).toHaveLength(1)
  })

  it('reports a reader without access to Messages as otp: unavailable', async () => {
    const w = world()
    w.otpReader.failWith = new CredentialError('unavailable')
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'otp', errorClass: 'unavailable' })
  })

  it('reports any other reader error as otp: internal', async () => {
    const w = world()
    vi.spyOn(w.otpReader, 'latest').mockRejectedValue(new Error('SQLITE_BUSY: chat.db is locked'))
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'otp', errorClass: 'internal' })
  })

  it('checks the target before reading Messages, so a refused fill reads nothing', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      frames: { ad: EVIL },
      elements: { '#otp': { inputType: 'text', autocomplete: 'one-time-code', frame: 'ad' } },
    }
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(w.otpReader.calls).toEqual([])
  })

  it('refuses an unsuitable element before reading Messages', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'otp',
        selector: '#search',
        source: { messages: { sender: SENDER, pattern: '(\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-unsuitable' })
    expect(w.otpReader.calls).toEqual([])
  })

  it('types a code on any navigation origin the Messages grant covers', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.site[`${WWW}/verify`] = { elements: { '#otp': { inputType: 'tel' } } }
    w.grants.grants[1] = { ...MESSAGES_GRANT, origins: [LOGIN, WWW] }
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: `${WWW}/verify` },
      {
        op: 'otp',
        selector: '#otp',
        source: { messages: { sender: SENDER, pattern: 'code is (\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.map((typed) => typed.allowedOrigins)).toEqual([[LOGIN, WWW]])
  })

  it('refuses a code on a granted origin that is not on the navigation allowlist', async () => {
    const w = world()
    const pay = 'https://pay.shop.test'
    w.grants.grants[1] = { ...MESSAGES_GRANT, origins: [pay] }
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    // The page is somehow on the granted origin; the navigation check would catch it too, so this
    // checks the origin set itself by letting only the history through.
    const committed = w.page.committedUrls.bind(w.page)
    vi.spyOn(w.page, 'committedUrls').mockImplementation(() =>
      committed().filter((url) => !url.startsWith(pay)),
    )
    w.page.site[`${pay}/verify`] = { elements: { '#otp': { inputType: 'tel' } } }
    w.page.navigate(`${pay}/verify`)
    w.input.manifest = manifestWithSteps([
      {
        op: 'otp',
        selector: '#otp',
        source: { messages: { sender: SENDER, pattern: 'code is (\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(w.otpReader.calls).toEqual([])
  })

  it('refuses a code on a requested origin the Messages grant does not cover', async () => {
    const w = world()
    w.grants.grants[1] = { ...MESSAGES_GRANT, origins: [WWW] }
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'origin-mismatch' })
    expect(w.otpReader.calls).toEqual([])
  })

  it('audits a code from Messages as the messages secret, on the origin it was typed', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.audit.events.find((e) => e.type === 'secret-used')).toEqual({
      type: 'secret-used',
      adapterId: 'shop',
      adapterHash: HASH,
      secret: MESSAGES_SECRET,
      field: 'otp',
      origin: LOGIN,
      callId: 'call-1',
    })
  })

  it('needs a Messages grant, and reads nothing without one', async () => {
    const w = world()
    w.grants.grants.splice(1, 1)
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'not-granted',
    })
    expect(w.otpReader.calls).toEqual([])
    expect(w.page.typed).toEqual([])
  })

  it('refuses a Messages grant for another sender, and reads nothing', async () => {
    const w = world()
    w.grants.grants[1] = { ...MESSAGES_GRANT, itemRef: 'BankSMS' }
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'not-granted',
    })
    expect(w.otpReader.calls).toEqual([])
  })

  it('compares the sender exactly, not by case or prefix', async () => {
    for (const itemRef of ['shopsms', 'ShopSMS ', 'Shop']) {
      const w = world()
      w.grants.grants[1] = { ...MESSAGES_GRANT, itemRef }
      w.input.manifest = SMS
      expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
      expect(w.otpReader.calls).toEqual([])
    }
  })

  it('refuses a grant under the messages name whose provider is not messages', async () => {
    const w = world()
    w.grants.grants[1] = { ...MESSAGES_GRANT, provider: 'onepassword-service-account' }
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expect(w.otpReader.calls).toEqual([])
  })

  it('refuses an empty sender even when the grant names an empty sender', async () => {
    const w = world()
    w.grants.grants[1] = { ...MESSAGES_GRANT, itemRef: '' }
    w.input.manifest = unparsedWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'otp',
        selector: '#otp',
        source: { messages: { sender: '', pattern: '(\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
    expect(w.otpReader.calls).toEqual([])
  })

  it('does not take a 1Password grant for another secret as a Messages grant', async () => {
    const w = world()
    w.grants.grants.splice(1, 1)
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    vi.spyOn(w.grants, 'find').mockResolvedValue(w.grants.grants[0] ?? null)
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expect(w.otpReader.calls).toEqual([])
  })

  it('does not accept a Messages grant made for another adapter hash', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    vi.spyOn(w.grants, 'find').mockResolvedValue({ ...MESSAGES_GRANT, adapterHash: 'f'.repeat(64) })
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-granted' })
    expect(w.otpReader.calls).toEqual([])
  })

  it('refuses a manifest that declares its own secret named messages, which the schema would refuse', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = {
      ...SMS,
      secrets: {
        ...SMS.secrets,
        messages: { description: 'Not really Messages', fields: ['otp'], origins: [LOGIN] },
      },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'invalid',
    })
    expect(w.otpReader.calls).toEqual([])
  })

  it('aborts when the page leaves the allowlist while waiting for the code', async () => {
    const w = world()
    w.clock.onSleep = () => {
      if (w.clock.now === START + 2 * OTP_POLL_MS) w.page.navigate(`${EVIL}/`)
    }
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.otpReader.calls).toHaveLength(3)
  })

  it('stops when the page is blocked while waiting for the code', async () => {
    const w = world()
    w.page.site['https://www.shop.test/denied'] = { blocked: true }
    w.clock.onSleep = () => w.page.navigate('https://www.shop.test/denied')
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
  })

  it('checks the target again once the code arrives, and disposes it when refused', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START + 1000, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.page.site[`${WWW}/`] = {}
    w.clock.onSleep = () => w.page.navigate(`${WWW}/`)
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'element-missing',
    })
    expect(w.page.typed).toEqual([])
    expect(w.otpReader.issued).toHaveLength(1)
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })

  it('refuses a code that arrives after the page bounced through another host and came back', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.otpReader.beforeRead = () => {
      w.page.navigate(`${EVIL}/x`)
      w.page.navigate(LOGIN_PAGE)
    }
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
    expect(w.page.typed).toEqual([])
    expect(w.audit.events.filter((e) => e.type === 'secret-used')).toEqual([])
    expect(w.otpReader.issued).toHaveLength(1)
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })

  it('refuses a code that arrives after a bounce during a poll', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START + 1000, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.clock.onSleep = () => {
      w.page.navigate(`${EVIL}/x`)
      w.page.navigate(LOGIN_PAGE)
    }
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.page.typed).toEqual([])
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })

  it('drops granted origins that are off the navigation allowlist from where the code may go', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.grants.grants[1] = { ...MESSAGES_GRANT, origins: [EVIL, LOGIN, 'https://*.shop.test'] }
    w.otpReader.messages.push({ at: START, sender: SENDER, body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.map((typed) => typed.allowedOrigins)).toEqual([[LOGIN]])
  })

  it('hands the runtime a copy of the code for redaction', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: SENDER, body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    await runAuthFlow(w.input)
    expect(w.remembered).toHaveLength(1)
    expect(w.remembered[0]?.occursIn(`your code ${CANARY.sms}`)).toBe(true)
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })

  it('stops typing the code if the page navigates partway through it', async () => {
    const w = world()
    w.page.site[`${WWW}/verify`] = structuredClone(w.page.site[LOGIN_PAGE]!)
    w.page.beforeKeystroke = (index) => {
      if (index === 2) w.page.navigate(`${WWW}/verify`)
    }
    w.otpReader.messages.push({ at: START, sender: SENDER, body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(w.page.typed.map((typed) => typed.text)).toEqual([CANARY.sms.slice(0, 2)])
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })

  it('disposes the code after typing it', async () => {
    const w = world()
    w.otpReader.messages.push({ at: START, sender: 'ShopSMS', body: `code is ${CANARY.sms}` })
    w.input.manifest = SMS
    await runAuthFlow(w.input)
    expect(w.otpReader.issued[0]?.disposed).toBe(true)
  })
})
