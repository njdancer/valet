// The send rules both the runtime and the protocol host check (workstream G): what an address,
// subject and body may hold, the recipients list, and the bytes Valet builds.

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../src/manifest'
import {
  buildMailMessage,
  checkMailMessage,
  envelopeRecipients,
  isMailAddress,
  isMessageId,
  mailDate,
  recipientAllowed,
} from '../src/smtp-policy'

const ok = { to: ['ann@example.com'], subject: 'Hello', text: 'Hi Ann\nSee you soon.' }

describe('mail addresses', () => {
  it('takes plain local@domain addresses only', () => {
    for (const good of ['ann@example.com', 'a.b+tag@mail.example.co.uk', "o'neil@x.io", 'x@a-b.example'])
      expect(isMailAddress(good)).toBe(true)
    for (const bad of [
      'Ann <ann@example.com>',
      'ann@example.com, bob@example.com',
      'ann@example.com\r\nRCPT TO:<eve@evil.com>',
      'ann@example.com>',
      '<ann@example.com',
      '"ann"@example.com',
      'ann@example',
      'ann@@example.com',
      'ann@exa mple.com',
      'ann@[127.0.0.1]',
      'ann@127.0.0.1',
      '.ann@example.com',
      'ann.@example.com',
      'ann..b@example.com',
      'ann@-example.com',
      'ann@example.com.',
      'ann(comment)@example.com',
      'añn@example.com',
      `${'a'.repeat(65)}@example.com`,
      `a@${'b'.repeat(200)}.com`,
      '',
    ])
      expect(isMailAddress(bad), bad).toBe(false)
  })

  it('takes Message-IDs that can end no header', () => {
    expect(isMessageId('<abc.123@mail.example.com>')).toBe(true)
    for (const bad of ['abc@x', '<abc@x>\r\nBcc: eve@evil.com', '<a b@x>', '<a@x><b@y>', '<@x>'])
      expect(isMessageId(bad), bad).toBe(false)
  })
})

