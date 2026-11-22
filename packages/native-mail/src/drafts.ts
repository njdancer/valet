// Drafts through Mail's scripting interface (docs/mail.md): Valet asks Mail to make a message and
// save it, which puts it in the account's Drafts mailbox, where Mail syncs it to the server like
// any draft the person wrote. Nothing is sent. Mail starts if it isn't running. macOS asks the
// person once whether Valet may control Mail.
//
// The script is fixed; the draft travels as one JSON argument, never as script text.

import { execFile } from 'node:child_process'

export interface DraftRequest {
  /** The address the draft is from: one of the account's own addresses. Null: Mail's default. */
  readonly from: string | null
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly subject: string
  readonly body: string
  /**
   * Reply to this message instead: its Message-ID (no angle brackets), and where Mail keeps it,
   * so Mail sets the headers that keep the reply in its thread.
   */
  readonly replyTo: {
    readonly messageId: string
    readonly accountId: string
    readonly mailbox: string
    readonly all: boolean
  } | null
}

export type DraftOutcome =
  | { readonly kind: 'saved' }
  /** The person hasn't let Valet control Mail (or said no to macOS's question). */
  | { readonly kind: 'not-allowed' }
  /** Mail couldn't find the message being replied to. */
  | { readonly kind: 'reply-not-found' }
  | { readonly kind: 'failed' }

export const DRAFT_SCRIPT = String.raw`
function run(argv) {
  var req = JSON.parse(argv[0]);
  var Mail = Application('Mail');
  var msg = null;
  // A Mail that was closed starts here; its accounts and mailboxes take a moment to load, and a
  // reply's search before then can hang (the trial on a real Mac, docs/mail.md#scripting-or-imap).
  if (!Mail.running()) {
    Mail.launch();
    for (var w = 0; w < 30; w++) {
      try { if (Mail.accounts().length > 0) break; } catch (e) {}
      delay(1);
    }
    delay(2);
  }
  if (req.replyTo) {
    var original = null;
    // The account Mail's files name first; Mail's scripting id is usually the same, but not always.
    var accounts = Mail.accounts().slice().sort(function (a, b) {
      return (b.id() === req.replyTo.accountId ? 1 : 0) - (a.id() === req.replyTo.accountId ? 1 : 0);
    });
    for (var attempt = 0; attempt < 3 && original === null; attempt++) {
      if (attempt > 0) delay(2);
      for (var i = 0; i < accounts.length && original === null; i++) {
        var box = accounts[i].mailboxes.byName(req.replyTo.mailbox);
        try {
          var found = box.messages.whose({ messageId: req.replyTo.messageId })();
          if (found.length > 0) original = found[0];
        } catch (e) {}
      }
    }
    if (original === null) return JSON.stringify({ kind: 'reply-not-found' });
    msg = Mail.reply(original, { openingWindow: false, replyToAll: req.replyTo.all });
    msg.content = req.body;
  } else {
    msg = Mail.OutgoingMessage({ subject: req.subject, content: req.body, visible: false });
    Mail.outgoingMessages.push(msg);
  }
  if (req.from) msg.sender = req.from;
  // A reply already has the original's sender (and, for reply-all, its recipients): add only the
  // addresses it doesn't have yet.
  var have = {};
  [msg.toRecipients, msg.ccRecipients, msg.bccRecipients].forEach(function (list) {
    try { list().forEach(function (r) { have[String(r.address()).toLowerCase()] = true; }); } catch (e) {}
  });
  var add = function (list, addresses) {
    for (var j = 0; j < addresses.length; j++) {
      var key = String(addresses[j]).toLowerCase();
      if (have[key]) continue;
      have[key] = true;
      list.push(Mail.Recipient({ address: addresses[j] }));
    }
  };
  add(msg.toRecipients, req.to);
  add(msg.ccRecipients, req.cc);
  add(msg.bccRecipients, req.bcc);
  msg.save();
  // Close the message, saving it again, so no compose window (hidden or not) is left behind.
  // Closing without saving would discard the draft just saved.
  try { delay(0.5); msg.close({ saving: 'yes' }); } catch (e) {}
  return JSON.stringify({ kind: 'saved' });
}
`

/**
 * Closes, without saving, the unsaved outgoing messages a hung attempt left for this draft (same
 * subject and body). Closing without saving discards; it never sends.
 */
export const DISCARD_SCRIPT = String.raw`
function run(argv) {
  var req = JSON.parse(argv[0]);
  var Mail = Application('Mail');
  if (!Mail.running()) return '0';
  var n = 0;
  Mail.outgoingMessages().forEach(function (m) {
    try {
      if (m.subject() === req.subject && String(m.content()).indexOf(req.body) >= 0) {
        m.close({ saving: 'no' });
        n++;
      }
    } catch (e) {}
  });
  return String(n);
}
`

export type Runner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>

export const execRunner: Runner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

/** Mail's -1743: the person hasn't allowed this app to control Mail. */
const NOT_ALLOWED = /-1743|not allowed to send Apple events|Not authorized/i

export class MailDrafts {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly timeoutMs = 60_000,
  ) {}

  /**
   * One retry: on a real Mac, about one in twenty drafts made right after Mail started hung until
   * the timeout, leaving an unsaved compose message (docs/mail.md#scripting-or-imap). That leftover
   * is discarded, never saved or sent, and the draft is made once more.
   */
  async save(draft: DraftRequest): Promise<DraftOutcome> {
    const first = await this.once(draft)
    if (first.kind !== 'failed') return first
    await this.run(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        DISCARD_SCRIPT,
        JSON.stringify({ subject: draft.subject, body: draft.body }),
      ],
      15_000,
    )
    return this.once(draft)
  }

  private async once(draft: DraftRequest): Promise<DraftOutcome> {
    const result = await this.run(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', DRAFT_SCRIPT, JSON.stringify(draft)],
      this.timeoutMs,
    )
    if (result.code !== 0) {
      return NOT_ALLOWED.test(result.stderr) ? { kind: 'not-allowed' } : { kind: 'failed' }
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { kind?: unknown }
      if (parsed.kind === 'saved') return { kind: 'saved' }
      if (parsed.kind === 'reply-not-found') return { kind: 'reply-not-found' }
    } catch {
      // Below.
    }
    return { kind: 'failed' }
  }
}
