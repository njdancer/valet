// Red team: IMAP protocol adapters and the built-in sign-in mail lookup.
//
// Tests marked `it.fails` are proofs of concept for open findings: each asserts the SECURE
// behaviour, fails today, and so passes under `it.fails`. When a finding is fixed, vitest reports
// the `it.fails` as failing; turn it into a plain `it` then. Plain `it` tests pin behaviour that
// held up under attack.

import { mayWriteInbox } from '@valet/core'
import type { FakeImap, MessageInput } from '@valet/fake-imap'
import { afterEach, describe, expect, it } from 'vitest'
import { ImapError } from '../src/imap/client'
import { encodeCommand, encodeMailbox } from '../src/imap/command'
import { checkFolder, searchTerms } from '../src/imap/operations'
import {
  authenticated,
  findSignInMail,
  firstLink,
  headerFields,
  linksIn,
  type SignInQuery,
} from '../src/imap/signin'
import { parseEnvelope } from '../src/imap/structure'
import { Framer, parseResponse, WireError } from '../src/imap/wire'
import { fake, signedIn } from './helpers'

let server: FakeImap | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const ORIGIN = 'https://shop.test'
const SENDER = 'login@shop.test'

function signInMail(options: {
  auth?: string | null
  body?: string
  html?: string
  at?: number
  subject?: string
}) {
  const headers = [
    ...(options.auth === null
      ? []
      : [`Authentication-Results: mx.icloud.test; ${options.auth ?? 'dmarc=pass header.from=shop.test'}`]),
    `From: Shop <${SENDER}>`,
    'To: nick@icloud.test',
    `Subject: ${options.subject ?? 'Your sign-in link'}`,
  ]
  const raw =
    options.html === undefined
      ? [
          ...headers,
          'Content-Type: text/plain; charset=utf-8',
          '',
          options.body ?? `${ORIGIN}/login?token=real`,
          '',
        ].join('\r\n')
      : [...headers, 'Content-Type: text/html; charset=utf-8', '', options.html, ''].join('\r\n')
  return {
    raw,
    ...(options.at === undefined ? {} : { internalDate: new Date(options.at) }),
  } satisfies MessageInput
}

const query = (now: number, extra: Partial<SignInQuery> = {}): SignInQuery => ({
  from: SENDER,
  after: now - 30_000,
  now,
  maxAgeSeconds: 600,
  subjectContains: 'sign-in',
  extract: { linkOrigin: ORIGIN },
  ...extra,
})

// --- Authentication-Results ------------------------------------------------------------------------

describe('RT-IMAP-1: Authentication-Results parsing', () => {
  // A DKIM signature's i= tag may carry a local part: `i=shop.test@evil.test` is a valid AUID for
  // d=evil.test. Verifiers report it as header.i, and the regex's `@?([a-z0-9.-]+)` captures the
  // LOCAL PART ("shop.test") as the domain. So an attacker who signs with their own domain passes
  // the check for any sender domain whose name fits in a local part.
  it('fixed: does not read a DKIM header.i local part as the signing domain', () => {
    const fields = headerFields(
      'Authentication-Results: mx.icloud.test; dkim=pass (2048-bit key) header.d=evil.test header.i=shop.test@evil.test header.s=s1; dmarc=fail header.from=shop.test\r\n\r\n',
    )
    expect(authenticated(fields, 'shop.test')).toBe(false)
  })

  // The value is split on every `;`, with no regard for quoted strings or comments. Many receivers
  // copy the SMTP MAIL FROM (whose local part may be a quoted string holding `;`) or the HELO name
  // into the header, so attacker text can start a clause of its own.
  it('fixed: does not let a quoted MAIL FROM local part start a clause', () => {
    const fields = headerFields(
      'Authentication-Results: mx.icloud.test; spf=pass smtp.mailfrom="x;dmarc=pass header.from=shop.test"@evil.test; dkim=none; dmarc=fail header.from=shop.test\r\n\r\n',
    )
    expect(authenticated(fields, 'shop.test')).toBe(false)
  })

  it('fixed: does not let a comment hold a clause', () => {
    const fields = headerFields(
      'Authentication-Results: mx.icloud.test; spf=softfail (domain of x@evil.test; dmarc=pass header.from=shop.test) smtp.mailfrom=evil.test; dmarc=fail header.from=shop.test\r\n\r\n',
    )
    expect(authenticated(fields, 'shop.test')).toBe(false)
  })

  it('holds: a pass for a look-alike or a parent-less domain is not a pass', () => {
    const check = (ar: string) =>
      authenticated(headerFields(`Authentication-Results: mx; ${ar}\r\n\r\n`), 'shop.test')
    expect(check('dmarc=pass header.from=evilshop.test')).toBe(false)
    expect(check('dmarc=pass header.from=shop.test.evil.test')).toBe(false)
    expect(check('dkim=pass header.d=evil.test')).toBe(false)
    expect(check('dmarc=fail header.from=shop.test')).toBe(false)
    expect(check('dkim=fail header.d=shop.test')).toBe(false)
    // Only the topmost header is read; an attacker's own, lower down, is not.
    expect(
      authenticated(
        headerFields(
          'Authentication-Results: mx; dmarc=fail header.from=shop.test\r\nAuthentication-Results: mx; dmarc=pass header.from=shop.test\r\n\r\n',
        ),
        'shop.test',
      ),
    ).toBe(false)
  })
})