describe('a message', () => {
  it('fills in what was left out', () => {
    expect(checkMailMessage(ok)).toEqual({ ...ok, cc: [], bcc: [], inReplyTo: null, references: [] })
  })

  it('refuses anything that could add a recipient, a header or hide text', () => {
    for (const bad of [
      { ...ok, to: [] },
      { ...ok, to: 'ann@example.com' },
      { ...ok, to: ['ann@example.com', 'ANN@example.com'] },
      { ...ok, cc: ['ann@example.com'] },
      { ...ok, bcc: ['x@y.com, eve@evil.com'] },
      { ...ok, subject: 'Hi\r\nBcc: eve@evil.com' },
      { ...ok, subject: 'Hi\nthere' },
      { ...ok, subject: 'Invoice ‮fdp.exe' },
      { ...ok, subject: 'x'.repeat(301) },
      { ...ok, text: 'a\u0000b' },
      { ...ok, text: 'a‮b' },
      { ...ok, inReplyTo: 'not-an-id' },
      { ...ok, references: ['<a@b>', 'oops'] },
      { ...ok, headers: { 'X-Evil': '1' } },
      { ...ok, from: 'ceo@example.com' },
      { ...ok, html: '<b>hi</b>' },
      { ...ok, to: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`) },
      Object.assign(Object.create({ polluted: true }), ok),
      null,
      [],
    ])
      expect(checkMailMessage(bad), JSON.stringify(bad)).toBeNull()
  })

  it('puts Bcc in the envelope only', () => {
    const m = checkMailMessage({ ...ok, cc: ['bob@example.com'], bcc: ['carl@example.com'] })
    if (m === null) throw new Error('refused')
    expect(envelopeRecipients(m)).toEqual(['ann@example.com', 'bob@example.com', 'carl@example.com'])
    const built = buildMailMessage('me@icloud.com', m, { messageId: '<1@icloud.com>', date: 0 })
    expect(built).not.toContain('carl@example.com')
    expect(built).toContain('Cc: bob@example.com')
  })
})

describe('the bytes Valet sends', () => {
  const date = Date.parse('2026-11-17T18:00:05Z')

  it('has only Valet’s headers, CRLF lines, 7-bit text and a base64 body', () => {
    const m = checkMailMessage({
      ...ok,
      text: 'Hi\n.\nQUIT\r\nDATA\n',
      inReplyTo: '<p@x.com>',
      references: ['<o@x.com>', '<p@x.com>'],
    })
    if (m === null) throw new Error('refused')
    const built = buildMailMessage('me@icloud.com', m, { messageId: '<id1@icloud.com>', date })
    const [head, body] = built.split('\r\n\r\n') as [string, string]
    expect(head.split('\r\n')).toEqual([
      'From: me@icloud.com',
      'To: ann@example.com',
      'Subject: Hello',
      'Date: Tue, 17 Nov 2026 18:00:05 +0000',
      'Message-ID: <id1@icloud.com>',
      'In-Reply-To: <p@x.com>',
      'References: <o@x.com>',
      ' <p@x.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
    ])
    expect(/^[\x20-\x7e\r\n]*$/.test(built)).toBe(true)
    expect(built.split('\r\n').every((l) => l.length <= 998)).toBe(true)
    expect(built).not.toMatch(/(^|\n)\.(\r|$)/)
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(
      'Hi\r\n.\r\nQUIT\r\nDATA\r\n',
    )
  })

  it('encodes a subject that isn’t short plain ASCII, without splitting characters', () => {
    const subject = `Café ☕ ${'é'.repeat(40)} =?x?= done`
    const m = checkMailMessage({ ...ok, subject })
    if (m === null) throw new Error('refused')
    const built = buildMailMessage('me@icloud.com', m, { messageId: '<id1@icloud.com>', date })
    const lines = built.split('\r\n')
    const start = lines.findIndex((l) => l.startsWith('Subject: '))
    const words: string[] = []
    for (let i = start; i < lines.length && (i === start || lines[i]?.startsWith(' ')); i++)
      words.push((lines[i] as string).replace(/^Subject: | /, ''))
    const decoded = words
      .map((w) => {
        const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(w)
        if (match === null) throw new Error(w)
        return Buffer.from(match[1] as string, 'base64').toString('utf8')
      })
      .join('')
    expect(decoded).toBe(subject)
  })

  it('refuses a From or Message-ID that isn’t plain', () => {
    const m = checkMailMessage(ok)
    if (m === null) throw new Error('refused')
    expect(() => buildMailMessage('Me <me@icloud.com>', m, { messageId: '<1@x.com>', date })).toThrow()
    expect(() =>
      buildMailMessage('me@icloud.com', m, { messageId: '<1@x.com>\r\nBcc: e@v.com', date }),
    ).toThrow()
  })

  it('dates in UTC', () => {
    expect(mailDate(Date.parse('2026-01-05T03:04:05Z'))).toBe('Mon, 5 Jan 2026 03:04:05 +0000')
  })
})

describe('the recipients list', () => {
  it('matches exact addresses and exact domains, without case, and nothing else', () => {
    const rules = ['ann@example.com', '@family.example']
    expect(recipientAllowed('ANN@Example.com', rules)).toBe(true)
    expect(recipientAllowed('bob@family.example', rules)).toBe(true)
    expect(recipientAllowed('bob@sub.family.example', rules)).toBe(false)
    expect(recipientAllowed('bob@evilfamily.example', rules)).toBe(false)
    expect(recipientAllowed('bob@example.com', rules)).toBe(false)
    expect(recipientAllowed('anyone@anywhere.com', null)).toBe(true)
  })
})

describe('protocols.smtp in a manifest', () => {
  const base = {
    schemaVersion: 1,
    id: 'mail',
    name: 'Mail',
    version: '1.0.0',
    description: 'Sends mail.',
    runtime: 'protocol',
    home: 'https://smtp.mail.me.com/',
    navigation: [],
    egress: [],
    requests: [],
    credentials: {
      icloud: {
        description: 'iCloud app password',
        kind: 'password',
        custody: 'kept',
        use: { protocol: 'smtp', endpoint: 'smtp.mail.me.com:587' },
      },
    },
    tools: [{ name: 'send', title: 'Send', description: 'Sends a mail.', sideEffect: 'irreversible' }],
  }

  it('takes an endpoint, the credential and an optional recipients list', () => {
    expect(() =>
      parseManifest({
        ...base,
        protocols: {
          smtp: { endpoint: 'smtp.mail.me.com:587', credential: 'icloud', recipients: ['@example.com'] },
        },
      }),
    ).not.toThrow()
  })

  it('refuses a credential for another protocol or endpoint, and a bad recipients rule', () => {
    for (const smtp of [
      { endpoint: 'smtp.mail.me.com:465', credential: 'icloud' },
      { endpoint: 'smtp.mail.me.com:587', credential: 'other' },
      { endpoint: 'smtp.mail.me.com:587', credential: 'icloud', recipients: ['Ann <a@b.com>'] },
      { endpoint: 'smtp.mail.me.com:587', credential: 'icloud', recipients: ['@b.com', '@B.com'] },
      { endpoint: 'smtp.mail.me.com:587', credential: 'icloud', recipients: [] },
      { endpoint: 'smtp.mail.me.com:587', credential: 'icloud', from: 'ceo@example.com' },
    ])
      expect(() => parseManifest({ ...base, protocols: { smtp } }), JSON.stringify(smtp)).toThrow()
  })
})
