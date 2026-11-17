// The built-in sign-in lookup: it finds the newest real message from the approved sender and reads
// its link or code, and nothing a forger, a stale message or a look-alike link can do gets past it.

import type { FakeImap, MessageInput } from '@valet/fake-imap'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapError } from '../src/imap/client'
import {
  authenticated,
  CLOCK_SKEW_MS,
  findSignInMail,
  firstCode,
  firstLink,
  headerFields,
  internalDateMs,
  linksIn,
  type SignInQuery,
} from '../src/imap/signin'
import { fake, signedIn } from './helpers'

let server: FakeImap | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const NOW = Date.UTC(2026, 10, 17, 10, 0, 0)
const ORIGIN = 'https://shop.test'
const SENDER = 'login@shop.test'

function mail(
  options: {
    from?: string
    subject?: string
    body?: string
    html?: string
    auth?: string | null
    at?: number
    extraHeaders?: string[]
  } = {},
): MessageInput {
  const headers = [
    ...(options.auth === null
      ? []
      : [
          `Authentication-Results: mx.icloud.test; ${options.auth ?? 'dkim=pass header.d=shop.test; dmarc=pass header.from=shop.test'}`,
        ]),
    ...(options.extraHeaders ?? []),
    `From: ${options.from ?? `Shop <${SENDER}>`}`,
    'To: nick@icloud.test',
    `Subject: ${options.subject ?? 'Your sign-in link'}`,
  ]
  const raw =
    options.html === undefined
      ? [
          ...headers,
          'Content-Type: text/plain; charset=utf-8',
          '',
          options.body ?? `Sign in: ${ORIGIN}/login?token=abc123`,
          '',
        ].join('\r\n')
      : [...headers, 'Content-Type: text/html; charset=utf-8', '', options.html, ''].join('\r\n')
  return { raw, internalDate: new Date(options.at ?? NOW - 5_000) }
}

const linkQuery = (extra: Partial<SignInQuery> = {}): SignInQuery => ({
  from: SENDER,
  after: NOW - 60_000,
  now: NOW,
  maxAgeSeconds: 600,
  extract: { linkOrigin: ORIGIN },
  ...extra,
})
const codeQuery = (extra: Partial<SignInQuery> = {}): SignInQuery =>
  linkQuery({ extract: { pattern: 'code:? ([0-9]{6})' }, ...extra })

async function lookup(messages: MessageInput[], query: SignInQuery) {
  server = await fake({ mailboxes: { INBOX: messages } })
  const { client } = await signedIn(server, 'read')
  return findSignInMail(client, query)
}

