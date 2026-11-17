// The example IMAP adapter (docs/imap.md): an iCloud inbox, read only. It is the adapter for the
// first live check against a real mailbox (docs/live-checks/icloud-mail-read.md), so it does as
// little as it can: two read tools, INBOX only, envelopes only. ctx.imap opens INBOX with EXAMINE
// and fetches with BODY.PEEK, so nothing on the server changes, and Valet signs in with the kept
// credential "mail" itself.

import { type ImapAccess, type ImapSummary, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

const INBOX = 'INBOX'

/** ctx.imap, which a protocol adapter with protocols.imap always has. */
function imap(ctx: ToolContext): ImapAccess {
  if (ctx.imap === undefined) throw new ValetError('tool-run', 'not-granted')
  return ctx.imap
}

/** A header value as shown: one line, at most `max` characters. */
const line = (value: string | null | undefined, max: number): string | null =>
  value === null || value === undefined ? null : value.replace(/\s+/g, ' ').trim().slice(0, max)

const summary = z.object({
  from: z.string().max(200).nullable(),
  subject: z.string().max(200).nullable(),
  date: z.string().max(60).nullable(),
  read: z.boolean(),
})

function shown(message: ImapSummary): z.infer<typeof summary> {
  const envelope = message.envelope
  return {
    from: line(envelope?.from[0]?.address, 200),
    subject: line(envelope?.subject, 200),
    date: line(envelope?.date ?? message.internalDate, 60),
    read: message.flags.includes('\\Seen'),
  }
}

export const tools = {
  inbox_overview: tool({
    input: z.object({}).strict(),
    output: z.object({ messages: z.number().int().nullable(), unread: z.number().int().nullable() }),
    async run(ctx) {
      const status = await imap(ctx).status(INBOX)
      return { messages: status.messages, unread: status.unseen }
    },
  }),

  recent_mail: tool({
    input: z.object({ count: z.number().int().min(1).max(10).default(5) }).strict(),
    output: z.object({ total: z.number().int(), messages: z.array(summary).max(10) }),
    async run(ctx, input) {
      const found = await imap(ctx).search(INBOX, undefined, { limit: input.count })
      if (found.uids.length === 0) return { total: found.total, messages: [] }
      const fetched = await imap(ctx).fetch(INBOX, found.uids)
      // Newest first, as search gave them.
      const byUid = new Map(fetched.messages.map((m) => [m.uid, m]))
      const messages = found.uids.flatMap((uid) => {
        const m = byUid.get(uid)
        return m === undefined ? [] : [shown(m)]
      })
      return { total: found.total, messages }
    },
  }),
}
