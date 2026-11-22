// The draft trial (docs/mail.md#drafts): does Mail's scripting save drafts reliably, with Mail
// closed and open, new and as replies? Run on a Mac whose Mail has a real account, by hand:
//
//   pnpm exec tsx packages/native-mail/scripts/draft-trial.ts --rounds 5 [--account "iCloud"] [--reply]
//
// Each trial draft is addressed to nobody, carries a marker in its subject (or its body, for a
// reply), and is deleted at the end. Nothing is ever sent: the script only calls MailDrafts.save,
// the same code the mail_create_draft tool uses, and Mail's own `save`. It prints one JSON line per
// attempt and a summary. It never runs in CI or in tests.

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { MailDrafts } from '../src/drafts'

interface Args {
  readonly rounds: number
  readonly account: string | null
  readonly reply: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let rounds = 3
  let account: string | null = null
  let reply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--rounds') rounds = Math.max(1, Math.min(20, Number(argv[++i] ?? '3') || 3))
    else if (a === '--account') account = argv[++i] ?? null
    else if (a === '--reply') reply = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return { rounds, account, reply }
}

function jxa(script: string, arg: unknown): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, JSON.stringify(arg)],
      { timeout: 60_000 },
      (error, stdout, stderr) =>
        resolve({ ok: error === null, out: String(stdout).trim(), err: String(stderr).trim() }),
    )
  })
}

const QUIT = `function run() { var m = Application('Mail'); if (m.running()) m.quit(); delay(3); return String(Application('Mail').running()); }`
const OPEN = `function run() { var m = Application('Mail'); m.launch(); delay(5); return String(m.running()); }`

/** The account's address, and the newest message in its inbox to reply to. */
const PICK = `function run(argv) {
  var req = JSON.parse(argv[0]); var Mail = Application('Mail');
  var accts = Mail.accounts().filter(function (a) { return !req.account || a.name() === req.account; });
  if (accts.length === 0) return JSON.stringify({ error: 'no-account' });
  var a = accts[0]; var out = { account: a.name(), id: a.id(), address: (a.emailAddresses() || [])[0] || null, reply: null };
  if (req.reply) {
    var inbox = a.mailboxes.byName('INBOX'); var msgs = inbox.messages();
    if (msgs.length > 0) { var m = msgs[0]; out.reply = { messageId: m.messageId(), subject: m.subject() }; }
  }
  return JSON.stringify(out);
}`

/** How many drafts carry the marker, deleting them when asked. */
const FIND = `function run(argv) {
  var req = JSON.parse(argv[0]); var Mail = Application('Mail'); var n = 0;
  Mail.accounts().forEach(function (a) {
    var box; try { box = Mail.draftsMailbox().mailboxes.byName(a.name()); box.name(); } catch (e) { box = null; }
    var boxes = box ? [box] : [];
    try { a.mailboxes().forEach(function (b) { if (/draft/i.test(b.name())) boxes.push(b); }); } catch (e) {}
    boxes.forEach(function (b) {
      try {
        b.messages().forEach(function (m) {
          var hit = m.subject().indexOf(req.marker) >= 0 || (req.body && m.content().indexOf(req.marker) >= 0);
          if (hit) { n++; if (req.remove) Mail.delete(m); }
        });
      } catch (e) {}
    });
  });
  return String(n);
}`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const drafts = new MailDrafts()
  const pick = await jxa(PICK, { account: args.account, reply: args.reply })
  if (!pick.ok) throw new Error(`could not read Mail's accounts: ${pick.err}`)
  const target = JSON.parse(pick.out) as {
    error?: string
    account: string
    id: string
    address: string | null
    reply: { messageId: string; subject: string } | null
  }
  if (target.error !== undefined) throw new Error(target.error)
  const results: Record<string, { saved: number; found: number; tries: number; ms: number[] }> = {}
  const kinds = args.reply && target.reply !== null ? ['new', 'reply'] : ['new']
  const markers: string[] = []
  for (let round = 0; round < args.rounds; round++) {
    for (const mailOpen of [false, true]) {
      for (const kind of kinds) {
        await jxa(mailOpen ? OPEN : QUIT, null)
        const marker = `valet-trial-${randomBytes(4).toString('hex')}`
        markers.push(marker)
        const started = Date.now()
        const outcome = await drafts.save({
          from: target.address,
          to: [],
          cc: [],
          bcc: [],
          subject: `${marker} (Valet draft trial, safe to delete)`,
          body: `Valet draft trial ${marker}. Nothing was sent.`,
          replyTo:
            kind === 'reply' && target.reply !== null
              ? { messageId: target.reply.messageId, accountId: target.id, mailbox: 'INBOX', all: false }
              : null,
        })
        const ms = Date.now() - started
        // Give Mail a moment to file it, then look in Drafts.
        await new Promise((r) => setTimeout(r, 3000))
        const found = Number((await jxa(FIND, { marker, body: kind === 'reply', remove: false })).out) || 0
        const key = `${kind}, Mail ${mailOpen ? 'open' : 'closed'}`
        const r = results[key] ?? { saved: 0, found: 0, tries: 0, ms: [] }
        r.tries += 1
        if (outcome.kind === 'saved') r.saved += 1
        if (found > 0) r.found += 1
        r.ms.push(ms)
        results[key] = r
        process.stdout.write(
          `${JSON.stringify({ round, kind, mailOpen, outcome: outcome.kind, inDrafts: found, ms })}\n`,
        )
      }
    }
  }
  let removed = 0
  for (const marker of markers)
    removed += Number((await jxa(FIND, { marker, body: true, remove: true })).out) || 0
  process.stdout.write(`${JSON.stringify({ summary: results, removed })}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`draft trial: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
