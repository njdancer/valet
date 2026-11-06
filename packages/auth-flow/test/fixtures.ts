// The example site every test starts from: a login page on login.shop.test that posts back to
// itself and lands on www.shop.test/account. Tests copy what they need and change one thing.

import {
  type AuthStep,
  type Grant,
  type ManifestInput,
  MESSAGES_SECRET,
  parseManifest,
  type SecretValue,
} from '@siteadapter/core'
import type { AuthFlowInput } from '../src/types'
import { FakeAuthPage, type FakeSite } from './fake-auth-page'
import {
  FakeClock,
  FakeGrantStore,
  FakeOtpReader,
  FakeProbe,
  FakeProvider,
  InProcessUrlMatcher,
  RecordingAudit,
} from './fakes'

export const LOGIN = 'https://login.shop.test'
export const WWW = 'https://www.shop.test'
export const EVIL = 'https://evil.test'
export const LOGIN_PAGE = 'https://login.shop.test/'
export const ACCOUNT_PAGE = 'https://www.shop.test/account'
export const HASH = '3f1e0c2b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f'
export const ITEM = 'op://siteadapter/Shop'
export const START = Date.parse('2026-11-07T10:00:00.000Z')

/** Unique values that must reach the page and nothing else. */
export const CANARY = {
  username: 'canary-user-7f3a91@shop.test',
  password: 'canary-pw-Q8z!r2#Lk-5d1c',
  otp: 'canary-totp-55219',
  sms: '804512',
} as const

export const MANIFEST: ManifestInput = {
  schemaVersion: 1,
  id: 'shop',
  name: 'Shop',
  version: '0.1.0',
  description: 'An example shop.',
  home: 'https://www.shop.test/',
  navigation: [WWW, LOGIN],
  egress: ['www.shop.test'],
  secrets: {
    login: {
      description: 'Shop account',
      fields: ['username', 'password', 'otp'],
      origins: [LOGIN],
    },
  },
  session: {
    cookieDomains: ['www.shop.test'],
    probe: { kind: 'cookie', name: 'session' },
  },
  auth: {
    steps: [
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#email' }, timeoutMs: 10_000 },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      { op: 'click', selector: '#submit' },
      { op: 'waitFor', condition: { urlContains: '/account' }, timeoutMs: 10_000 },
      { op: 'assertLoggedIn' },
    ],
  },
  tools: [{ name: 'get_cart', title: 'Get cart', description: 'Read the cart.', sideEffect: 'read' }],
}

export const SITE: FakeSite = {
  [LOGIN_PAGE]: {
    forms: { login: LOGIN, search: WWW },
    elements: {
      '#email': { inputType: 'email', form: 'login' },
      '#password': { inputType: 'password', form: 'login' },
      '#otp': { inputType: 'text', autocomplete: 'one-time-code', inputMode: 'numeric', form: 'login' },
      '#submit': { tagName: 'button', inputType: 'submit', form: 'login' },
      '#search': { inputType: 'search', form: 'search' },
    },
    text: ['Sign in to Shop'],
    clicks: { '#submit': ACCOUNT_PAGE },
  },
  [ACCOUNT_PAGE]: { text: ['Welcome back'], setsCookies: ['session'] },
}

export const GRANT: Grant = {
  adapterId: 'shop',
  adapterHash: HASH,
  secret: 'login',
  provider: 'fake',
  itemRef: ITEM,
  origins: [LOGIN],
  grantedAt: '2026-11-06T09:00:00.000Z',
}

/** The sender the shop's codes come from, as Messages shows it. */
export const SENDER = 'ShopSMS'

/**
 * The person's say-so for this adapter to read one-time codes from SENDER in Messages, and type
 * them on the login origin.
 */
export const MESSAGES_GRANT: Grant = {
  adapterId: 'shop',
  adapterHash: HASH,
  secret: MESSAGES_SECRET,
  provider: 'messages',
  itemRef: SENDER,
  origins: [LOGIN],
  grantedAt: '2026-11-06T09:00:00.000Z',
}

export const ITEMS: Record<string, { username: string; password: string; otp: string }> = {
  [ITEM]: { username: CANARY.username, password: CANARY.password, otp: CANARY.otp },
}

/** Parses a copy of MANIFEST with its auth steps replaced. */
export function manifestWithSteps(steps: AuthStep[]) {
  const input = structuredClone(MANIFEST)
  input.auth = { steps }
  return parseManifest(input)
}

/**
 * MANIFEST, parsed, with its auth steps replaced after parsing: for the interpreter's own checks
 * on a manifest that never went through the schema.
 */
export function unparsedWithSteps(steps: unknown[]) {
  const manifest = parseManifest(structuredClone(MANIFEST))
  return { ...manifest, auth: { ...manifest.auth, steps: steps as AuthStep[] } }
}

/**
 * A fresh, fully wired run against the example site, where everything is in order. Tests change
 * one part of it, then call runAuthFlow(w.input).
 */
export function world() {
  const clock = new FakeClock(START)
  const page = new FakeAuthPage(structuredClone(SITE))
  const grants = new FakeGrantStore([structuredClone(GRANT), structuredClone(MESSAGES_GRANT)])
  const provider = new FakeProvider(structuredClone(ITEMS))
  const otpReader = new FakeOtpReader(clock, [])
  const audit = new RecordingAudit()
  // A cookie probe against the auth partition, which is where the flow runs and the only place
  // the session exists until the caller copies it.
  const probe = new FakeProbe(page)
  /** The runtime's copies of every secret typed, for redacting tool output. */
  const remembered: SecretValue[] = []
  const urlMatcher = new InProcessUrlMatcher()
  const input: { -readonly [K in keyof AuthFlowInput]: AuthFlowInput[K] } = {
    manifest: parseManifest(structuredClone(MANIFEST)),
    adapterHash: HASH,
    callId: 'call-1',
    page,
    grants,
    providers: { fake: provider },
    otpReader,
    probe,
    isBlockedPage: async () => page.isBlocked(),
    rememberSecret: (secret) => remembered.push(secret),
    audit,
    clock: clock.clock,
    sleep: clock.sleep,
    typingDelayMs: 40,
    flowTimeoutMs: 60_000,
    urlMatcher,
  }
  return { clock, page, grants, provider, otpReader, audit, probe, remembered, urlMatcher, input }
}
