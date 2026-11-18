// The starter package a blank draft begins with (docs/authoring-tools.md#drafts-pr-1): a manifest
// for one read tool, its code, and one case, so the agent's first check runs and shows the shape of
// everything. It names example.com until the agent edits it.

import type { PackageFiles } from '@valet/core'
import { PLACEHOLDER_HOST_KEY, STARTER_DESCRIPTION } from './checks'

export function blankDraft(adapterId: string, name: string): PackageFiles {
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. ${STARTER_DESCRIPTION}`,
    home: 'https://www.example.com/',
    navigation: ['https://www.example.com'],
    egress: ['www.example.com'],
    secrets: {},
    session: { cookieDomains: [], storage: [], probe: { kind: 'none' } },
    auth: { steps: [], frameOrigins: [] },
    requests: [{ method: 'GET', path: '/api/items/:id', purpose: 'read' }],
    tools: [
      {
        name: 'get_item',
        title: 'Get item',
        description: 'One item by its id: its name and price.',
        sideEffect: 'read',
      },
    ],
    settings: {},
    limits: {
      requestsPerRun: 5,
      minGapMs: 3000,
      requestsPerHour: 120,
      requestsPerMinute: 10,
      gapJitterPercent: 50,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    },
  }
  const tools = `// ${name}: tool code. It runs in Valet's sandbox and reaches the site only through ctx.page,
// held to manifest.json's egress and requests. Imports: zod, @valet/core, and files under src/.

import { tool, ValetError } from '@valet/core'
import { z } from 'zod'

const item = z.object({ id: z.string(), name: z.string().max(200), price: z.number().nullable() })

export const tools = {
  get_item: tool({
    input: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,40}$/) }),
    output: item,
    async run(ctx, input) {
      const response = await ctx.page.fetch(\`/api/items/\${encodeURIComponent(input.id)}\`, {
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) throw new ValetError('tool-run', 'not-found')
      if (response.status !== 200) throw new ValetError('tool-run', 'unavailable')
      const body = response.body as { id?: unknown; title?: unknown; price?: unknown } | null
      return {
        id: String(body?.id ?? input.id),
        name: typeof body?.title === 'string' ? body.title.slice(0, 200) : '',
        price: typeof body?.price === 'number' ? body.price : null,
      }
    },
  }),
}
`
  const cases = {
    cases: [
      {
        name: 'an item',
        tool: 'get_item',
        input: { id: 'abc-1' },
        fetch: [{ method: 'GET', url: '/api/items/abc-1', status: 200, body: 'fixtures/item-abc-1.json' }],
        expect: { output: { id: 'abc-1', name: 'Example item', price: 4.5 } },
      },
      {
        name: 'an item that does not exist',
        tool: 'get_item',
        input: { id: 'nope' },
        fetch: [
          { method: 'GET', url: '/api/items/nope', status: 404, body: { inline: { error: 'not found' } } },
        ],
        expect: { error: { stage: 'tool-run', errorClass: 'not-found' } },
      },
    ],
  }
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/tools.ts': tools,
    'test/example.json': `${JSON.stringify(cases, null, 2)}\n`,
    'fixtures/item-abc-1.json': `${JSON.stringify({ id: 'abc-1', title: 'Example item', price: 4.5 }, null, 2)}\n`,
  }
}

/**
 * The starter package for an `http` adapter (docs/adapter-kinds.md): no page, one read tool that
 * calls a JSON API through ctx.http, and its cases. It names api.example.com until the agent edits it.
 */