describe('findSignInMail', () => {
  it('finds the link in the newest message from the sender, without changing anything', async () => {
    const result = await lookup(
      [mail({ body: `old ${ORIGIN}/login?token=old`, at: NOW - 20_000 }), mail()],
      linkQuery(),
    )
    expect(result).toEqual({ found: true, value: `${ORIGIN}/login?token=abc123` })
    const verbs = server?.commands.map((c) => c.verb) ?? []
    expect(verbs).toContain('EXAMINE')
    expect(verbs).not.toContain('SELECT')
    for (const c of server?.commands ?? []) if (c.verb === 'UID FETCH') expect(c.line).not.toMatch(/BODY\[/)
    expect(server?.mailboxes.get('INBOX')?.messages.every((m) => m.flags.size === 0)).toBe(true)
  })

  it('reads a link from HTML, entities decoded', async () => {
    const html = `<a href="${ORIGIN}/magic?a=1&amp;b=2">Sign in</a>`
    expect(await lookup([mail({ html })], linkQuery())).toEqual({
      found: true,
      value: `${ORIGIN}/magic?a=1&b=2`,
    })
  })

  it('reads a code from the subject or the text', async () => {
    expect(await lookup([mail({ subject: 'Your code: 482913' })], codeQuery())).toEqual({
      found: true,
      value: '482913',
    })
    expect(await lookup([mail({ body: 'Use code 120044 to sign in.' })], codeQuery())).toEqual({
      found: true,
      value: '120044',
    })
    expect(
      await lookup(
        [mail({ html: '<p>code: <b>775533</b></p>' })],
        codeQuery({ extract: { pattern: 'code: ([0-9]{6})' } }),
      ),
    ).toEqual({
      found: true,
      value: '775533',
    })
  })

  it.each([
    ['from someone else', mail({ from: `Shop <login@sh0p.test>` })],
    ['from the sender and another address', mail({ from: `${SENDER}, evil@attacker.test` })],
    ['from a display name that looks like the sender', mail({ from: `"${SENDER}" <evil@attacker.test>` })],
    ['that failed DMARC', mail({ auth: 'dkim=fail header.d=shop.test; dmarc=fail header.from=shop.test' })],
    [
      'signed by another domain',
      mail({ auth: 'dkim=pass header.d=attacker.test; dmarc=none header.from=shop.test' }),
    ],
    [
      'vouched for only by a forged, lower header',
      mail({
        auth: 'dmarc=fail header.from=shop.test',
        extraHeaders: ['Authentication-Results: mx.icloud.test; dmarc=pass header.from=shop.test'],
      }),
    ],
    ['that arrived before the login asked', mail({ at: NOW - 60_000 - CLOCK_SKEW_MS - 1_000 })],
    ['older than maxAge', mail({ at: NOW - 601_000 })],
    ['from the future', mail({ at: NOW + CLOCK_SKEW_MS + 60_000 })],
    ['with a link to another origin', mail({ body: 'https://shop.test.attacker.test/login?t=1' })],
    ['with an http link', mail({ body: 'http://shop.test/login?t=1' })],
    [
      'with a link carrying user info',
      mail({ body: 'https://shop.test@attacker.test/login https://x:y@shop.test/login' }),
    ],
    ['with a link on another port', mail({ body: 'https://shop.test:8443/login' })],
  ])('ignores a message %s', async (_name, message) => {
    expect(await lookup([message], linkQuery())).toEqual({ found: false })
  })

  it('takes a message whose server adds no Authentication-Results', async () => {
    expect(await lookup([mail({ auth: null })], linkQuery())).toMatchObject({ found: true })
  })

  it('needs the subject, when asked for one', async () => {
    expect(await lookup([mail({ subject: 'Welcome' })], linkQuery({ subjectContains: 'sign-in' }))).toEqual({
      found: false,
    })
    expect(
      await lookup([mail({ subject: 'Your SIGN-IN link' })], linkQuery({ subjectContains: 'sign-in' })),
    ).toMatchObject({
      found: true,
    })
  })

  it('passes over a forged newer message to the real one', async () => {
    const forged = mail({
      auth: 'dmarc=fail header.from=shop.test',
      body: `${ORIGIN}/login?token=attacker`,
      at: NOW - 1_000,
    })
    expect(await lookup([mail(), forged], linkQuery())).toEqual({
      found: true,
      value: `${ORIGIN}/login?token=abc123`,
    })
  })

  it('ignores a code that does not look like one', async () => {
    expect(
      await lookup([mail({ body: 'code: 1' })], codeQuery({ extract: { pattern: 'code: (\\d+)' } })),
    ).toEqual({
      found: false,
    })
  })

  it('refuses a malformed query before sending anything', async () => {
    server = await fake()
    const { client } = await signedIn(server, 'read')
    const before = server.commands.length
    for (const bad of [
      linkQuery({ from: 'Shop <login@shop.test>' }),
      linkQuery({ from: 'LOGIN@SHOP.TEST' }),
      linkQuery({ maxAgeSeconds: 5 }),
      linkQuery({ maxAgeSeconds: 99_999 }),
      linkQuery({ after: Number.NaN }),
      linkQuery({ extract: { linkOrigin: 'http://shop.test' } }),
      linkQuery({ extract: { linkOrigin: 'https://shop.test/path' } }),
      linkQuery({ subjectContains: 'x'.repeat(201) }),
      codeQuery({ extract: { pattern: 'x'.repeat(201) } }),
    ]) {
      await expect(findSignInMail(client, bad)).rejects.toBeInstanceOf(ImapError)
    }
    expect(server.commands.length).toBe(before)
  })

  it('refuses a pattern that is not a regular expression', () => {
    expect(() => firstCode('(', ['x'])).toThrow(ImapError)
  })

  it('ignores FETCH data the server sends for messages it was not asked about', async () => {
    server = await fake({
      mailboxes: { INBOX: [mail()] },
      hostile: (c) =>
        c.command.verb === 'UID FETCH' && c.command.line.includes('BODY.PEEK[1]')
          ? `* 9 FETCH (UID 77 BODY[1] {35}\r\nhttps://shop.test/login?token=evil1)\r\n${c.command.tag} OK done\r\n`
          : null,
    })
    const { client } = await signedIn(server, 'read')
    expect(await findSignInMail(client, linkQuery())).toEqual({ found: false })
  })
})

describe('helpers', () => {
  it('reads INTERNALDATE with its zone', () => {
    expect(internalDateMs('17-Nov-2026 10:00:00 +0000')).toBe(NOW)
    expect(internalDateMs(' 7-Nov-2026 10:00:00 -0130')).toBe(Date.UTC(2026, 10, 7, 11, 30))
    expect(internalDateMs('17-Foo-2026 10:00:00 +0000')).toBeNull()
    expect(internalDateMs(null)).toBeNull()
  })

  it('unfolds headers and reads only the topmost Authentication-Results', () => {
    const fields = headerFields(
      'A: 1\r\n  continued\r\nAuthentication-Results: x;\r\n dmarc=pass header.from=mail.shop.test\r\n\r\nBody: no',
    )
    expect(fields).toEqual([
      ['a', '1 continued'],
      ['authentication-results', 'x; dmarc=pass header.from=mail.shop.test'],
    ])
    expect(authenticated(fields, 'mail.shop.test')).toBe(true)
    expect(authenticated(fields, 'shop.test')).toBe(false)
    expect(
      authenticated([['authentication-results', 'x; dkim=pass header.i=@shop.test']], 'login.shop.test'),
    ).toBe(true)
    expect(
      authenticated([['authentication-results', 'x; dkim=pass header.d=evilshop.test']], 'shop.test'),
    ).toBe(false)
  })

  it('finds links in href order, then bare, trimming punctuation', () => {
    expect(
      linksIn("<a href='https://a.test/1'>x</a> see https://b.test/2).", 'Go to https://c.test/3.'),
    ).toEqual(['https://a.test/1', 'https://c.test/3', 'https://a.test/1', 'https://b.test/2'])
    expect(
      firstLink(
        ['javascript:alert(1)', 'not a url', `${ORIGIN}/${'x'.repeat(3000)}`, `${ORIGIN}/ok`],
        ORIGIN,
      ),
    ).toBe(`${ORIGIN}/ok`)
  })
})
