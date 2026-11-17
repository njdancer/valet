// `protocol` adapters (docs/imap.md#the-manifest) and email sign-in sources: what a manifest may
// declare, and the grant reference a mail sign-in is approved under.

import { describe, expect, it } from 'vitest'
import { MAIL_SECRET, mailGrantRef, parseMailGrantRef } from '../src/credentials'
import { folderAllowed, ICLOUD_IMAP_ENDPOINT } from '../src/imap-policy'
import { type ManifestInput, mailSourcesIn, manifestSchema, parseManifest } from '../src/manifest'

const MAIL: ManifestInput = {
  schemaVersion: 1,
  id: 'icloud-mail',
  name: 'iCloud Mail',
  version: '0.1.0',
  description: 'Reads and files mail in an iCloud account.',
  runtime: 'protocol',
  protocols: {
    imap: { endpoint: 'imap.mail.me.com:993', credential: 'mail', folders: ['INBOX', 'Receipts'] },
  },
  credentials: {
    mail: {
      description: 'Your iCloud app-specific password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
    },
  },
  tools: [
    { name: 'search_mail', title: 'Search mail', description: 'Searches mail.', sideEffect: 'read' },
    { name: 'file_receipt', title: 'File a receipt', description: 'Moves a receipt.', sideEffect: 'write' },
  ],
} as ManifestInput

