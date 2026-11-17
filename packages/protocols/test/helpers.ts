import { connect } from 'node:tls'
import { DEFAULT_USER, type FakeImap, type FakeImapOptions, startFakeImap } from '@valet/fake-imap'
import { type ClientOptions, ImapClient } from '../src/imap/client'
import { Operations, type FolderRule } from '../src/imap/operations'
import type { Purpose } from '../src/imap/policy'

export const MESSAGE = [
  'From: "Shop" <orders@shop.test>',
  'To: nick@icloud.test',
  'Subject: Your order',
  'Date: Mon, 16 Nov 2026 09:00:00 +0000',
  'Message-ID: <1@shop.test>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Thanks for your order.',
  '',
].join('\r\n')

export const MULTIPART = [
  'From: =?utf-8?q?Caf=C3=A9?= <cafe@example.test>',
  'To: nick@icloud.test',
  'Subject: =?utf-8?b?TWVudSDwn42V?=',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=iso-8859-1',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Caf=E9 menu=',
  ' today',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('<p>Café menu today</p>').toString('base64'),
  '--inner--',
  '--outer',
  'Content-Type: application/pdf; name="menu.pdf"',
  'Content-Disposition: attachment; filename="menu.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 fake').toString('base64'),
  '--outer--',
  '',
].join('\r\n')

export async function fake(options: FakeImapOptions = {}): Promise<FakeImap> {
  return startFakeImap({
    mailboxes: { INBOX: [{ raw: MESSAGE }, { raw: MULTIPART, flags: ['\\Seen'] }], Archive: [] },
    ...options,
  })
}

export async function client(server: FakeImap, purpose: Purpose, extra: Partial<ClientOptions> = {}) {
  const socket = connect({
    host: '127.0.0.1',
    port: server.port,
    servername: 'imap.mail.me.com',
    ca: server.cert ?? undefined,
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve())
    socket.once('error', reject)
  })
  return ImapClient.open(socket, { purpose, commandTimeoutMs: 5_000, ...extra })
}

export async function signedIn(server: FakeImap, purpose: Purpose, folders: FolderRule = null) {
  const c = await client(server, purpose)
  await c.login(Buffer.from(DEFAULT_USER.username), Buffer.from(DEFAULT_USER.password))
  return { client: c, ops: new Operations(c, { folders, purpose }) }
}