export function blankHttpDraft(adapterId: string, name: string): PackageFiles {
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. Replace this with what the adapter does.`,
    runtime: 'http',
    egress: ['api.example.com'],
    secrets: {},
    session: { cookieDomains: [], storage: [], probe: { kind: 'none' } },
    auth: { steps: [], frameOrigins: [] },
    requests: [{ method: 'GET', host: 'api.example.com', path: '/v1/items/:id', purpose: 'read' }],
    tools: [
      {
        name: 'get_item',
        title: 'Get item',
        description: 'One item by its id: its name and price.',
        sideEffect: 'read',
      },
    ],
    settings: {},
    limits: {
      requestsPerRun: 5,
      minGapMs: 1000,
      requestsPerHour: 300,
      requestsPerMinute: 30,
      gapJitterPercent: 20,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    },
  }
  const tools = `// ${name}: tool code. It runs in Valet's sandbox and reaches the network only through ctx.http,
// held to manifest.json's egress, privateHosts and requests. Imports: zod, @valet/core (parseFeed and
// parseXml for feeds and WebDAV), and files under src/.

import { tool, ValetError } from '@valet/core'
import { z } from 'zod'

const item = z.object({ id: z.string(), name: z.string().max(200), price: z.number().nullable() })

export const tools = {
  get_item: tool({
    input: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,40}$/) }),
    output: item,
    async run(ctx, input) {
      if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
      const response = await ctx.http.fetch(\`/v1/items/\${encodeURIComponent(input.id)}\`, {
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) throw new ValetError('tool-run', 'not-found')
      if (response.status !== 200) throw new ValetError('tool-run', 'unavailable')
      let body: { id?: unknown; title?: unknown; price?: unknown } | null = null
      try {
        body = JSON.parse(response.body)
      } catch {
        throw new ValetError('tool-run', 'unexpected-shape')
      }
      return {
        id: String(body?.id ?? input.id),
        name: typeof body?.title === 'string' ? body.title.slice(0, 200) : '',
        price: typeof body?.price === 'number' ? body.price : null,
      }
    },
  }),
}
`
  const cases = {
    cases: [
      {
        name: 'an item',
        tool: 'get_item',
        input: { id: 'abc-1' },
        fetch: [
          {
            method: 'GET',
            url: 'https://api.example.com/v1/items/abc-1',
            status: 200,
            body: 'fixtures/item-abc-1.json',
          },
        ],
        expect: { output: { id: 'abc-1', name: 'Example item', price: 4.5 } },
      },
      {
        name: 'an item that does not exist',
        tool: 'get_item',
        input: { id: 'nope' },
        fetch: [
          {
            method: 'GET',
            url: 'https://api.example.com/v1/items/nope',
            status: 404,
            body: { inline: { error: 'not found' } },
          },
        ],
        expect: { error: { stage: 'tool-run', errorClass: 'not-found' } },
      },
    ],
  }
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/tools.ts': tools,
    'test/example.json': `${JSON.stringify(cases, null, 2)}\n`,
    'fixtures/item-abc-1.json': `${JSON.stringify({ id: 'abc-1', title: 'Example item', price: 4.5 }, null, 2)}\n`,
  }
}

/**
 * A blank `raw` draft (docs/adapter-kinds.md#raw): Node code that opens its own TLS connection to
 * one endpoint, with a case that tests its parsing without the network. Its npm packages are added
 * with valet_add_dependency.
 */
export function blankRawDraft(adapterId: string, name: string): PackageFiles {
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. Replace this with what the adapter does.`,
    runtime: 'raw',
    endpoints: ['api.example.com:443'],
    secrets: {},
    session: { cookieDomains: [], storage: [], probe: { kind: 'none' } },
    auth: { steps: [], frameOrigins: [] },
    requests: [],
    tools: [
      {
        name: 'get_status',
        title: 'Get status',
        description: 'The service’s status line.',
        sideEffect: 'read',
      },
    ],
    settings: {},
    limits: {
      requestsPerRun: 5,
      minGapMs: 1000,
      requestsPerHour: 300,
      requestsPerMinute: 30,
      gapJitterPercent: 20,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    },
  }
  const tools = `// ${name}: tool code. A raw adapter runs in Node, in a sandbox of its own: Node's built-ins, npm
// packages added with valet_add_dependency, zod, @valet/core and files under src/. Its connections
// reach only manifest.json's endpoints (each must be TLS, with the endpoint's own name), and an
// entrusted credential comes from ctx.secrets.get. It has no page and no ctx.http.

import { tool, ValetError } from '@valet/core'
import { z } from 'zod'

declare const require: (id: string) => any

/** The first line of the answer, cut to 200 characters. Pure, so a case can test it. */
export function statusLine(text: string): string {
  return (text.split(/\\r?\\n/)[0] ?? '').slice(0, 200)
}

function get(path: string): Promise<string> {
  const https = require('node:https')
  return new Promise((resolve, reject) => {
    const request = https.get({ host: 'api.example.com', path, timeout: 10_000 }, (response: any) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (body.length < 100_000) body += chunk
      })
      response.on('end', () =>
        response.statusCode === 200 ? resolve(body) : reject(new ValetError('tool-run', 'unavailable')),
      )
    })
    request.on('timeout', () => request.destroy(new ValetError('tool-run', 'timed-out')))
    request.on('error', reject)
  })
}