const copy = (): any => structuredClone(MAIL)
const issues = (input: unknown): string[] => {
  const result = manifestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe('runtime: protocol', () => {
  it('parses, with home the server’s name and nothing to browse or fetch', () => {
    const manifest = parseManifest(copy())
    expect(manifest.runtime).toBe('protocol')
    expect(manifest.home).toBe('https://imap.mail.me.com/')
    expect(manifest.navigation).toEqual([])
    expect(manifest.egress).toEqual([])
    expect(manifest.protocols?.imap?.folders).toEqual(['INBOX', 'Receipts'])
    expect(ICLOUD_IMAP_ENDPOINT).toBe('imap.mail.me.com:993')
  })

  it('needs protocols.imap', () => {
    const input = copy()
    delete input.protocols
    expect(issues(input)).toContain('a protocol adapter needs protocols.imap')
  })

  it('refuses anything that reaches past its server', () => {
    for (const [field, value, message] of [
      ['egress', ['api.example.com'], 'a protocol adapter reaches only its protocols: no egress hosts'],
      ['navigation', ['https://www.icloud.com'], 'a protocol adapter has no navigation origins'],
      [
        'requests',
        [{ method: 'GET', host: 'x.example.com', path: '/', purpose: 'read' }],
        'a protocol adapter declares no HTTP requests',
      ],
      ['cartUrl', 'https://www.icloud.com/cart', 'a protocol adapter has no cartUrl'],
      [
        'privateHosts',
        [{ address: '10.0.0.5', port: 993, scheme: 'https' }],
        'a protocol adapter has no privateHosts yet',
      ],
    ] as const) {
      const input = copy()
      input[field] = value
      expect(issues(input)).toContain(message)
    }
  })

  it('signs in only with a kept password for imap at its own endpoint', () => {
    const missing = copy()
    missing.protocols.imap.credential = 'other'
    expect(issues(missing)).toContain('protocols.imap: credential other is not declared in credentials')
    const elsewhere = copy()
    elsewhere.credentials.mail.use.endpoint = 'imap.example.com:993'
    expect(issues(elsewhere)).toContain(
      'protocols.imap: credential mail must be a kept password for imap at imap.mail.me.com:993',
    )
    const token = copy()
    token.credentials.mail.kind = 'token'
    expect(issues(token).join()).toMatch(/kept password/)
    const spare = copy()
    spare.credentials.spare = { ...spare.credentials.mail }
    expect(issues(spare)).toContain("credential spare: an imap credential that protocols.imap doesn't use")
  })

  it.each([
    ['an IP address', '17.42.251.41:993'],
    ['an IPv6 address', '[::1]:993'],
    ['no port', 'imap.mail.me.com'],
    ['a wildcard', '*.mail.me.com:993'],
  ])('refuses an endpoint with %s', (_name, endpoint) => {
    const input = copy()
    input.protocols.imap.endpoint = endpoint
    expect(issues(input).length).toBeGreaterThan(0)
  })

  it.each([
    ['a LIST wildcard', 'Rec*'],
    ['a percent', 'Rec%'],
    ['a line break', 'INBOX\r\nA1 DELETE x'],
    ['a NUL', 'a\u0000b'],
    ['nothing', ''],
  ])('refuses a folder with %s', (_name, folder) => {
    const input = copy()
    input.protocols.imap.folders = [folder]
    expect(issues(input).length).toBeGreaterThan(0)
  })

  it('refuses a folder listed twice, INBOX in any case', () => {
    const input = copy()
    input.protocols.imap.folders = ['INBOX', 'inbox']
    expect(issues(input)).toContain('protocols.imap.folders lists a folder twice')
  })

  it('has no protocols outside a protocol adapter', () => {
    const input = copy()
    input.runtime = 'http'
    input.egress = ['api.example.com']
    expect(issues(input)).toContain('protocols is only for protocol adapters')
  })

  it('matches folders exactly, INBOX in any case', () => {
    expect(folderAllowed('inbox', ['INBOX'])).toBe(true)
    expect(folderAllowed('INBOX', ['Inbox'])).toBe(true)
    expect(folderAllowed('receipts', ['Receipts'])).toBe(false)
    expect(folderAllowed('Receipts/2026', ['Receipts'])).toBe(false)
    expect(folderAllowed('Anything', null)).toBe(true)
  })
})

// --- Email sign-in ------------------------------------------------------------------------------

const SHOP: ManifestInput = {
  schemaVersion: 1,
  id: 'mail-login-shop',
  name: 'Mail Login Shop',
  version: '0.1.0',
  description: 'A shop that mails a sign-in link.',
  home: 'https://www.shop.test/',
  navigation: ['https://www.shop.test'],
  egress: ['www.shop.test'],
  secrets: {
    login: { description: 'Shop account', fields: ['username'], origins: ['https://www.shop.test'] },
  },
  session: {
    cookieDomains: ['www.shop.test'],
    probe: { kind: 'fetch', path: '/api/me', expectStatus: 200 },
  },
  auth: {
    steps: [
      { op: 'goto', url: 'https://www.shop.test/login' },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
      { op: 'click', selector: 'button[type=submit]' },
      {
        op: 'openMailLink',
        from: 'login@shop.test',
        subjectContains: 'Sign in',
        linkOrigin: 'https://www.shop.test',
        maxAgeSeconds: 600,
      },
      {
        op: 'when',
        condition: { visible: '#code' },
        steps: [
          {
            op: 'otp',
            selector: '#code',
            source: { mail: { from: 'login@shop.test', pattern: 'code: ([0-9]{6})', maxAgeSeconds: 300 } },
          },
        ],
      },
      { op: 'assertLoggedIn' },
    ],
  },
  requests: [{ method: 'GET', path: '/api/me', purpose: 'read' }],
  tools: [{ name: 'me', title: 'Me', description: 'Who am I.', sideEffect: 'read' }],
} as ManifestInput

const shop = (): any => structuredClone(SHOP)

describe('email sign-in', () => {
  it('parses a mail link and a mail code, and lists them as mail sources', () => {
    const manifest = parseManifest(shop())
    expect(mailSourcesIn(manifest.auth.steps)).toEqual([
      {
        kind: 'link',
        from: 'login@shop.test',
        subjectContains: 'Sign in',
        linkOrigin: 'https://www.shop.test',
        maxAgeSeconds: 600,
      },
      { kind: 'code', from: 'login@shop.test', pattern: 'code: ([0-9]{6})', maxAgeSeconds: 300 },
    ])
  })

  it('opens a link only on an origin the adapter may navigate', () => {
    const input = shop()
    input.auth.steps[3].linkOrigin = 'https://evil.test'
    expect(issues(input)).toContain('openMailLink linkOrigin https://evil.test is not in navigation')
  })

  it('needs a subject for a link, so other mail from the sender is not taken for it', () => {
    const input = shop()
    delete input.auth.steps[3].subjectContains
    expect(issues(input).length).toBeGreaterThan(0)
  })

  it('names one sender for every mail step', () => {
    const input = shop()
    input.auth.steps[4].steps[0].source.mail.from = 'codes@shop.test'
    expect(issues(input)).toContain('every mail sign-in step names the same sender')
  })

  it.each([
    ['a display name', 'Shop <login@shop.test>'],
    ['upper case', 'Login@Shop.test'],
    ['two addresses', 'a@shop.test,b@shop.test'],
    ['no domain dot', 'login@localhost'],
  ])('refuses a sender with %s', (_name, from) => {
    const input = shop()
    input.auth.steps[3].from = from
    expect(issues(input)).toContain('one mail address, in lower case')
  })

  it('bounds the age, and keeps the mail secret name reserved', () => {
    const old = shop()
    old.auth.steps[3].maxAgeSeconds = 3600
    expect(issues(old).length).toBeGreaterThan(0)
    const http = shop()
    http.auth.steps[3].linkOrigin = 'http://www.shop.test'
    expect(issues(http).length).toBeGreaterThan(0)
    const reserved = shop()
    reserved.secrets[MAIL_SECRET] = { description: 'x', fields: ['otp'], origins: ['https://www.shop.test'] }
    expect(issues(reserved)).toContain(`secret name ${MAIL_SECRET} is reserved`)
  })

  it('writes and reads a mail grant’s reference', () => {
    const ref = mailGrantRef('icloud-mail/mail', 'login@shop.test')
    expect(ref).toBe('icloud-mail/mail login@shop.test')
    expect(parseMailGrantRef(ref)).toEqual({ account: 'icloud-mail/mail', sender: 'login@shop.test' })
    expect(() => mailGrantRef('icloud-mail/mail', 'Shop <login@shop.test>')).toThrow()
    for (const bad of [
      '',
      'icloud-mail login@shop.test',
      'icloud-mail/mail',
      'a/b c d',
      'Icloud/mail x@y.test',
    ])
      expect(parseMailGrantRef(bad)).toBeNull()
  })
})
