// Moving and marking (docs/mail.md#organising): the fixed JXA script run in Node against a made-up
// Mail object model, MailOrganizer's reading of its answers, and the move and mark tools against
// the made-up library. Nothing touches real Mail.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectMailFiles } from '../src/direct-files'
import { MailOrganizer, ORGANIZE_SCRIPT, type OrganizeOutcome, type OrganizeRequest } from '../src/organize'
import { MailStore } from '../src/store'
import { callMailTool, type MailToolDeps, type MoveRecord, mailOutputs, mailTools } from '../src/tools'
import { ALLOWED, buildLibrary, OTHER } from './fixture-library'

describe('ORGANIZE_SCRIPT', () => {
  interface FakeMessage {
    id: string
    /** Mail's own id. */
    row?: number
    subject?: () => string
    sender?: () => string
    dateReceived?: () => Date
    readStatus?: boolean
    flaggedStatus?: boolean
  }
  interface FakeBox {
    name: () => string
    messages: {
      whose: (q: { messageId?: string; subject?: string }) => () => FakeMessage[]
      byId: (n: number) => FakeMessage
    }
    mailboxes: { byName: (n: string) => FakeBox }
    items: FakeMessage[]
  }

  function box(name: string, items: FakeMessage[] = [], children: Record<string, FakeBox> = {}): FakeBox {
    return {
      name: () => name,
      items,
      messages: {
        whose: (q) => () =>
          items.filter((m) =>
            q.messageId !== undefined
              ? m.id === q.messageId
              : m.subject !== undefined && m.subject() === q.subject,
          ),
        byId: (n) => {
          const found = items.find((m) => m.row === n)
          if (found === undefined) throw new Error('no such message')
          return found
        },
      },
      mailboxes: { byName: (n) => children[n] ?? missing() },
    }
  }
  function missing(): FakeBox {
    const fail = () => {
      throw new Error('no such mailbox')
    }
    return {
      name: fail,
      items: [],
      messages: { whose: () => fail, byId: fail },
      mailboxes: { byName: () => missing() },
    }
  }

  function run(request: OrganizeRequest, boxes: Record<string, FakeBox>, running = true) {
    const moves: [string, string][] = []
    let launched = 0
    const account = { id: () => ALLOWED, mailboxes: { byName: (n: string) => boxes[n] ?? missing() } }
    const Mail = {
      running: () => running,
      launch: () => {
        launched += 1
      },
      accounts: () => [{ id: () => 'SOMEONE-ELSE', mailboxes: { byName: () => missing() } }, account],
      move: (msg: FakeMessage, options: { to: FakeBox }) => {
        moves.push([msg.id, options.to.name()])
      },
    }
    const fn = new Function('Application', 'delay', `${ORGANIZE_SCRIPT}; return run;`)(
      () => Mail,
      () => undefined,
    ) as (argv: string[]) => string
    return { out: JSON.parse(fn([JSON.stringify(request)])) as OrganizeOutcome, moves, launched }
  }

  const item = (messageId: string, mailbox = 'INBOX') => ({ messageId, accountId: ALLOWED, mailbox })

  it('moves each message found in its mailbox to the destination of the same account', () => {
    const boxes = {
      INBOX: box('INBOX', [{ id: 'a' }, { id: 'b' }]),
      'Deleted Messages': box('Deleted Messages'),
    }
    const { out, moves } = run(
      { kind: 'move', items: [item('a'), item('gone'), item('b')], to: 'Deleted Messages' },
      boxes,
    )
    expect(out).toEqual({ kind: 'done', results: ['done', 'not-found', 'done'] })
    expect(moves).toEqual([
      ['a', 'Deleted Messages'],
      ['b', 'Deleted Messages'],
    ])
  })

  describe('a message without a Message-ID', () => {
    const when = '2026-04-11T06:41:20.000Z'
    const bare = (
      id: string,
      row: number,
      subject: string,
      sender = 'test@glovebox.local',
      at = when,
    ): FakeMessage => ({
      id,
      row,
      subject: () => subject,
      sender: () => sender,
      dateReceived: () => new Date(at),
    })
    const noHeader = (over: Partial<Record<string, unknown>> = {}) => ({
      messageId: null,
      accountId: ALLOWED,
      mailbox: 'INBOX',
      rowId: 34504,
      subject: 'Session resume test',
      sender: 'test@glovebox.local',
      date: when,
      ...over,
    })
    const trash = () => box('Deleted Messages')

    it('is found by Mail’s own id when its subject matches', () => {
      const boxes = {
        INBOX: box('INBOX', [bare('x', 34504, 'Session resume test')]),
        'Deleted Messages': trash(),
      }
      const { out, moves } = run({ kind: 'move', items: [noHeader()], to: 'Deleted Messages' }, boxes)
      expect(out).toEqual({ kind: 'done', results: ['done'] })
      expect(moves).toEqual([['x', 'Deleted Messages']])
    })

    it('is found by subject, sender and date when its id has changed (as after a move)', () => {
      const boxes = {
        INBOX: box('INBOX', [
          bare('other', 34504, 'Something else'),
          bare('x', 50001, 'Session resume test', 'Test <TEST@glovebox.local>', '2026-04-11T06:41:21.000Z'),
        ]),
        'Deleted Messages': trash(),
      }
      expect(run({ kind: 'move', items: [noHeader()], to: 'Deleted Messages' }, boxes).moves).toEqual([
        ['x', 'Deleted Messages'],
      ])
    })

    it('is never a guess: two that match, or a different sender or date, are not found', () => {
      const twins = {
        INBOX: box('INBOX', [bare('a', 1, 'Session resume test'), bare('b', 2, 'Session resume test')]),
        'Deleted Messages': trash(),
      }
      expect(
        run({ kind: 'move', items: [noHeader({ rowId: 99 })], to: 'Deleted Messages' }, twins).out,
      ).toEqual({
        kind: 'done',
        results: ['not-found'],
      })
      const unlike = {
        INBOX: box('INBOX', [
          bare('a', 1, 'Session resume test', 'someone@else.example'),
          bare('b', 34504, 'Session resume test', 'test@glovebox.local', '2026-05-01T00:00:00.000Z'),
        ]),
        'Deleted Messages': trash(),
      }
      const { out, moves } = run({ kind: 'move', items: [noHeader()], to: 'Deleted Messages' }, unlike)
      expect(out).toEqual({ kind: 'done', results: ['not-found'] })
      expect(moves).toEqual([])
    })
  })

  it('walks nested mailboxes, and says when the destination doesn’t exist', () => {
    const boxes = {
      INBOX: box('INBOX', [{ id: 'a' }]),
      Archive: box('Archive', [], { '2025': box('2025') }),
    }
    expect(run({ kind: 'move', items: [item('a')], to: 'Archive/2025' }, boxes).moves).toEqual([
      ['a', '2025'],
    ])
    expect(run({ kind: 'move', items: [item('a')], to: 'Nowhere' }, boxes).out).toEqual({
      kind: 'no-mailbox',
    })
  })

  it('marks read and flagged, and only what was asked', () => {
    const a: FakeMessage = { id: 'a' }
    const boxes = { INBOX: box('INBOX', [a]) }
    expect(run({ kind: 'mark', items: [item('a')], read: true }, boxes).out).toEqual({
      kind: 'done',
      results: ['done'],
    })
    expect(a).toEqual({ id: 'a', readStatus: true })
    run({ kind: 'mark', items: [item('a')], flagged: false }, boxes)
    expect(a).toEqual({ id: 'a', readStatus: true, flaggedStatus: false })
  })

  it('gives one message’s whole source, and nothing for a message it can’t find', () => {
    const a = { id: 'a', source: () => 'From: x\r\n\r\nbody' }
    const boxes = { INBOX: box('INBOX', [a as FakeMessage]) }
    expect(run({ kind: 'source', items: [item('a')] }, boxes).out).toEqual({
      kind: 'source',
      source: 'From: x\r\n\r\nbody',
    })
    expect(run({ kind: 'source', items: [item('gone')] }, boxes).out).toEqual({
      kind: 'done',
      results: ['not-found'],
    })
  })

  it('starts Mail when it is closed', () => {
    expect(
      run({ kind: 'mark', items: [item('a')], read: true }, { INBOX: box('INBOX', [{ id: 'a' }]) }, false)
        .launched,
    ).toBe(1)
  })
})

