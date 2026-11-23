import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectMailFiles } from '../src/direct-files'
import { htmlLinks } from '../src/mime'
import { pdfText } from '../src/pdf'
import { renderPictures } from '../src/render'
import { MailStore, MailStoreError } from '../src/store'
import { callMailTool, mailOutputs } from '../src/tools'
import { ALLOWED, buildLibrary, type FixtureMessage, MESSAGES } from './fixture-library'

const crlf = (lines: readonly string[]): string => lines.join('\r\n')

/** Plain and HTML parts, a CSV, a calendar, a PDF, an image and a forwarded message. */
const WITH_FILES: FixtureMessage = {
  id: 501,
  mailbox: 1,
  from: ['Shop', 'orders@shop.example'],
  subject: 'Your order',
  received: 1_763_800_000,
  raw: crlf([
    'From: Shop <orders@shop.example>',
    'Subject: Your order',
    'Message-ID: <order@shop.example>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Thanks for your order. Track it online.',
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Thanks for your order. <a href="https://shop.example/track?id=1&amp;x=2">Track it</a> or ' +
      '<a href="mailto:help@shop.example">ask us</a>. <a href="javascript:alert(1)">no</a> ' +
      '<a href="https://shop.example/track?id=1&amp;x=2">again</a></p>',
    '--alt--',
    '--outer',
    'Content-Type: text/csv; charset=utf-8; name="items.csv"',
    'Content-Disposition: attachment; filename="items.csv"',
    '',
    'item,qty',
    'tea,2',
    '--outer',
    'Content-Type: text/calendar; charset=utf-8; name="delivery.ics"',
    'Content-Disposition: attachment; filename="delivery.ics"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('BEGIN:VCALENDAR\nSUMMARY:Delivery\nEND:VCALENDAR').toString('base64'),
    '--outer',
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake invoice').toString('base64'),
    '--outer',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: attachment; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'From: Ada <ada@example.com>',
    'To: Nick <me@example.com>',
    'Subject: Earlier',
    '',
    'The forwarded words.',
    '--outer--',
  ]),
}

/** A partly downloaded message: its attachment is a stub, kept in a file of its own. */
const PARTIAL: FixtureMessage = {
  id: 502,
  mailbox: 1,
  from: ['Bank', 'statements@bank.example'],
  subject: 'Statement',
  received: 1_763_810_000,
  partial: true,
  raw: crlf([
    'From: statements@bank.example',
    'Subject: Statement',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'Your statement is attached.',
    '--b',
    'Content-Type: text/csv; name="statement.csv"',
    'Content-Disposition: attachment; filename="statement.csv"',
    'X-Apple-Content-Length: 24',
    '',
    '',
    '--b',
    'Content-Type: text/plain; name="missing.txt"',
    'Content-Disposition: attachment; filename="missing.txt"',
    'X-Apple-Content-Length: 10',
    '',
    '',
    '--b--',
  ]),
  attachmentFiles: { '2/statement.csv': 'date,amount\n1 Nov,-4.50' },
}

/** Like a real Mac: a row id past 1000, so the attachment folder is Data/<digits>/Attachments. */
const PARTIAL_DEEP: FixtureMessage = { ...PARTIAL, id: 40487, received: 1_763_820_000 }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'valet-mail-att-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function store(
  pdf?: (bytes: Buffer) => Promise<string | null>,
  fetchSource?: ConstructorParameters<typeof MailStore>[1]['fetchSource'],
): MailStore {
  const paths = buildLibrary(mkdtempSync(join(root, 'lib-')), {
    messages: [...MESSAGES, WITH_FILES, PARTIAL, PARTIAL_DEEP],
  })
  return new MailStore(new DirectMailFiles(paths), {
    allowedAccounts: () => new Set([ALLOWED]),
    ...(pdf === undefined ? {} : { pdfText: pdf }),
    ...(fetchSource === undefined ? {} : { fetchSource }),
  })
}