export const tools = {
  get_status: tool({
    // A case passes the answer in; a real call leaves it out and asks the service.
    input: z.object({ answer: z.string().max(10_000).optional() }),
    output: z.object({ status: z.string() }),
    async run(_ctx, input) {
      return { status: statusLine(input.answer ?? (await get('/status'))) }
    },
  }),
}
`
  const cases = {
    cases: [
      {
        name: 'the first line of an answer',
        tool: 'get_status',
        input: { answer: 'All systems normal\nsince 09:00' },
        expect: { output: { status: 'All systems normal' } },
      },
    ],
  }
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/tools.ts': tools,
    'test/example.json': `${JSON.stringify(cases, null, 2)}\n`,
  }
}

/** The protocols a blank `protocol` draft can start with (docs/adapter-kinds.md#protocol). */
export const DRAFT_PROTOCOLS = ['imap', 'smtp', 'sftp'] as const
export type DraftProtocol = (typeof DRAFT_PROTOCOLS)[number]

/** Limits for a protocol adapter's starter: a few operations a call, gently paced. */
const PROTOCOL_LIMITS = {
  requestsPerRun: 5,
  minGapMs: 1000,
  requestsPerHour: 120,
  requestsPerMinute: 20,
  gapJitterPercent: 20,
  cooldownSeconds: 600,
  maxCooldownSeconds: 7200,
}

/** A blank `protocol` draft for one protocol. */
export function blankProtocolDraft(adapterId: string, name: string, protocol: DraftProtocol): PackageFiles {
  return protocol === 'imap'
    ? blankImapDraft(adapterId, name)
    : protocol === 'smtp'
      ? blankSmtpDraft(adapterId, name)
      : blankSftpDraft(adapterId, name)
}

function packageOf(manifest: unknown, tools: string, cases: unknown): PackageFiles {
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/tools.ts': tools,
    'test/example.json': `${JSON.stringify(cases, null, 2)}\n`,
  }
}

/**
 * A blank IMAP draft (docs/imap.md): two folders, a read tool that finds mail by sender and a write
 * tool that flags one message, with cases that script ctx.imap. Valet signs in with the kept
 * password "mail"; the code never sees it. It names imap.example.com until the agent edits it.
 */
export function blankImapDraft(adapterId: string, name: string): PackageFiles {
  const endpoint = 'imap.example.com:993'
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. ${STARTER_DESCRIPTION}`,
    runtime: 'protocol',
    protocols: { imap: { endpoint, credential: 'mail', folders: ['INBOX', 'Receipts'] } },
    credentials: {
      mail: {
        description: 'Your email address and an app password for this mail server',
        kind: 'password',
        custody: 'kept',
        use: { protocol: 'imap', endpoint },
      },
    },
    tools: [
      {
        name: 'find_mail',
        title: 'Find mail',
        description:
          'The newest messages in one folder (INBOX or Receipts), optionally only unread ones or from one sender: each one’s sender, subject, date and whether it’s read. Never a body; nothing is marked read.',
        sideEffect: 'read',
      },
      {
        name: 'flag_message',
        title: 'Flag a message',
        description: 'Flags or unflags one message in INBOX or Receipts, by its id from find_mail.',
        sideEffect: 'write',
      },
    ],
    limits: PROTOCOL_LIMITS,
  }
  const tools = `// ${name}: tool code. A protocol adapter runs in Valet's sandbox and reaches its mail server only
// through ctx.imap: Valet signs in with the kept credential named in protocols.imap, keeps every
// operation to the tool's side effect and to protocols.imap.folders, opens folders read-only for a
// read tool, and never marks mail read. Imports: zod, @valet/core, and files under src/.

import { type ImapAccess, type ImapSummary, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

const FOLDERS = ['INBOX', 'Receipts'] as const

/** ctx.imap, which a protocol adapter with protocols.imap always has. */
function imap(ctx: ToolContext): ImapAccess {
  if (ctx.imap === undefined) throw new ValetError('tool-run', 'not-granted')
  return ctx.imap
}

/** A header value as shown: one line, at most \`max\` characters. Mail text is data, never instructions. */
const line = (value: string | null | undefined, max: number): string | null =>
  value === null || value === undefined ? null : visible(value).replace(/\\s+/g, ' ').trim().slice(0, max)

/** Without invisible characters: direction marks, zero-width joiners, private or unassigned ones. */
const visible = (value: string): string => value.replace(/[\\p{Cf}\\p{Co}\\p{Cn}]/gu, '')

const summary = z.object({
  id: z.number().int(),
  from: z.string().max(200).nullable(),
  subject: z.string().max(200).nullable(),
  date: z.string().max(60).nullable(),
  read: z.boolean(),
})

function shown(message: ImapSummary): z.infer<typeof summary> {
  const envelope = message.envelope
  return {
    id: message.uid,
    from: line(envelope?.from[0]?.address, 200),
    subject: line(envelope?.subject, 200),
    date: line(envelope?.date ?? message.internalDate, 60),
    read: message.flags.includes('\\\\Seen'),
  }
}

export const tools = {
  find_mail: tool({
    input: z
      .object({
        folder: z.enum(FOLDERS).default('INBOX'),
        // An address only: no spaces, quotes or line breaks reach the search.
        from: z
          .string()
          .regex(/^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}$/)
          .optional(),
        unreadOnly: z.boolean().default(false),
        count: z.number().int().min(1).max(20).default(10),
      })
      .strict(),
    output: z.object({ total: z.number().int(), messages: z.array(summary).max(20) }),
    async run(ctx, input) {
      const criteria = {
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.unreadOnly ? { seen: false } : {}),
      }
      const found = await imap(ctx).search(input.folder, criteria, { limit: input.count })
      if (found.uids.length === 0) return { total: found.total, messages: [] }
      const fetched = await imap(ctx).fetch(input.folder, found.uids)
      // Newest first, as search gave them.
      const byUid = new Map(fetched.messages.map((m) => [m.uid, m]))
      const messages = found.uids.flatMap((uid) => {
        const m = byUid.get(uid)
        return m === undefined ? [] : [shown(m)]
      })
      return { total: found.total, messages }
    },
  }),

  flag_message: tool({
    input: z
      .object({
        folder: z.enum(FOLDERS).default('INBOX'),
        id: z.number().int().min(1),
        flagged: z.boolean().default(true),
      })
      .strict(),
    output: z.object({ id: z.number().int(), flagged: z.boolean() }),
    async run(ctx, input) {
      // setFlags answers how many ids it was given, not how many exist: look first.
      const found = await imap(ctx).fetch(input.folder, [input.id])
      if (!found.messages.some((m) => m.uid === input.id)) throw new ValetError('tool-run', 'not-found')
      const change = input.flagged ? { add: ['\\\\Flagged'] } : { remove: ['\\\\Flagged'] }
      await imap(ctx).setFlags(input.folder, [input.id], change)
      return { id: input.id, flagged: input.flagged }
    },
  }),
}
`
  const envelope = (from: string, subject: string, date: string) => ({
    date,
    subject,
    from: [{ name: null, address: from }],
    sender: [],
    replyTo: [],
    to: [],
    cc: [],
    inReplyTo: null,
    messageId: null,
  })
  const cases = {
    cases: [
      {
        name: 'unread mail from one sender, newest first',
        tool: 'find_mail',
        input: { from: 'receipts@shop.example', unreadOnly: true, count: 2 },
        imap: [
          {
            op: 'search',
            args: ['INBOX', { from: 'receipts@shop.example', seen: false }, { limit: 2 }],
            answer: { folder: 'INBOX', uidValidity: 1, total: 2, uids: [42, 41] },
          },
          {
            op: 'fetch',
            args: ['INBOX', [42, 41]],
            answer: {
              folder: 'INBOX',
              messages: [
                {
                  uid: 41,
                  flags: [],
                  internalDate: '2026-11-16T09:00:00Z',
                  size: 2048,
                  envelope: envelope(
                    'receipts@shop.example',
                    'Your receipt',
                    'Mon, 16 Nov 2026 09:00:00 +0000',
                  ),
                },
                {
                  uid: 42,
                  flags: [],
                  internalDate: '2026-11-17T08:00:00Z',
                  size: 1024,
                  envelope: envelope(
                    'receipts@shop.example',
                    'Your order\n has shipped',
                    'Tue, 17 Nov 2026 08:00:00 +0000',
                  ),
                },
              ],
            },
          },
        ],
        expect: {
          output: {
            total: 2,
            messages: [
              {
                id: 42,
                from: 'receipts@shop.example',
                subject: 'Your order has shipped',
                date: 'Tue, 17 Nov 2026 08:00:00 +0000',
                read: false,
              },
              {
                id: 41,
                from: 'receipts@shop.example',
                subject: 'Your receipt',
                date: 'Mon, 16 Nov 2026 09:00:00 +0000',
                read: false,
              },
            ],
          },
        },
      },
      {
        name: 'the server is unavailable',
        tool: 'find_mail',
        input: { folder: 'Receipts' },
        imap: [{ op: 'search', args: ['Receipts'], error: { stage: 'egress', errorClass: 'unavailable' } }],
        expect: { error: { stage: 'egress', errorClass: 'unavailable' } },
      },
      {
        name: 'flags a message',
        tool: 'flag_message',
        input: { id: 42 },
        imap: [
          {
            op: 'fetch',
            args: ['INBOX', [42]],
            answer: {
              folder: 'INBOX',
              messages: [
                {
                  uid: 42,
                  flags: [],
                  internalDate: '2026-11-17T08:00:00Z',
                  size: 1024,
                  envelope: envelope(
                    'receipts@shop.example',
                    'Your order',
                    'Tue, 17 Nov 2026 08:00:00 +0000',
                  ),
                },
              ],
            },
          },
          {
            op: 'setFlags',
            args: ['INBOX', [42], { add: ['\\Flagged'] }],
            answer: { folder: 'INBOX', uids: 1 },
          },
        ],
        expect: { output: { id: 42, flagged: true } },
      },
      {
        name: 'a message that is not there',
        tool: 'flag_message',
        input: { id: 7, flagged: false },
        imap: [{ op: 'fetch', args: ['INBOX', [7]], answer: { folder: 'INBOX', messages: [] } }],
        expect: { error: { stage: 'tool-run', errorClass: 'not-found' } },
      },
    ],
  }
  return packageOf(manifest, tools, cases)
}