describe('MailOrganizer', () => {
  const request: OrganizeRequest = {
    kind: 'move',
    items: [{ messageId: 'a', accountId: ALLOWED, mailbox: 'INBOX' }],
    to: 'Archive',
  }
  const organizer = (code: number, stdout: string, stderr = '') =>
    new MailOrganizer(async (file, args) => {
      expect(file).toBe('/usr/bin/osascript')
      // The request travels as data, never as script text.
      expect(args.at(-1)).toBe(JSON.stringify(request))
      return { code, stdout, stderr }
    })

  it('reads the script’s answers, and refuses anything else', async () => {
    expect(await organizer(0, '{"kind":"done","results":["done"]}\n').apply(request)).toEqual({
      kind: 'done',
      results: ['done'],
    })
    expect(await organizer(0, '{"kind":"no-mailbox"}').apply(request)).toEqual({ kind: 'no-mailbox' })
    expect(await organizer(0, '{"kind":"done","results":[]}').apply(request)).toEqual({ kind: 'failed' })
    expect(await organizer(0, 'garbage').apply(request)).toEqual({ kind: 'failed' })
    expect(
      await organizer(1, '', 'execution error: Not authorized to send Apple events (-1743)').apply(request),
    ).toEqual({ kind: 'not-allowed' })
  })

  it('reads a whole source, and treats an answer with none as not found', async () => {
    const item = { messageId: 'a', accountId: ALLOWED, mailbox: 'INBOX' }
    const withSource = (stdout: string, code = 0) =>
      new MailOrganizer(
        async () => ({ code: 0, stdout: '', stderr: '' }),
        1_000,
        async (_file, args) => {
          expect(JSON.parse(args.at(-1) as string)).toEqual({ kind: 'source', items: [item] })
          return { code, stdout, stderr: '' }
        },
      )
    const got = await withSource('{"kind":"source","source":"From: x\\r\\n\\r\\nhi"}').source(item)
    expect(got.kind === 'done' && got.source.toString()).toBe('From: x\r\n\r\nhi')
    expect(await withSource('{"kind":"done","results":["not-found"]}').source(item)).toEqual({
      kind: 'not-found',
    })
    expect(await withSource('nope').source(item)).toEqual({ kind: 'failed' })
    expect(await withSource('', 1).source(item)).toEqual({ kind: 'failed' })
  })
})