describe('reading a message in full', () => {
  it('gives the links from the HTML part even when there is a plain-text part, each once', async () => {
    const message = await store().read(501)
    expect(message.body).toBe('Thanks for your order. Track it online.')
    expect(message.links).toEqual([
      { text: 'Track it', url: 'https://shop.example/track?id=1&x=2' },
      { text: 'ask us', url: 'mailto:help@shop.example' },
    ])
    expect(message.attachments.map((a) => a.name)).toEqual([
      'items.csv',
      'delivery.ics',
      'invoice.pdf',
      'logo.png',
      'forwarded message.eml',
    ])
  })

  it('reads a long body in chunks', async () => {
    const s = store()
    const first = await s.read(501, 100, 0)
    expect(first.bodyOffset).toBe(0)
    expect(first.nextOffset).toBeNull()
    const later = await s.read(501, 100, 11)
    expect(later.body).toBe('your order. Track it online.')
    expect(later.bodyOffset).toBe(11)
  })

  it('finds at most 100 links, only web and mail ones', () => {
    const many = Array.from({ length: 150 }, (_, i) => `<a href="https://x.example/${i}">${i}</a>`).join('')
    expect(htmlLinks(many)).toHaveLength(100)
    expect(htmlLinks('<a href="file:///etc/passwd">x</a><a href=\'https://ok.example\'>ok</a>')).toEqual([
      { text: 'ok', url: 'https://ok.example' },
    ])
  })
})

