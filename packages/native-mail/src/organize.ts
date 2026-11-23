// Moving and marking messages through Mail's scripting interface (docs/mail.md#organising), the
// same way drafts are saved: Mail makes the change and syncs it to the server as if the person had.
// A move goes to another mailbox of the same account; "delete" is a move to the account's Trash,
// so nothing is ever erased here. Mail starts if it isn't running.
//
// The script is fixed; the request travels as one JSON argument, never as script text.

import { execFile } from 'node:child_process'
import { execRunner, type Runner } from './drafts'

/**
 * One message as Mail's scripting finds it, in the mailbox Mail's files name: by Message-ID; for
 * a message without one (some test tools and old mail), by Mail's own id with its subject checked,
 * then by subject, sender and date, only when exactly one message matches.
 */
export interface OrganizeItem {
  /** The Message-ID header, without angle brackets; null when the message has none. */
  readonly messageId: string | null
  /** Mail's id for the message (its row in Mail's files), where it is now. */
  readonly rowId?: number
  readonly subject?: string
  /** The sender's address. */
  readonly sender?: string | null
  /** When it was received (ISO). */
  readonly date?: string | null
  /** Mail's id for the account (its folder name in the library). */
  readonly accountId: string
  /** The mailbox it is in now, as a folder path ("INBOX", "Archive/2025"). */
  readonly mailbox: string
}

export type OrganizeRequest =
  | {
      readonly kind: 'move'
      readonly items: readonly OrganizeItem[]
      /** The mailbox path to move to, in each item's own account. */
      readonly to: string
    }
  | {
      /** One message's whole source (the first item only), to read an attachment Mail hasn't downloaded. */
      readonly kind: 'source'
      readonly items: readonly OrganizeItem[]
    }
  | {
      readonly kind: 'mark'
      readonly items: readonly OrganizeItem[]
      readonly read?: boolean
      readonly flagged?: boolean
    }

export type OrganizeOutcome =
  /** One entry per item, in order: done, or not found where Mail's files said it was. */
  | { readonly kind: 'done'; readonly results: readonly ('done' | 'not-found')[] }
  /** The person hasn't let Valet control Mail (or said no to macOS's question). */
  | { readonly kind: 'not-allowed' }
  /** The destination mailbox doesn't exist in Mail. */
  | { readonly kind: 'no-mailbox' }
  | { readonly kind: 'failed' }

export const ORGANIZE_SCRIPT = String.raw`
function run(argv) {
  var req = JSON.parse(argv[0]);
  var Mail = Application('Mail');
  if (!Mail.running()) {
    Mail.launch();
    for (var w = 0; w < 30; w++) {
      try { if (Mail.accounts().length > 0) break; } catch (e) {}
      delay(1);
    }
    delay(2);
  }
  var accounts = Mail.accounts();
  var accountFor = function (id) {
    for (var i = 0; i < accounts.length; i++) {
      try { if (accounts[i].id() === id) return accounts[i]; } catch (e) {}
    }
    return null;
  };
  // "Archive/2025" is a mailbox inside a mailbox: walk it, else try the whole path as one name.
  var boxAt = function (account, path) {
    var parts = String(path).split('/');
    try {
      var box = account.mailboxes.byName(parts[0]);
      for (var p = 1; p < parts.length; p++) box = box.mailboxes.byName(parts[p]);
      box.name();
      return box;
    } catch (e) {}
    try { var whole = account.mailboxes.byName(path); whole.name(); return whole; } catch (e) {}
    return null;
  };
  var sameMessage = function (m, item) {
    try {
      if (typeof item.subject === 'string' && m.subject() !== item.subject) return false;
      if (typeof item.sender === 'string' && String(m.sender()).toLowerCase().indexOf(item.sender.toLowerCase()) < 0)
        return false;
      if (typeof item.date === 'string') {
        var when = Date.parse(item.date);
        if (!isNaN(when) && Math.abs(m.dateReceived().getTime() - when) > 2000) return false;
      }
      return true;
    } catch (e) { return false; }
  };
  var findIn = function (box, item) {
    if (typeof item.messageId === 'string' && item.messageId.length > 0) {
      try {
        var byHeader = box.messages.whose({ messageId: item.messageId })();
        if (byHeader.length > 0) return byHeader[0];
      } catch (e) {}
      return null;
    }
    // No Message-ID: Mail's own id, then subject, sender and date. Never a guess between two.
    if (typeof item.subject !== 'string') return null;
    if (typeof item.rowId === 'number') {
      try {
        var own = box.messages.byId(item.rowId);
        if (sameMessage(own, item)) return own;
      } catch (e) {}
    }
    try {
      var named = box.messages.whose({ subject: item.subject })();
      var hits = [];
      for (var h = 0; h < named.length && hits.length < 2; h++) if (sameMessage(named[h], item)) hits.push(named[h]);
      if (hits.length === 1) return hits[0];
    } catch (e) {}
    return null;
  };
  var results = [];
  for (var k = 0; k < req.items.length; k++) {
    var item = req.items[k];
    var account = accountFor(item.accountId);
    var box = account === null ? null : boxAt(account, item.mailbox);
    var msg = box === null ? null : findIn(box, item);
    if (msg === null) { results.push('not-found'); continue; }
    if (req.kind === 'source') {
      // The whole message as Mail has it; Mail fetches what it hasn't downloaded from the server.
      return JSON.stringify({ kind: 'source', source: String(msg.source()) });
    }
    if (req.kind === 'move') {
      var dest = boxAt(account, req.to);
      if (dest === null) return JSON.stringify({ kind: 'no-mailbox' });
      Mail.move(msg, { to: dest });
    } else {
      if (typeof req.read === 'boolean') msg.readStatus = req.read;
      if (typeof req.flagged === 'boolean') msg.flaggedStatus = req.flagged;
    }
    results.push('done');
  }
  return JSON.stringify({ kind: 'done', results: results });
}
`