/**
 * A blank SMTP draft (docs/smtp.md): one irreversible tool that sends a plain-text note to an
 * address at one domain, with cases that script the person's confirmation and the server's answer.
 * It names smtp.example.com and @example.com until the agent edits them.
 */
export function blankSmtpDraft(adapterId: string, name: string): PackageFiles {
  const endpoint = 'smtp.example.com:587'
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. ${STARTER_DESCRIPTION}`,
    runtime: 'protocol',
    protocols: { smtp: { endpoint, credential: 'mail', recipients: ['@example.com'] } },
    credentials: {
      mail: {
        description: 'Your email address and an app password for this mail server',
        kind: 'password',
        custody: 'kept',
        use: { protocol: 'smtp', endpoint },
      },
    },
    tools: [
      {
        name: 'send_note',
        title: 'Send a note',
        description:
          'Sends a short plain-text email from your account to one address at example.com. You see and confirm the exact message before it goes.',
        sideEffect: 'irreversible',
      },
    ],
    limits: { ...PROTOCOL_LIMITS, requestsPerRun: 1 },
  }
  const tools = `// ${name}: tool code. A protocol adapter runs in Valet's sandbox and sends mail only through
// ctx.smtp: Valet signs in with the kept credential named in protocols.smtp, sends From that
// account, keeps recipients to protocols.smtp.recipients, and asks the person to confirm each
// message as Valet shows it. Only an irreversible tool may send. Imports: zod, @valet/core, and
// files under src/.

import { type SmtpAccess, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

/** ctx.smtp, which a protocol adapter with protocols.smtp always has. */
function smtp(ctx: ToolContext): SmtpAccess {
  if (ctx.smtp === undefined) throw new ValetError('tool-run', 'not-granted')
  return ctx.smtp
}

/** One line: no control characters or line breaks of any kind. */
const oneLine = /^[^\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]*$/

export const tools = {
  send_note: tool({
    input: z
      .object({
        to: z.string().regex(/^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,120}$/),
        subject: z.string().min(1).max(200).regex(oneLine),
        text: z.string().min(1).max(10_000),
      })
      .strict(),
    output: z.object({ messageId: z.string().max(300), accepted: z.number().int() }),
    async run(ctx, input) {
      // A decline comes back as confirm/declined, and nothing is sent.
      return await smtp(ctx).send({ to: [input.to], subject: input.subject, text: input.text })
    },
  }),
}
`
  const cases = {
    cases: [
      {
        name: 'sends a note once the person approves it',
        tool: 'send_note',
        input: { to: 'ann@example.com', subject: 'Hello', text: 'See you at ten.' },
        smtp: [{ message: { to: ['ann@example.com'], subject: 'Hello', text: 'See you at ten.' } }],
        expect: { output: { messageId: '<case-1@smtp.example.com>', accepted: 1 } },
      },
      {
        name: 'the person declines: nothing is sent',
        tool: 'send_note',
        input: { to: 'ann@example.com', subject: 'Hello', text: 'See you at ten.' },
        smtp: [{ confirm: 'declined' }],
        expect: { error: { stage: 'confirm', errorClass: 'declined' } },
      },
      {
        name: 'an address the recipients list doesn’t allow is refused before anyone is asked',
        tool: 'send_note',
        input: { to: 'someone@elsewhere.example', subject: 'Hello', text: 'Hi.' },
        expect: { error: { stage: 'request-surface', errorClass: 'command-not-allowed' } },
      },
    ],
  }
  return packageOf(manifest, tools, cases)
}

/**
 * A blank SFTP draft (docs/sftp.md): a read-only reports folder and a write-only drop folder, with
 * read tools to list and read a report and a write tool that adds a new file, and cases that script
 * ctx.sftp. Valet signs in with the kept SSH key "server" and checks the pinned host key first. It
 * names files.example.com and a placeholder host key until the agent writes the server's own.
 */
export function blankSftpDraft(adapterId: string, name: string): PackageFiles {
  const endpoint = 'files.example.com:22'
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. ${STARTER_DESCRIPTION}`,
    runtime: 'protocol',
    protocols: {
      sftp: {
        endpoint,
        credential: 'server',
        hostKeySha256: PLACEHOLDER_HOST_KEY,
        username: 'valet',
        roots: [
          { path: '/srv/reports', access: 'read' },
          { path: '/srv/drop', access: 'write' },
        ],
      },
    },
    credentials: {
      server: {
        description: 'An SSH key Valet makes, whose public half goes in the server’s authorized_keys',
        kind: 'ssh-key',
        custody: 'kept',
        use: { protocol: 'sftp', endpoint },
      },
    },
    tools: [
      {
        name: 'list_reports',
        title: 'List reports',
        description: 'The files in the reports folder: each one’s name, size and when it last changed.',
        sideEffect: 'read',
      },
      {
        name: 'read_report',
        title: 'Read a report',
        description: 'One report’s text, by its name from list_reports (at most 100,000 characters).',
        sideEffect: 'read',
      },
      {
        name: 'save_note',
        title: 'Save a note',
        description:
          'Saves a new text file in the drop folder. Never changes or replaces a file already there.',
        sideEffect: 'write',
      },
    ],
    limits: PROTOCOL_LIMITS,
  }
  const tools = `// ${name}: tool code. A protocol adapter runs in Valet's sandbox and reaches its server only
// through ctx.sftp: Valet checks the server's host key against protocols.sftp.hostKeySha256, signs
// in with the kept key named there, and keeps every path to the roots and every operation to the
// tool's side effect and the root's access. Imports: zod, @valet/core, and files under src/.

import { type SftpAccess, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

const REPORTS = '/srv/reports'
const DROP = '/srv/drop'

/** ctx.sftp, which a protocol adapter with protocols.sftp always has. */
function sftp(ctx: ToolContext): SftpAccess {
  if (ctx.sftp === undefined) throw new ValetError('tool-run', 'not-granted')
  return ctx.sftp
}

/** A file name in one folder: no slashes, no leading dot, nothing a path could climb out with. */
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/)

export const tools = {
  list_reports: tool({
    input: z.object({}).strict(),
    output: z.object({
      reports: z
        .array(z.object({ name: z.string().max(255), size: z.number().nullable(), modified: z.string().max(40).nullable() }))
        .max(200),
      more: z.boolean(),
    }),
    async run(ctx) {
      const listing = await sftp(ctx).list(REPORTS, { limit: 200 })
      const reports = listing.entries
        .filter((e) => e.type === 'file')
        // Names come back as the server sends them: drop invisible characters (direction marks).
        .map((e) => ({
          name: e.name.replace(/[\\p{Cf}\\p{Co}\\p{Cn}]/gu, '').slice(0, 255),
          size: e.size,
          modified: e.modified,
        }))
      return { reports, more: listing.truncated }
    },
  }),

  read_report: tool({
    input: z.object({ name: fileName }).strict(),
    output: z.object({ name: z.string(), text: z.string().max(100_000), truncated: z.boolean() }),
    async run(ctx, input) {
      const file = await sftp(ctx).read(\`\${REPORTS}/\${input.name}\`, { encoding: 'utf8', length: 100_000 })
      return { name: input.name, text: (file.text ?? '').slice(0, 100_000), truncated: file.truncated }
    },
  }),

  save_note: tool({
    input: z.object({ name: fileName, text: z.string().min(1).max(100_000) }).strict(),
    output: z.object({ path: z.string(), bytes: z.number().int() }),
    async run(ctx, input) {
      // mode "create" (the default) never overwrites: a name already there fails as egress/invalid.
      const written = await sftp(ctx).write(\`\${DROP}/\${input.name}\`, input.text)
      return { path: written.path, bytes: written.bytes }
    },
  }),
}
`
  const cases = {
    cases: [
      {
        name: 'lists the reports, files only',
        tool: 'list_reports',
        input: {},
        sftp: [
          {
            op: 'list',
            args: ['/srv/reports'],
            answer: {
              path: '/srv/reports',
              entries: [
                {
                  name: '2026-10.txt',
                  type: 'file',
                  size: 1200,
                  modified: '2026-11-01T00:00:00Z',
                  permissions: '0644',
                },
                { name: 'archive', type: 'directory', size: null, modified: null, permissions: '0755' },
              ],
              truncated: false,
              skipped: 0,
            },
          },
        ],
        expect: {
          output: {
            reports: [{ name: '2026-10.txt', size: 1200, modified: '2026-11-01T00:00:00Z' }],
            more: false,
          },
        },
      },
      {
        name: 'reads one report as text',
        tool: 'read_report',
        input: { name: '2026-10.txt' },
        sftp: [
          {
            op: 'read',
            args: ['/srv/reports/2026-10.txt', { encoding: 'utf8' }],
            answer: {
              path: '/srv/reports/2026-10.txt',
              size: 12,
              offset: 0,
              bytes: 12,
              text: 'Total: 42.\n',
              truncated: false,
            },
          },
        ],
        expect: { output: { name: '2026-10.txt', text: 'Total: 42.\n', truncated: false } },
      },
      {
        name: 'a report that is not there',
        tool: 'read_report',
        input: { name: 'missing.txt' },
        sftp: [
          {
            op: 'read',
            args: ['/srv/reports/missing.txt'],
            error: { stage: 'egress', errorClass: 'not-found' },
          },
        ],
        expect: { error: { stage: 'egress', errorClass: 'not-found' } },
      },
      {
        name: 'saves a new note in the drop folder',
        tool: 'save_note',
        input: { name: 'note.txt', text: 'Call the plumber.' },
        sftp: [
          {
            op: 'write',
            args: ['/srv/drop/note.txt', 'Call the plumber.'],
            answer: { path: '/srv/drop/note.txt', bytes: 17, mode: 'create' },
          },
        ],
        expect: { output: { path: '/srv/drop/note.txt', bytes: 17 } },
      },
    ],
  }
  return packageOf(manifest, tools, cases)
}
