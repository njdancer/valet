// Moving and marking messages through Mail's scripting interface (docs/mail.md#organising), the
// same way drafts are saved: Mail makes the change and syncs it to the server as if the person had.
// A move goes to another mailbox of the same account; "delete" is a move to the account's Trash,
// so nothing is ever erased here. Mail starts if it isn't running.
//
// The script is fixed; the request travels as one JSON argument, never as script text.

import { execRunner, type Runner } from './drafts'

/** One message as Mail's scripting finds it: by Message-ID, in the mailbox Mail's files name. */
export interface OrganizeItem {
  /** The Message-ID header, without angle brackets. */
  readonly messageId: string
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
  var results = [];
  for (var k = 0; k < req.items.length; k++) {
    var item = req.items[k];
    var account = accountFor(item.accountId);
    var box = account === null ? null : boxAt(account, item.mailbox);
    var msg = null;
    if (box !== null) {
      try {
        var found = box.messages.whose({ messageId: item.messageId })();
        if (found.length > 0) msg = found[0];
      } catch (e) {}
    }
    if (msg === null) { results.push('not-found'); continue; }
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

/** Mail's -1743: the person hasn't allowed this app to control Mail. */
const NOT_ALLOWED = /-1743|not allowed to send Apple events|Not authorized/i

export class MailOrganizer {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly timeoutMs = 120_000,
  ) {}

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
