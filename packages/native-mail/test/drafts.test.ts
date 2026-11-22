import { describe, expect, it } from 'vitest'
import { DRAFT_SCRIPT, type DraftRequest, MailDrafts, type Runner } from '../src/drafts'

const draft: DraftRequest = {
  from: null,
  to: ['a@b.c'],
  cc: [],
  bcc: [],
  subject: '"); doShellScript("rm -rf ~"); ("',
  body: 'x',
  replyTo: null,
}

describe('MailDrafts', () => {
  it('passes the draft as data, never as script', async () => {
    const calls: (readonly string[])[] = []
    const run: Runner = async (file, args) => {
      calls.push([file, ...args])
      return { code: 0, stdout: '{"kind":"saved"}\n', stderr: '' }
    }
    expect(await new MailDrafts(run).save(draft)).toEqual({ kind: 'saved' })
    expect(calls[0]).toEqual([
      '/usr/bin/osascript',
      '-l',
      'JavaScript',
      '-e',
      DRAFT_SCRIPT,
      JSON.stringify(draft),
    ])
    expect(DRAFT_SCRIPT).not.toContain(draft.subject)
  })

  it('tells "not allowed to control Mail" from other failures', async () => {
    const refuse: Runner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'execution error: Not authorized to send Apple events to Mail. (-1743)',
    })
    expect(await new MailDrafts(refuse).save(draft)).toEqual({ kind: 'not-allowed' })
    const broken: Runner = async () => ({ code: 1, stdout: '', stderr: 'something else' })
    expect(await new MailDrafts(broken).save(draft)).toEqual({ kind: 'failed' })
    const odd: Runner = async () => ({ code: 0, stdout: 'garbage', stderr: '' })
    expect(await new MailDrafts(odd).save(draft)).toEqual({ kind: 'failed' })
    const missing: Runner = async () => ({ code: 0, stdout: '{"kind":"reply-not-found"}', stderr: '' })
    expect(await new MailDrafts(missing).save(draft)).toEqual({ kind: 'reply-not-found' })
  })
})

// The JXA script itself, run in Node against a made-up Mail object model: what it asks Mail to do.
describe('DRAFT_SCRIPT', () => {
  interface FakeMessage {
    toRecipients: (() => { address: () => string }[]) & { push: (r: { address: string }) => void }
    ccRecipients: FakeMessage['toRecipients']
    bccRecipients: FakeMessage['toRecipients']
    content?: string
    sender?: string
    saved: number
    closed: unknown[]
    save: () => void
    close: (options: unknown) => void
  }

  function list(initial: string[] = []): FakeMessage['toRecipients'] {
    const items = initial.map((address) => ({ address: () => address }))
    const fn = (() => items) as FakeMessage['toRecipients']
    fn.push = (r) => void items.push({ address: () => r.address })
    return fn
  }

  function message(to: string[] = []): FakeMessage {
    const m: FakeMessage = {
      toRecipients: list(to),
      ccRecipients: list(),
      bccRecipients: list(),
      saved: 0,
      closed: [],
      save: () => {
        m.saved += 1
      },
      close: (options) => {
        m.closed.push(options)
      },
    }
    return m
  }

  function run(request: DraftRequest, mail: { running: boolean; original?: FakeMessage | null }) {
    const created: FakeMessage[] = []
    let launched = 0
    let accountsAsked = 0
    const original = mail.original ?? null
    const Mail = {
      running: () => mail.running,
      launch: () => {
        launched += 1
      },
      accounts: () => {
        accountsAsked += 1
        // A freshly started Mail has no accounts loaded for the first two looks.
        if (launched > 0 && accountsAsked <= 2) return []
        return [
          {
            id: () => 'ACCT',
            mailboxes: {
              byName: () => ({
                messages: { whose: () => () => (original === null ? [] : [original]) },
              }),
            },
          },
        ]
      },
      reply: () => {
        const r = message(['ada@example.com'])
        created.push(r)
        return r
      },
      OutgoingMessage: () => {
        const m = message()
        created.push(m)
        return m
      },
      outgoingMessages: { push: () => {} },
      Recipient: (r: { address: string }) => r,
    }
    const delays: number[] = []
    const fn = new Function('Application', 'delay', `${DRAFT_SCRIPT}; return run;`)(
      () => Mail,
      (s: number) => delays.push(s),
    ) as (argv: string[]) => string
    const out = JSON.parse(fn([JSON.stringify(request)])) as { kind: string }
    return { out, created, launched, delays }
  }

  const base: DraftRequest = { from: null, to: [], cc: [], bcc: [], subject: 'S', body: 'B', replyTo: null }

  it('saves a new draft and closes it saving, so no window is left behind', () => {
    const { out, created } = run({ ...base, to: ['bo@example.com'] }, { running: true })
    expect(out).toEqual({ kind: 'saved' })
    expect(created).toHaveLength(1)
    expect(created[0]?.saved).toBe(1)
    expect(created[0]?.closed).toEqual([{ saving: 'yes' }])
    expect(created[0]?.toRecipients().map((r) => r.address())).toEqual(['bo@example.com'])
  })

  it('waits for a freshly started Mail to load its accounts before replying', () => {
    const { out, launched, delays } = run(
      { ...base, replyTo: { messageId: 'm1', accountId: 'ACCT', mailbox: 'INBOX', all: false } },
      { running: false, original: message() },
    )
    expect(out).toEqual({ kind: 'saved' })
    expect(launched).toBe(1)
    expect(delays.filter((d) => d === 1).length).toBeGreaterThanOrEqual(2)
  })

  it('adds only the recipients a reply doesn’t already have', () => {
    const { created } = run(
      {
        ...base,
        to: ['ADA@example.com', 'cy@example.com'],
        replyTo: { messageId: 'm1', accountId: 'ACCT', mailbox: 'INBOX', all: false },
      },
      { running: true, original: message() },
    )
    expect(created[0]?.toRecipients().map((r) => r.address())).toEqual(['ada@example.com', 'cy@example.com'])
    expect(created[0]?.closed).toEqual([{ saving: 'yes' }])
  })

  it('says when the message being replied to isn’t there, after trying again', () => {
    const { out, created, delays } = run(
      { ...base, replyTo: { messageId: 'gone', accountId: 'ACCT', mailbox: 'INBOX', all: false } },
      { running: true, original: null },
    )
    expect(out).toEqual({ kind: 'reply-not-found' })
    expect(created).toEqual([])
    expect(delays).toEqual([2, 2])
  })
})
