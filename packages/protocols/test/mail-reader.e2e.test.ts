// Sign-in mail end to end: HostMailReader runs the bundled protocol host, signed in as the mail
// account's adapter, through the broker's tunnel to the fake server, read-only.

import { CredentialError } from '@valet/core'
import { DEFAULT_USER, type FakeImap } from '@valet/fake-imap'
import { afterEach, describe, expect, it } from 'vitest'
import { HostMailReader } from '../src/mail-reader'
import { brokerTo, fake, hostOptions, signIn } from './helpers'

const ENDPOINT = 'imap.mail.me.com:993'
const SENDER = 'login@shop.test'
const ORIGIN = 'https://www.shop.test'

let server: FakeImap | null = null
let reader: HostMailReader | null = null
afterEach(async () => {
  reader?.close()
  reader = null
  await new Promise((r) => setTimeout(r, 50))
  await server?.close()
  server = null
})

const message = (body: string, from = SENDER) =>
  [
    'Authentication-Results: mx.icloud.test; dmarc=pass header.from=shop.test',
    `From: Shop <${from}>`,
    'To: nick@icloud.test',
    'Subject: Sign in to Shop',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '',
  ].join('\r\n')

async function setup(options: { folders?: string[]; password?: string } = {}) {
  server = await fake({ mailboxes: { INBOX: [] } })
  const host = await hostOptions(server)
  const accounts: string[] = []
  reader = new HostMailReader({
    host,
    idleMs: 1_000,
    account: async (ref) => {
      accounts.push(ref)
      if (ref !== 'icloud-mail/mail') return null
      return {
        protocol: {
          endpoint: ENDPOINT,
          credential: 'mail',
          ...(options.folders === undefined ? {} : { folders: options.folders }),
        },
        signIn: signIn(
          options.password === undefined ? DEFAULT_USER : { ...DEFAULT_USER, password: options.password },
        ),
        broker: brokerTo(server as FakeImap),
      }
    },
  })
  return { reader, accounts, server }
}

const linkQuery = {
  account: 'icloud-mail/mail',
  from: SENDER,
  maxAgeSeconds: 300,
  extract: { linkOrigin: ORIGIN },
}

describe('HostMailReader', () => {
  it('finds a link that arrived after the login asked, reusing one session', async () => {
    const t = await setup()
    const asked = new Date(Date.now() - 1_000)
    await expect(t.reader.find(linkQuery, asked)).rejects.toMatchObject({ failure: 'not-found' })
    t.server.deliver('INBOX', { raw: message(`Sign in: ${ORIGIN}/magic?t=abc`) })
    const found = await t.reader.find(linkQuery, asked)
    expect(found.reveal((v) => v)).toBe(`${ORIGIN}/magic?t=abc`)
    found.dispose()
    expect(t.server.logins).toHaveLength(1)
    const verbs = t.server.commands.map((c) => c.verb)
    expect(verbs).not.toContain('SELECT')
    expect(verbs).not.toContain('UID STORE')
    expect(t.server.commands.every((c) => !/BODY\[/.test(c.line))).toBe(true)
    expect(t.server.mailboxes.get('INBOX')?.messages[0]?.flags.size).toBe(0)
  })

  it('finds a code', async () => {
    const t = await setup()
    t.server.deliver('INBOX', { raw: message('Your code: 482913') })
    const found = await t.reader.find(
      {
        account: 'icloud-mail/mail',
        from: SENDER,
        maxAgeSeconds: 300,
        extract: { pattern: 'code: (\\d{6})' },
      },
      new Date(Date.now() - 1_000),
    )
    expect(found.reveal((v) => v)).toBe('482913')
  })

  it('ignores mail from anyone else', async () => {
    const t = await setup()
    t.server.deliver('INBOX', { raw: message(`${ORIGIN}/magic?t=evil`, 'login@evil.test') })
    await expect(t.reader.find(linkQuery, new Date(Date.now() - 1_000))).rejects.toMatchObject({
      failure: 'not-found',
    })
  })

  it('knows no account it does not hold', async () => {
    const t = await setup()
    const error = await t.reader
      .find({ ...linkQuery, account: 'other/mail' }, new Date())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CredentialError)
    expect(error).toMatchObject({ failure: 'not-found' })
  })

  it('refuses an account whose folders leave out INBOX', async () => {
    const t = await setup({ folders: ['Receipts'] })
    await expect(t.reader.find(linkQuery, new Date())).rejects.toMatchObject({ failure: 'unavailable' })
    expect(t.server.logins).toEqual([])
  })

  it('reports a refused sign-in as locked, and starts afresh next time', async () => {
    const t = await setup({ password: 'wrong' })
    await expect(t.reader.find(linkQuery, new Date())).rejects.toMatchObject({ failure: 'locked' })
    await expect(t.reader.find(linkQuery, new Date())).rejects.toMatchObject({ failure: 'locked' })
    expect(t.server.logins.map((l) => l.ok)).toEqual([false, false])
  })
})