describe('reading an attachment', () => {
  it('reads text, calendars and forwarded messages as text', async () => {
    const s = store()
    expect(await s.readAttachment(501, 1)).toMatchObject({
      index: 1,
      name: 'items.csv',
      contentType: 'text/csv',
      text: 'item,qty\ntea,2',
      nextOffset: null,
    })
    expect((await s.readAttachment(501, 2)).text).toContain('SUMMARY:Delivery')
    const forwarded = await s.readAttachment(501, 5)
    expect(forwarded.text).toContain('From: Ada <ada@example.com>')
    expect(forwarded.text).toContain('Subject: Earlier')
    expect(forwarded.text).toContain('The forwarded words.')
  })

  it('reads a PDF through PDFKit, and says when it can’t', async () => {
    const seen: string[] = []
    const withPdf = store(async (bytes) => {
      seen.push(bytes.toString('latin1'))
      return 'Invoice total 42'
    })
    expect((await withPdf.readAttachment(501, 3)).text).toBe('Invoice total 42')
    expect(seen).toEqual(['%PDF-1.4 fake invoice'])
    expect(await store().readAttachment(501, 3)).toMatchObject({ text: null, reason: 'unreadable' })
  })

  it('gives an image’s name, type and size only', async () => {
    expect(await store().readAttachment(501, 4)).toMatchObject({
      name: 'logo.png',
      contentType: 'image/png',
      size: 4,
      text: null,
      reason: 'binary',
    })
  })

  it('reads an attachment Mail keeps in a file of its own, and says when it isn’t downloaded', async () => {
    const s = store()
    const message = await s.read(502)
    expect(message.attachments).toEqual([
      { name: 'statement.csv', contentType: 'text/csv', size: 24 },
      { name: 'missing.txt', contentType: 'text/plain', size: 10 },
    ])
    expect((await s.readAttachment(502, 1)).text).toBe('date,amount\n1 Nov,-4.50')
    expect(await s.readAttachment(502, 2)).toMatchObject({ text: null, reason: 'not-downloaded' })
    // Data/0/4/Attachments/40487/2/statement.csv, beside Data/0/4/Messages.
    expect((await s.readAttachment(40487, 1)).text).toBe('date,amount\n1 Nov,-4.50')
  })

  it('asks Mail for the whole message when the attachment isn’t on disk, and reads it from that', async () => {
    const asked: unknown[] = []
    const whole = (PARTIAL.raw as string)
      .replace('X-Apple-Content-Length: 10\r\n\r\n\r\n', '\r\nfetched it\r\n')
      .replace('X-Apple-Content-Length: 24\r\n', '')
    const s = store(undefined, async (message) => {
      asked.push(message)
      return Buffer.from(whole)
    })
    expect((await s.readAttachment(502, 2)).text).toBe('fetched it')
    expect(asked).toEqual([
      {
        messageId: null,
        accountId: ALLOWED,
        mailbox: 'INBOX',
        rowId: 502,
        subject: 'Statement',
        sender: 'statements@bank.example',
        date: expect.any(String),
      },
    ])
    // Mail couldn't get it either.
    const none = store(undefined, async () => null)
    expect(await none.readAttachment(502, 2)).toMatchObject({ reason: 'not-downloaded' })
  })

  it('reads in chunks', async () => {
    const s = store()
    const first = await s.readAttachment(502, 1, 100, 0)
    expect(first.nextOffset).toBeNull()
    const later = await s.readAttachment(502, 1, 100, 12)
    expect(later.text).toBe('1 Nov,-4.50')
    expect(later.offset).toBe(12)
  })

  it('refuses an attachment number the message doesn’t have, and a message of another account', async () => {
    const s = store()
    await expect(s.readAttachment(501, 6)).rejects.toBeInstanceOf(MailStoreError)
    await expect(s.readAttachment(11, 1)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('is mail_read with an attachment number, in the shape it declares', async () => {
    const s = store()
    const deps = { store: s, drafts: { save: async () => ({ kind: 'failed' as const }) } }
    // biome-ignore lint/suspicious/noExplicitAny: only the store is used here.
    const result = await callMailTool(deps as any, 'read', { id: 501, attachment: 1 })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    const out = mailOutputs.read.parse(result.output)
    expect(out.message).toBeUndefined()
    expect(out.attachment?.text).toBe('item,qty\ntea,2')
  })
})

describe('mail_read handing over pictures and files', () => {
  const drafts = { save: async () => ({ kind: 'failed' as const }) }
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const drawn = (n: number, of: number, from = 1) => ({
    pageCount: of,
    pictures: Array.from({ length: n }, (_, i) => ({
      mimeType: 'image/png' as const,
      data: Buffer.from(`page ${i}`),
      width: 10,
      height: 10,
      page: from + i,
    })),
  })
  // biome-ignore lint/suspicious/noExplicitAny: only the store and render are used here.
  const call = (deps: object, input: object) => callMailTool({ drafts, ...deps } as any, 'read', input)

  it('sends an image as a picture, drawn when it can be and as it is when not', async () => {
    const s = store()
    const plain = await call({ store: s }, { id: 501, attachment: 4 })
    expect(plain.status).toBe('ok')
    if (plain.status !== 'ok') return
    expect(mailOutputs.read.parse(plain.output).attachment?.sent).toBe('picture')
    expect(plain.content).toEqual([{ kind: 'image', mimeType: 'image/png', data: PNG }])
    // The bytes are beside the output, never in it.
    expect(JSON.stringify(plain.output)).not.toContain(PNG.toString('base64'))

    const asked: unknown[] = []
    const render = async (bytes: Buffer, request: unknown) => {
      asked.push([bytes, request])
      return drawn(1, 1)
    }
    const redrawn = await call({ store: s, render }, { id: 501, attachment: 4 })
    expect(asked).toEqual([[PNG, { kind: 'image' }]])
    expect(redrawn.status === 'ok' && redrawn.content).toEqual([
      { kind: 'image', mimeType: 'image/png', data: Buffer.from('page 0') },
    ])
  })

  it('gives a PDF’s text by default, and pictures of the pages asked for instead', async () => {
    const asked: unknown[] = []
    const render = async (_bytes: Buffer, request: unknown) => {
      asked.push(request)
      return drawn(2, 12, 6)
    }
    const s = store(async () => '--- Page 1 of 12 ---\nInvoice total $4')
    const text = await call({ store: s, render }, { id: 501, attachment: 3 })
    expect(text.status === 'ok' && text.content).toBeUndefined()
    expect(text.status === 'ok' && mailOutputs.read.parse(text.output).attachment?.text).toBe(
      '--- Page 1 of 12 ---\nInvoice total $4',
    )
    expect(asked).toEqual([])

    const pages = await call({ store: s, render }, { id: 501, attachment: 3, pages: [6, 7] })
    expect(pages.status).toBe('ok')
    if (pages.status !== 'ok') return
    const out = mailOutputs.read.parse(pages.output).attachment
    expect(out).toMatchObject({ text: null, sent: 'pages', pages: [6, 7], pageCount: 12 })
    expect(asked).toEqual([{ kind: 'pdf', pages: [6, 7], edge: 1400 }])
    expect(pages.content).toHaveLength(2)

    const failed = await call({ store: s, render: async () => null }, { id: 501, attachment: 3, pages: [1] })
    expect(failed.status === 'ok' && mailOutputs.read.parse(failed.output).attachment?.sent).toBeNull()
    const tooMany = await call({ store: s, render }, { id: 501, attachment: 3, pages: [1, 2, 3, 4, 5, 6] })
    expect(tooMany.status).toBe('failed')
  })

  it('sends the file itself with as: file, under a URI of Valet’s own', async () => {
    const s = store()
    const result = await call({ store: s }, { id: 501, attachment: 3, as: 'file' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(mailOutputs.read.parse(result.output).attachment?.sent).toBe('file')
    expect(result.content).toEqual([
      {
        kind: 'file',
        uri: 'valet-mail://message/501/attachment/3/invoice.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 fake invoice'),
      },
    ])
  })

  it('sends nothing for an attachment that isn’t downloaded', async () => {
    const result = await call({ store: store() }, { id: 502, attachment: 2, as: 'file' })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.content).toBeUndefined()
    expect(mailOutputs.read.parse(result.output).attachment).toMatchObject({
      reason: 'not-downloaded',
      sent: null,
    })
  })
})

describe('renderPictures', () => {
  it('draws on a private copy, reads back only its own files, and removes them', async () => {
    const { existsSync } = await import('node:fs')
    const { writeFile } = await import('node:fs/promises')
    let dir = ''
    const rendered = await renderPictures(
      Buffer.from('%PDF-1.7 x'),
      { kind: 'pdf', pages: [3, 3, 0, 9] },
      async (args) => {
        expect(args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
        const req = JSON.parse(args[args.length - 1] as string)
        expect(req).toMatchObject({ kind: 'pdf', pages: [2, 8], edge: 1568 })
        dir = req.out
        await writeFile(join(dir, 'page-2'), 'png bytes')
        return {
          code: 0,
          stdout: JSON.stringify({
            pageCount: 4,
            pictures: [{ file: join(dir, 'page-2'), mimeType: 'image/png', width: 3, height: 4, page: 3 }],
          }),
        }
      },
    )
    expect(rendered).toEqual({
      pageCount: 4,
      pictures: [{ mimeType: 'image/png', data: Buffer.from('png bytes'), width: 3, height: 4, page: 3 }],
    })
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses a file outside its folder, an odd type, a failed run, and a PDF that isn’t one', async () => {
    const answer = (picture: object) => async () => ({
      code: 0,
      stdout: JSON.stringify({ pageCount: 1, pictures: [picture] }),
    })
    const png = Buffer.from('x')
    expect(
      await renderPictures(png, { kind: 'image' }, answer({ file: '/etc/passwd', mimeType: 'image/png' })),
    ).toBeNull()
    expect(
      await renderPictures(png, { kind: 'image' }, async (args) => {
        const out = JSON.parse(args[args.length - 1] as string).out
        return answer({ file: `${out}/image`, mimeType: 'text/html' })()
      }),
    ).toBeNull()
    expect(await renderPictures(png, { kind: 'image' }, async () => ({ code: 1, stdout: '' }))).toBeNull()
    expect(
      await renderPictures(Buffer.from('hello'), { kind: 'pdf' }, async () => ({ code: 0, stdout: '' })),
    ).toBeNull()
  })
})

describe('pdfText', () => {
  it('runs the fixed script on a private copy and removes it', async () => {
    let file = ''
    const text = await pdfText(Buffer.from('%PDF-1.7 x'), async (args) => {
      file = args[args.length - 1] as string
      expect(args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
      return { code: 0, stdout: 'Page one\n' }
    })
    expect(text).toBe('Page one')
    const { existsSync } = await import('node:fs')
    expect(existsSync(file)).toBe(false)
  })

  it('reads nothing that isn’t a PDF, and nothing from a failed run', async () => {
    expect(await pdfText(Buffer.from('hello'), async () => ({ code: 0, stdout: 'x' }))).toBeNull()
    expect(await pdfText(Buffer.from('%PDF-1.7'), async () => ({ code: 1, stdout: '' }))).toBeNull()
  })
})

describe('which of Mail’s files may be read', () => {
  it('reads messages and attachment files, never the databases', async () => {
    const { isMailMessageFile } = await import('../src/files')
    expect(isMailMessageFile('ACCT/INBOX.mbox/U/Data/7.emlx')).toBe(true)
    expect(isMailMessageFile('ACCT/INBOX.mbox/U/Attachments/7/1.2/a b.pdf')).toBe(true)
    for (const path of [
      'MailData/Envelope Index',
      'ACCT/MailData/x.emlx',
      'ACCT/Attachments/7/2/x',
      'ACCT/INBOX.mbox/U/Attachments/seven/2/x',
      'ACCT/INBOX.mbox/U/Attachments/7/x',
      'ACCT/INBOX.mbox/U/../Attachments/7/2/x',
    ])
      expect(isMailMessageFile(path), path).toBe(false)
  })
})