// --- Planted mail -----------------------------------------------------------------------------------

describe('RT-IMAP-2: a message APPENDed to INBOX', () => {
  // The A-R check assumes every INBOX message came through the receiving MTA, which puts its own
  // header on top. APPEND skips the MTA: the message's own (forged) A-R is then the topmost one,
  // and INTERNALDATE is "now". Any IMAP client holding the account can plant it: another app, or a
  // Valet protocol adapter whose `write` tool is allowed INBOX (the same kind of account a mail
  // grant names). The sign-in lookup then opens the planted link, e.g. signing the site's browser
  // session in to the attacker's account (login CSRF), or types the planted code.
  // The lookup itself can't tell a planted message from a delivered one, so the fix is upstream:
  // HostMailReader refuses an account whose adapter may change INBOX (core's mayWriteInbox; see
  // test/mail-reader.e2e.test.ts). This pins why that rule is needed.
  it('documents: the lookup alone takes a planted message', async () => {
    server = await fake({ mailboxes: { INBOX: [] } })
    const { ops } = await signedIn(server, 'write', ['INBOX'])
    await ops.append('INBOX', signInMail({ body: `${ORIGIN}/login?token=ATTACKER` }).raw, undefined)
    const { client } = await signedIn(server, 'read')
    const result = await findSignInMail(client, query(Date.now()))
    expect(result).toEqual({ found: true, value: `${ORIGIN}/login?token=ATTACKER` })
  })

  it('fixed: an account whose tools may write INBOX cannot serve sign-in mail', () => {
    const manifest = (sideEffect: string, folders?: string[]) => ({
      tools: [{ sideEffect: 'read' }, { sideEffect }],
      protocols: {
        imap: { endpoint: 'imap.mail.me.com:993', credential: 'mail', ...(folders ? { folders } : {}) },
      },
    })
    expect(mayWriteInbox(manifest('write'))).toBe(true)
    expect(mayWriteInbox(manifest('irreversible', ['inbox']))).toBe(true)
    expect(mayWriteInbox(manifest('read'))).toBe(false)
    expect(mayWriteInbox(manifest('write', ['Receipts']))).toBe(false)
  })
})

// --- Which mail counts ------------------------------------------------------------------------------