describe('the move and mark tools', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'valet-mail-organize-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function setup(
    options: {
      enabled?: boolean
      allowance?: number
      outcome?: OrganizeOutcome | null
      withTrash?: boolean
    } = {},
  ) {
    const store = new MailStore(
      new DirectMailFiles(
        buildLibrary(mkdtempSync(join(root, 'lib-')), { withTrash: options.withTrash ?? true }),
      ),
      {
        allowedAccounts: () => new Set([ALLOWED, OTHER]),
      },
    )
    const asked: OrganizeRequest[] = []
    const recorded: MoveRecord[] = []
    let allowance = options.allowance ?? 500
    const deps: MailToolDeps = {
      store,
      drafts: { save: async () => ({ kind: 'saved' }) },
      draftsEnabled: () => false,
      approveDraft: null,
      organize: {
        organizer: {
          apply: async (request) => {
            asked.push(request)
            return options.outcome ?? { kind: 'done', results: request.items.map(() => 'done' as const) }
          },
        },
        enabled: () => options.enabled ?? true,
        spend: (count) => {
          if (count > allowance) return false
          allowance -= count
          return true
        },
        moved: async (moves) => {
          recorded.push(...moves)
        },
      },
    }
    return { deps, asked, recorded }
  }

  it('are listed only while organising is on', () => {
    expect(mailTools({ drafts: false }).map((t) => t.declaration.name)).not.toContain('move')
    const on = mailTools({ drafts: false, organize: true })
    expect(on.map((t) => t.declaration.name)).toEqual([
      'accounts',
      'search',
      'read',
      'thread',
      'move',
      'mark',
    ])
    expect(on.find((t) => t.declaration.name === 'move')?.declaration).toMatchObject({
      sideEffect: 'write',
      destructive: false,
    })
  })

  it('moves to the account’s Trash, records each message for Undo, and answers in its shape', async () => {
    const s = setup()
    const result = await callMailTool(s.deps, 'move', { ids: [7, 8, 404], to: 'trash' })
    expect(result.status).toBe('ok')
    const output = mailOutputs.move.parse((result as { output: unknown }).output)
    expect(output.moved.map((m) => [m.id, m.to])).toEqual([
      [7, 'Deleted Messages'],
      [8, 'Deleted Messages'],
    ])
    expect(output.notFound).toEqual([404])
    expect(s.asked).toEqual([
      {
        kind: 'move',
        to: 'Deleted Messages',
        items: [
          expect.objectContaining({
            messageId: 'engine-1@example.com',
            accountId: ALLOWED,
            mailbox: 'INBOX',
          }),
          expect.objectContaining({
            messageId: 'engine-2@example.com',
            accountId: ALLOWED,
            mailbox: 'Sent Messages',
          }),
        ],
      },
    ])
    expect(s.recorded[0]).toEqual({
      accountId: ALLOWED,
      messageId: 'engine-1@example.com',
      from: 'INBOX',
      to: 'Deleted Messages',
      subject: 'Engine notes',
      sender: 'ada@example.com',
      date: expect.any(String),
    })
  })

  it('archives, and refuses an account with no Trash rather than guess', async () => {
    const s = setup()
    expect((await callMailTool(s.deps, 'move', { ids: [7], to: 'archive' })).status).toBe('ok')
    expect(s.asked[0]).toMatchObject({ to: 'Archive' })
    // A library whose account has neither: nothing is moved.
    const bare = setup({ withTrash: false })
    expect(await callMailTool(bare.deps, 'move', { ids: [7], to: 'trash' })).toEqual({
      status: 'failed',
      stage: 'tool-input',
      errorClass: 'unsupported',
    })
    expect(bare.asked).toEqual([])
    expect(s.asked).toHaveLength(1)
  })

  it('moves only within one account, never into Sent, Drafts or the Outbox', async () => {
    const s = setup()
    // Mailbox 4 is the other account's INBOX; message 7 is in the allowed account.
    expect(await callMailTool(s.deps, 'move', { ids: [7], to: 4 })).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    // Mailbox 2 is Sent Messages.
    expect(await callMailTool(s.deps, 'move', { ids: [7], to: 2 })).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    expect(s.asked).toEqual([])
    expect((await callMailTool(s.deps, 'move', { ids: [7], to: 3 })).status).toBe('ok')
    expect(s.asked[0]).toMatchObject({ to: 'Archive/2025' })
  })

  it('leaves a message already where it should go, and stops at the hour’s allowance', async () => {
    const s = setup({ allowance: 1 })
    const same = await callMailTool(s.deps, 'move', { ids: [7], to: 'inbox' })
    expect((same as { output: { unchanged: number[] } }).output.unchanged).toEqual([7])
    expect(s.asked).toEqual([])
    expect(await callMailTool(s.deps, 'move', { ids: [7, 8], to: 'trash' })).toEqual({
      status: 'failed',
      stage: 'tool-run',
      errorClass: 'rate-limited',
    })
    expect(s.asked).toEqual([])
  })

  it('answers not-found while organising is off, and when Mail refuses says the person must allow it', async () => {
    expect(
      await callMailTool(setup({ enabled: false }).deps, 'move', { ids: [7], to: 'trash' }),
    ).toMatchObject({
      status: 'failed',
      errorClass: 'not-found',
    })
    expect(
      await callMailTool(setup({ outcome: { kind: 'not-allowed' } }).deps, 'mark', { ids: [7], read: true }),
    ).toEqual({
      status: 'needsUser',
      reason: 'other',
    })
  })

  it('asks Mail for a message without a Message-ID by its id, subject, sender and date', async () => {
    const s = setup()
    await callMailTool(s.deps, 'mark', { ids: [13], flagged: false })
    expect(s.asked[0]).toMatchObject({
      kind: 'mark',
      items: [
        {
          messageId: null,
          rowId: 13,
          subject: 'Never downloaded',
          sender: 'nofile@example.com',
          date: expect.any(String),
          accountId: ALLOWED,
          mailbox: 'INBOX',
        },
      ],
    })
  })

  it('marks messages, and needs read or flagged', async () => {
    const s = setup()
    const result = await callMailTool(s.deps, 'mark', { ids: [7, 404], read: true, flagged: true })
    expect(mailOutputs.mark.parse((result as { output: unknown }).output)).toMatchObject({
      marked: 1,
      notFound: [404],
    })
    expect(s.asked[0]).toEqual({
      kind: 'mark',
      items: [
        expect.objectContaining({ messageId: 'engine-1@example.com', accountId: ALLOWED, mailbox: 'INBOX' }),
      ],
      read: true,
      flagged: true,
    })
    expect(await callMailTool(s.deps, 'mark', { ids: [7] })).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    expect(await callMailTool(s.deps, 'move', { ids: [], to: 'trash' })).toMatchObject({
      errorClass: 'invalid',
    })
    expect(
      await callMailTool(s.deps, 'move', { ids: Array.from({ length: 51 }, (_, i) => i), to: 'trash' }),
    ).toMatchObject({
      errorClass: 'invalid',
    })
  })
})
