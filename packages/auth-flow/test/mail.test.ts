// Email sign-in in the interpreter (docs/imap.md#email-sign-in): a code typed from a sign-in mail,
// and a mailed link opened in the auth partition. Both need the person's mail grant for that sender,
// and a link is a login secret: audited, kept for redaction, and opened only on its own origin.

import {
  CredentialError,
  type Grant,
  MAIL_SECRET,
  type MailReader,
  type MailSignInQuery,
  SecretValue,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { MAIL_POLL_MS } from '../src/secret-fill'
import type { FakeClock } from './fakes'
import { ACCOUNT_PAGE, EVIL, HASH, LOGIN, LOGIN_PAGE, manifestWithSteps, START, unparsedWithSteps, WWW, world } from './fixtures'

const SENDER = 'login@shop.test'
const ACCOUNT = 'icloud-mail/mail'
const LINK = `${WWW}/magic?token=canary-link-9d1f3a`

const MAIL_GRANT: Grant = {
  adapterId: 'shop',
  adapterHash: HASH,
  secret: MAIL_SECRET,
  provider: 'mail',
  itemRef: `${ACCOUNT} ${SENDER}`,
  origins: [LOGIN, WWW],
  grantedAt: '2026-11-06T09:00:00.000Z',
}

/** Answers once mail has "arrived": `value` from `at` on, not-found before. */
class FakeMailReader implements MailReader {
  readonly calls: { query: MailSignInQuery; notBefore: Date }[] = []
  readonly issued: SecretValue[] = []
  failWith: CredentialError | null = null
  constructor(
    readonly clock: FakeClock,
    public value: string,
    public at: number,
  ) {}
  async find(query: MailSignInQuery, notBefore: Date): Promise<SecretValue> {
    this.calls.push({ query, notBefore })
    if (this.failWith !== null) throw this.failWith
    if (this.clock.now < this.at) throw new CredentialError('not-found')
    const secret = SecretValue.fromString(this.value)
    this.issued.push(secret)
    return secret
  }
}

const CODE_STEPS = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  { op: 'otp', selector: '#otp', source: { mail: { from: SENDER, pattern: 'code: (\\d{6})', maxAgeSeconds: 300 } } },
])

const LINK_STEPS = manifestWithSteps([
  { op: 'goto', url: LOGIN_PAGE },
  { op: 'openMailLink', from: SENDER, linkOrigin: WWW, maxAgeSeconds: 300 },
])

function mailWorld(value: string, at = START + 7_000) {
  const w = world()
  w.grants.grants.push(structuredClone(MAIL_GRANT))
  const reader = new FakeMailReader(w.clock, value, at)
  w.input.mailReader = reader
  return { ...w, reader }
}

describe('a code from a sign-in mail', () => {
  it('waits for the mail, then types the code on granted origins only', async () => {
    const w = mailWorld('804512')
    w.page.cookies.add('session')
    w.input.manifest = CODE_STEPS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed).toMatchObject([{ selector: '#otp', text: '804512', secret: true, allowedOrigins: [LOGIN, WWW] }])
    expect(w.clock.sleeps).toEqual([MAIL_POLL_MS, MAIL_POLL_MS])
    expect(w.reader.calls[0]).toEqual({
      query: { account: ACCOUNT, from: SENDER, subjectContains: undefined, maxAgeSeconds: 300, extract: { pattern: 'code: (\\d{6})' } },
      notBefore: new Date(START),
    })
    expect(w.reader.issued.every((s) => s.disposed)).toBe(true)
    expect(w.audit.events.find((e) => e.type === 'secret-used')).toMatchObject({ secret: MAIL_SECRET, field: 'otp', origin: LOGIN })
  })

  it('refuses a value that does not look like a code', async () => {
    const w = mailWorld('https://evil.test/x', START)
    w.input.manifest = CODE_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'not-found' })
    expect(w.page.typed).toEqual([])
  })

  it('gives up when no mail comes', async () => {
    const w = mailWorld('804512', START + 10 * 60_000)
    w.input.manifest = CODE_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'not-found' })
  })
})

describe('a link from a sign-in mail', () => {
  it('opens the link, after auditing it and keeping it for redaction', async () => {
    const w = mailWorld(LINK)
    w.page.site[LINK] = { redirectTo: ACCOUNT_PAGE }
    w.input.manifest = LINK_STEPS
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.visited).toEqual([LOGIN_PAGE, LINK])
    expect(w.remembered.map((s) => s.reveal((v) => v))).toContain(LINK)
    expect(w.audit.events.find((e) => e.type === 'secret-used')).toMatchObject({ secret: MAIL_SECRET, field: 'otp', origin: WWW })
    expect(w.reader.calls[0]?.query.extract).toEqual({ linkOrigin: WWW })
    expect(w.reader.issued.every((s) => s.disposed)).toBe(true)
  })

  it.each([
    ['another origin', `${EVIL}/magic?token=x`],
    ['http', 'http://www.shop.test/magic'],
    ['user info', 'https://evil@www.shop.test/magic'],
    ['another port', 'https://www.shop.test:8443/magic'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['nothing like a URL', 'not a link'],
  ])('never opens a link with %s', async (_name, value) => {
    const w = mailWorld(value, START)
    w.input.manifest = LINK_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'origin-mismatch' })
    expect(w.page.visited).toEqual([LOGIN_PAGE])
  })

  it('opens a link only on an origin the grant allows', async () => {
    const w = mailWorld(LINK, START)
    w.grants.grants[w.grants.grants.length - 1] = { ...MAIL_GRANT, origins: [LOGIN] }
    w.input.manifest = LINK_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'origin-mismatch' })
    expect(w.reader.calls).toEqual([])
  })

  it('opens nothing when the use cannot be audited', async () => {
    const w = mailWorld(LINK, START)
    w.audit.failOn = 'secret-used'
    w.input.manifest = LINK_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed' })
    expect(w.page.visited).toEqual([LOGIN_PAGE])
  })
})

describe('the mail grant', () => {
  it.each([
    ['no grant', () => null],
    ['a grant for another sender', () => ({ ...MAIL_GRANT, itemRef: `${ACCOUNT} other@shop.test` })],
    ['a grant from another provider', () => ({ ...MAIL_GRANT, provider: 'fake' as const })],
    ['a grant with a malformed reference', () => ({ ...MAIL_GRANT, itemRef: SENDER })],
    ['a grant for another version', () => ({ ...MAIL_GRANT, adapterHash: 'f'.repeat(64) })],
  ])('reads no mail with %s', async (_name, make) => {
    const w = mailWorld(LINK, START)
    w.grants.grants.pop()
    const g = make()
    if (g !== null) w.grants.grants.push(g)
    w.input.manifest = LINK_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'not-granted' })
    expect(w.reader.calls).toEqual([])
  })

  it('reads no mail when Valet has no reader', async () => {
    const w = mailWorld(LINK, START)
    delete w.input.mailReader
    w.input.manifest = LINK_STEPS
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'unavailable' })
  })

  it('never fills the mail grant as a secret', async () => {
    const w = mailWorld(LINK, START)
    w.input.manifest = unparsedWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#email', value: { secret: MAIL_SECRET, field: 'otp' } },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed' })
    expect(w.page.typed).toEqual([])
  })

  it('passes the reader’s own failure through as unavailable or locked', async () => {
    const w = mailWorld(LINK, START)
    w.reader.failWith = new CredentialError('locked')
    w.input.manifest = LINK_STEPS
    const result = await runAuthFlow(w.input)
    expect(result).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(result)).not.toContain('canary-link')
  })
})
