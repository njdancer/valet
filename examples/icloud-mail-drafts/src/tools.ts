// Drafts in iCloud Mail over IMAP (docs/imap.md). Mail's own scripting can't write a draft's text
// without putting it in a quote block, so this writes the whole message itself and appends it to
// Drafts, where Mail on every device shows it as a normal draft. It never sends: it can reach only
// Drafts and Deleted Messages, and IMAP can't send mail.
//
// The message is built by Valet's own checked builder (core's checkMailMessage and buildMailMessage,
// the ones ctx.smtp uses), so no text an agent passes can start a header; this adds only the Bcc
// line a draft keeps and the header that tells Mail it is a draft.

import {
  buildMailMessage,
  checkMailMessage,
  type ImapAccess,
  isMailAddress,
  isMessageId,
  type ToolContext,
  tool,
  ValetError,
} from '@valet/core'
import { z } from 'zod'

const DRAFTS = 'Drafts'
const DELETED = 'Deleted Messages'

function imap(ctx: ToolContext): ImapAccess {
  if (ctx.imap === undefined) throw new ValetError('tool-run', 'not-granted')
  return ctx.imap
}

const address = z.string().max(190)

const bracketed = (id: string): string => (id.startsWith('<') ? id : `<${id}>`)

/** A Message-ID as mail_read shows it, with or without its angle brackets. */
const messageId = z
  .string()
  .max(200)
  .refine((id) => isMessageId(bracketed(id)), 'Not a Message-ID: id@host, as mail_read shows it.')

const fields = {
  from: address.describe('The address the draft is from: one of the account’s own (mail_accounts).'),
  fromName: z
    .string()
    .max(64)
    .optional()
    .describe('The name shown with it, in plain letters, digits, spaces, dots, hyphens and apostrophes.'),
  to: z.array(address).min(1).max(50),
  cc: z.array(address).max(50).optional(),
  bcc: z.array(address).max(50).optional(),
  subject: z.string().max(300),
  body: z.string().min(1).max(100_000).describe('Plain text.'),
  inReplyTo: messageId.optional().describe('For a reply: the original’s messageId, from mail_read.'),
  references: z.array(messageId).max(19).optional().describe('For a reply: the original’s references.'),
}

const output = z.object({
  saved: z.literal(true),
  /** The new draft's Message-ID, without angle brackets: replace_draft takes it. */
  messageId: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  subject: z.string(),
  note: z.string(),
})

const NOTE = 'Saved to iCloud Drafts. Nothing was sent: the person reviews and sends it from Mail.'

function randomId(domain: string): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `<${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}@${domain}>`
}

type Fields = { [K in keyof typeof fields]: z.infer<(typeof fields)[K]> }

/** The draft as RFC 5322 text, and its Message-ID. Refuses anything the builder's rules don't allow. */
function draftMessage(input: Fields, now: number): { readonly text: string; readonly messageId: string } {
  if (!isMailAddress(input.from)) throw new ValetError('tool-input', 'invalid')
  if (input.fromName !== undefined && !/^[A-Za-z0-9][A-Za-z0-9 .'-]{0,63}$/.test(input.fromName))
    throw new ValetError('tool-input', 'invalid')
  const references = (input.references ?? []).map(bracketed)
  const inReplyTo = input.inReplyTo === undefined ? null : bracketed(input.inReplyTo)
  // A reply's own parent ends its references, as mail clients write them.
  if (inReplyTo !== null && !references.includes(inReplyTo)) references.push(inReplyTo)
  const message = checkMailMessage({
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    text: input.body,
    inReplyTo,
    references,
  })
  if (message === null) throw new ValetError('tool-input', 'invalid')
  const domain = input.from.slice(input.from.lastIndexOf('@') + 1)
  const id = randomId(domain)
  let text = buildMailMessage(input.from, message, { messageId: id, date: now })
  if (input.fromName !== undefined)
    text = text.replace(`From: ${input.from}\r\n`, `From: "${input.fromName}" <${input.from}>\r\n`)
  const extra = [
    ...(message.bcc.length > 0 ? [`Bcc: ${message.bcc.join(',\r\n ')}`] : []),
    'X-Uniform-Type-Identifier: com.apple.mail-draft',
  ]
  text = text.replace('\r\nMIME-Version: 1.0\r\n', `\r\n${extra.join('\r\n')}\r\nMIME-Version: 1.0\r\n`)
  return { text, messageId: id.slice(1, -1) }
}

async function save(ctx: ToolContext, input: Fields) {
  const draft = draftMessage(input, Date.now())
  await imap(ctx).append(DRAFTS, draft.text, { flags: ['\\Draft', '\\Seen'] })
  return {
    saved: true as const,
    messageId: draft.messageId,
    from: input.from,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    note: NOTE,
  }
}

export const tools = {
  create_draft: tool({
    input: z.object(fields).strict(),
    output,
    async run(ctx, input) {
      return save(ctx, input)
    },
  }),

  replace_draft: tool({
    input: z
      .object({
        draftMessageId: messageId.describe(
          'The messageId of the draft to replace, from mail_read or create_draft.',
        ),
        ...fields,
      })
      .strict(),
    output: output.extend({ replaced: z.number().int() }),
    async run(ctx, input) {
      const { draftMessageId, ...rest } = input
      const wanted = bracketed(draftMessageId)
      // IMAP's HEADER search matches any part of the header, so each match is checked whole.
      const found = await imap(ctx).search(
        DRAFTS,
        { header: { name: 'Message-ID', value: wanted } },
        { limit: 5 },
      )
      const exact =
        found.uids.length === 0
          ? []
          : (await imap(ctx).fetch(DRAFTS, found.uids)).messages
              .filter((m) => m.envelope?.messageId === wanted)
              .map((m) => m.uid)
      if (exact.length === 0) throw new ValetError('tool-input', 'not-found')
      // The new version first: if moving the old one fails, both are in Drafts and nothing is lost.
      const saved = await save(ctx, rest)
      const moved = await imap(ctx).move(DRAFTS, exact, DELETED)
      return { ...saved, replaced: moved.uids }
    },
  }),
}