describe('RT-IMAP-3: which mail from the sender counts', () => {
  // Docs: "arrived after the login asked for it". The two-minute skew allowance also accepts mail
  // that arrived up to two minutes BEFORE the login started, e.g. the link from a login someone
  // else triggered just before (anyone can ask a site to mail a link to an address).
  it('fixed: does not take mail that arrived before the login asked for it', async () => {
    const now = Date.UTC(2026, 10, 17, 10, 0, 0)
    server = await fake({ mailboxes: { INBOX: [signInMail({ at: now - 30_000 - 90_000 })] } })
    const { client } = await signedIn(server, 'read')
    expect(await findSignInMail(client, query(now))).toEqual({ found: false })
  })

  // Without subjectContains (it is optional), the newest mail from the sender wins, and its first
  // link on the origin is opened. A site's other mail from the same address (an invitation, a
  // shared item) is attacker-triggerable, passes DKIM, and arrives after the real one.
  it('fixed: a later non-sign-in mail from the sender is passed over, since a link needs a subject', async () => {
    const now = Date.UTC(2026, 10, 17, 10, 0, 0)
    server = await fake({
      mailboxes: {
        INBOX: [
          signInMail({ at: now - 10_000 }),
          signInMail({ at: now - 2_000, subject: 'Eve invited you', body: `Join: ${ORIGIN}/invite?t=EVE` }),
        ],
      },
    })
    const { client } = await signedIn(server, 'read')
    expect(await findSignInMail(client, query(now))).toEqual({
      found: true,
      value: `${ORIGIN}/login?token=real`,
    })
    await expect(findSignInMail(client, query(now, { subjectContains: undefined }))).rejects.toBeInstanceOf(
      ImapError,
    )
  })

  // ENVELOPE addresses are lower-cased with String#toLowerCase, which maps U+212A KELVIN SIGN to
  // ASCII "k". So `login@shop.test` and `login@Kshop.test`... compare equal after it.
  it('fixed: does not fold a Kelvin sign in the From domain to ASCII k', () => {
    const env = parseEnvelope([
      null,
      null,
      [[null, null, Buffer.from('noreply'), Buffer.from('slacK.test', 'utf8')]],
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    expect(env?.from[0]?.address).not.toBe('noreply@slack.test')
  })

  it('holds: forged From shapes are refused', async () => {
    const now = Date.UTC(2026, 10, 17, 10, 0, 0)
    const forged = (from: string) => ({
      raw: [
        `From: ${from}`,
        'Subject: Your sign-in link',
        'Content-Type: text/plain',
        '',
        `${ORIGIN}/login?token=EVIL`,
        '',
      ].join('\r\n'),
      internalDate: new Date(now - 5_000),
    })
    server = await fake({
      mailboxes: {
        INBOX: [
          forged(`"${SENDER}" <evil@evil.test>`),
          forged(`${SENDER}, evil@evil.test`),
          forged(`<evil@evil.test>, <${SENDER}>`),
          forged(`=?utf-8?q?login=40shop=2Etest?= <evil@evil.test>`),
          forged(`"login@shop.test"@evil.test`),
        ],
      },
    })
    const { client } = await signedIn(server, 'read')
    expect(await findSignInMail(client, query(now))).toEqual({ found: false })
    expect(server.commands.some((c) => c.verb === 'SELECT')).toBe(false)
  })
})

describe('RT-IMAP-4: sign-in mail is readable by any INBOX read tool on the same account', () => {
  // The lookup keeps the link from tool output, but the mail stays unread in INBOX (BODY.PEEK), so a
  // protocol adapter with a `read` tool allowed INBOX on that account returns the same link or code
  // to the agent: an agent can start a browser adapter's mail login and read the link back.
  it('documents: ctx.imap.message returns the sign-in link', async () => {
    server = await fake({ mailboxes: { INBOX: [signInMail({ body: `${ORIGIN}/login?token=SECRET` })] } })
    const { ops } = await signedIn(server, 'read', ['INBOX'])
    const { uids } = await ops.search('INBOX', { from: SENDER }, undefined)
    const message = await ops.message('INBOX', uids[0], undefined)
    expect(message.text).toContain('token=SECRET')
  })
})

// --- Links --------------------------------------------------------------------------------------

describe('links', () => {
  it('holds: look-alike and userinfo links never match the origin', () => {
    const tricks = [
      'https://shop.test.evil.test/login',
      'https://shop.test@evil.test/login',
      'https://evil.test\\@shop.test/login',
      'https://evil.test#@shop.test',
      'http://shop.test/login',
      'https://shop.test:8443/login',
      'https://xn--shp-ple.test/login',
      'https://user:pw@shop.test/login',
      'javascript:alert(1)//https://shop.test',
      `https://shop.test/${'a'.repeat(3000)}`,
    ]
    expect(firstLink(tricks, ORIGIN)).toBeNull()
    expect(firstLink(linksIn('<a href="https://shop.test&#64;evil.test/x">x</a>', null), ORIGIN)).toBeNull()
    expect(firstLink(linksIn('<a href="https:&#x2F;&#x2F;evil.test/x">x</a>', null), ORIGIN)).toBeNull()
    // A bare evil link earlier in the text comes before, but is skipped.
    expect(firstLink(linksIn(null, 'https://evil.test/x then https://shop.test/ok'), ORIGIN)).toBe(
      'https://shop.test/ok',
    )
  })

  // The code lookup strips tags from an HTML-only mail with /<(script|style)[\s\S]*?<\/\1>/ and
  // /<[^>]*>/: each is quadratic on unclosed input, over up to 256 KB. Bounded by the host's
  // operation timeout (it kills the host), so a denial of the login only.
  it('fixed: reads an HTML-only mail of unclosed tags quickly', async () => {
    const now = Date.UTC(2026, 10, 17, 10, 0, 0)
    server = await fake({
      mailboxes: { INBOX: [signInMail({ at: now - 5_000, html: '<script'.repeat(30_000) })] },
    })
    const { client } = await signedIn(server, 'read')
    const started = performance.now()
    await findSignInMail(client, query(now, { extract: { pattern: 'code ([0-9]{6})' } }))
    expect(performance.now() - started).toBeLessThan(1000)
  }, 60_000)
})

// --- Commands --------------------------------------------------------------------------------------

describe('command injection holds', () => {
  const text = (segments: ReturnType<typeof encodeCommand>) =>
    Buffer.concat(
      segments.map((s) => ('text' in s ? s.text : Buffer.concat([Buffer.from('<LIT>'), s.literal]))),
    ).toString('latin1')

  it('never lets an argument end the command', () => {
    for (const evil of ['a\r\nV2 DELETE INBOX', 'a"\r\n', 'x\\" y', '{5}\r\nabcde', 'a b', 'a\0b']) {
      const out = text(
        encodeCommand('V1', { verb: 'UID SEARCH', args: [{ atom: 'TEXT' }, { string: evil }] }, false),
      )
      // One CRLF ends the command; any other is inside a literal's announced bytes.
      const lines = out.split('\r\n')
      if (lines.length > 2) expect(out).toMatch(/\{\d+\}\r\n<LIT>/)
      expect(out.endsWith('\r\n')).toBe(true)
    }
    for (const atom of ['ALL\r\nX', 'A B', '(X)', '"x"', '{1}', 'BODY[]', '']) {
      expect(() => encodeCommand('V1', { verb: 'UID SEARCH', args: [{ atom }] }, false)).toThrow()
    }
  })

  it('keeps folder names to the manifest, whatever their spelling', () => {
    const rule = ['INBOX', 'Receipts']
    for (const f of [
      'Receipts/',
      'receipts',
      'Receipts\r\n',
      'Receipts*',
      'Re%',
      'INBOX/Sub',
      'INBOX.Sub',
      'Receipts​',
      '&AFIAZQBjAGUAaQBwAHQAcw-',
      '',
    ]) {
      expect(() => checkFolder(f, rule), f).toThrow(ImapError)
    }
    expect(checkFolder('inbox', rule)).toBe('INBOX')
    // `&` can't be used to spell another name: it is always written `&-`.
    expect(encodeMailbox('A&AGIA-')).toBe('A&-AGIA-')
  })

  it('refuses search criteria that try to reach into the prototype or nest without end', () => {
    expect(() => searchTerms(JSON.parse('{"__proto__": {"from": "x"}}'))).toThrow()
    let deep: unknown = { from: 'x' }
    for (let i = 0; i < 10; i++) deep = { not: deep }
    expect(() => searchTerms(deep)).toThrow()
  })
})

// --- A hostile server -----------------------------------------------------------------------------

describe('wire parser under random input', () => {
  it('throws only WireError, and never hangs, on random and mutated responses', () => {
    let seed = 1234567
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    const seeds = [
      '* 1 FETCH (UID 5 BODY[1]<0> {3}\r\nabc FLAGS (\\Seen))',
      '* OK [CAPABILITY IMAP4rev1 LITERAL+] hi',
      '* LIST (\\HasNoChildren) "/" "INBOX"',
      'V1 OK [READ-ONLY] done',
      '* 1 FETCH (ENVELOPE ("d" "s" (("n" NIL "m" "h")) NIL NIL NIL NIL NIL NIL "<id>"))',
    ]
    const alphabet = Buffer.from('()[]{}<>"\\ \r\n~+-0123456789ABCNIL*.')
    const started = performance.now()
    for (let n = 0; n < 20_000; n++) {
      const base = Buffer.from(seeds[n % seeds.length] as string, 'latin1')
      const bytes = Buffer.from(base)
      for (let k = 0; k < 1 + (rand() % 6); k++)
        bytes[rand() % bytes.length] = alphabet[rand() % alphabet.length] as number
      try {
        parseResponse(bytes)
      } catch (error) {
        expect(error).toBeInstanceOf(WireError)
      }
      const framer = new Framer()
      try {
        framer.push(Buffer.concat([bytes, Buffer.from('\r\n')]))
        framer.take()
      } catch (error) {
        expect(error).toBeInstanceOf(WireError)
      }
    }
    expect(performance.now() - started).toBeLessThan(20_000)
  })

  it('refuses deep nesting and an announced literal past the limit', () => {
    expect(() => parseResponse(Buffer.from(`* 1 FETCH ${'('.repeat(100)}${')'.repeat(100)}`))).toThrow(
      WireError,
    )
    const framer = new Framer()
    framer.push(Buffer.from('* 1 FETCH (BODY[] {9999999999}\r\n'))
    expect(() => framer.take()).toThrow(WireError)
  })
})