export type SourceOutcome =
  | { readonly kind: 'done'; readonly source: Buffer }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-allowed' }
  | { readonly kind: 'failed' }

/** A whole message's source can be large: 25 MB of attachments, as base64 and JSON. */
const sourceRunner: Runner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

/** Mail's -1743: the person hasn't allowed this app to control Mail. */
const NOT_ALLOWED = /-1743|not allowed to send Apple events|Not authorized/i

export class MailOrganizer {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly timeoutMs = 120_000,
    private readonly runSource: Runner = sourceRunner,
  ) {}

  /** One message's whole source through Mail, which downloads it first if it must. Read-only. */
  async source(item: OrganizeItem): Promise<SourceOutcome> {
    const result = await this.runSource(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', ORGANIZE_SCRIPT, JSON.stringify({ kind: 'source', items: [item] })],
      this.timeoutMs,
    )
    if (result.code !== 0)
      return NOT_ALLOWED.test(result.stderr) ? { kind: 'not-allowed' } : { kind: 'failed' }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as {
        kind?: unknown
        source?: unknown
        results?: unknown
      }
      if (parsed.kind === 'source' && typeof parsed.source === 'string' && parsed.source.length > 0)
        return { kind: 'done', source: Buffer.from(parsed.source, 'utf8') }
      if (parsed.kind === 'done') return { kind: 'not-found' }
    } catch {
      // Below.
    }
    return { kind: 'failed' }
  }

  async apply(request: OrganizeRequest): Promise<OrganizeOutcome> {
    if (request.items.length === 0) return { kind: 'done', results: [] }
    const result = await this.run(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', ORGANIZE_SCRIPT, JSON.stringify(request)],
      this.timeoutMs,
    )
    if (result.code !== 0) {
      return NOT_ALLOWED.test(result.stderr) ? { kind: 'not-allowed' } : { kind: 'failed' }
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { kind?: unknown; results?: unknown }
      if (parsed.kind === 'no-mailbox') return { kind: 'no-mailbox' }
      if (
        parsed.kind === 'done' &&
        Array.isArray(parsed.results) &&
        parsed.results.length === request.items.length &&
        parsed.results.every((r) => r === 'done' || r === 'not-found')
      )
        return { kind: 'done', results: parsed.results as ('done' | 'not-found')[] }
    } catch {
      // Below.
    }
    return { kind: 'failed' }
  }
}
