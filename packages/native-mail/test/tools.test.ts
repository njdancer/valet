import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DraftRequest } from '../src/drafts'
import { DirectMailFiles } from '../src/files'
import { MailStore } from '../src/store'
import {
  callMailTool,
  type DraftApproval,
  MAIL_DATA_NOTE,
  type MailToolDeps,
  mailOutputs,
  mailTools,
} from '../src/tools'
import { ALLOWED, buildLibrary } from './fixture-library'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'valet-mail-tools-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function deps(overrides: Partial<MailToolDeps> = {}): { deps: MailToolDeps; saved: DraftRequest[] } {
  const store = new MailStore(new DirectMailFiles(buildLibrary(mkdtempSync(join(root, 'lib-')))), {
    allowedAccounts: () => new Set([ALLOWED]),
  })
  const saved: DraftRequest[] = []
  return {
    saved,
    deps: {
      store,
      drafts: {
        save: async (draft) => {
          saved.push(draft)
          return { kind: 'saved' }
        },
      },
      draftsEnabled: () => true,
      approveDraft: null,
      ...overrides,
    },
  }
}

describe('mail tools', () => {
  it('lists the draft tool only when drafts are on', () => {
    expect(mailTools({ drafts: false }).map((t) => t.declaration.name)).toEqual([
      'accounts',
      'search',
      'read',
      'thread',
    ])
    const all = mailTools({ drafts: true })
    expect(all.map((t) => t.declaration.name)).toContain('create_draft')
    for (const t of all) expect(t.declaration.description.length).toBeLessThanOrEqual(1000)
    expect(all.find((t) => t.declaration.name === 'create_draft')?.declaration.sideEffect).toBe('write')
  })

  it('answers in the shapes it declares, marking mail as data', async () => {
    const { deps: d } = deps()
    const search = await callMailTool(d, 'search', { from: 'ada' })
    expect(search.status).toBe('ok')
    if (search.status !== 'ok') return
    expect(mailOutputs.search.parse(search.output).note).toBe(MAIL_DATA_NOTE)
    const read = await callMailTool(d, 'read', { id: 7 })
    expect(read.status === 'ok' && mailOutputs.read.parse(read.output).message.body).toContain(
      'analytical engine',
    )
    const thread = await callMailTool(d, 'thread', { id: 7 })
    expect(thread.status === 'ok' && mailOutputs.thread.parse(thread.output).messages).toHaveLength(2)
    const accounts = await callMailTool(d, 'accounts', {})
    expect(accounts.status === 'ok' && mailOutputs.accounts.parse(accounts.output).accounts).toHaveLength(1)
  })

  it('refuses unknown arguments and messages it may not read', async () => {
    const { deps: d } = deps()
    expect(await callMailTool(d, 'search', { sql: 'x' })).toEqual({
      status: 'failed',
      stage: 'tool-input',
      errorClass: 'invalid',
    })
    expect(await callMailTool(d, 'read', { id: 11 })).toEqual({
      status: 'failed',
      stage: 'tool-input',
      errorClass: 'not-found',
    })
    expect(await callMailTool(d, 'send', {})).toEqual({
      status: 'failed',
      stage: 'tool-input',
      errorClass: 'not-found',
    })
  })

  it('saves a new draft, never sending', async () => {
    const { deps: d, saved } = deps()
    const result = await callMailTool(d, 'create_draft', {
      to: ['ada@example.com'],
      subject: 'Hi',
      body: 'Hello',
    })
    expect(result).toMatchObject({ status: 'ok', output: { saved: true } })
    expect(saved).toEqual([
      { from: null, to: ['ada@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hello', replyTo: null },
    ])
  })

  it('saves a reply in its thread', async () => {
    const { deps: d, saved } = deps()
    await callMailTool(d, 'create_draft', { replyToId: 7, body: 'Thanks' })
    expect(saved[0]).toMatchObject({
      subject: 'Re: Engine notes',
      replyTo: { messageId: 'engine-1@example.com', accountId: ALLOWED, mailbox: 'INBOX', all: false },
    })
    expect(await callMailTool(d, 'create_draft', { replyToId: 11, body: 'x' })).toMatchObject({
      errorClass: 'not-found',
    })
  })

  it('refuses a draft from an address that is not the account’s', async () => {
    const { deps: d, saved } = deps()
    const result = await callMailTool(d, 'create_draft', {
      to: ['a@b.c'],
      body: 'x',
      from: 'boss@elsewhere.example',
    })
    expect(result).toMatchObject({ status: 'failed', errorClass: 'invalid' })
    expect(saved).toEqual([])
    expect(await callMailTool(d, 'create_draft', { body: 'no recipients' })).toMatchObject({
      errorClass: 'invalid',
    })
  })

  it('asks the person first when they want to approve each draft', async () => {
    const asked: DraftApproval[] = []
    let answer: 'approved' | 'declined' | 'timed-out' = 'declined'
    const { deps: d, saved } = deps({
      approveDraft: () => async (draft) => {
        asked.push(draft)
        return answer
      },
    })
    expect(await callMailTool(d, 'create_draft', { to: ['a@b.c'], subject: 's', body: 'x' })).toEqual({
      status: 'declined',
    })
    answer = 'timed-out'
    expect(await callMailTool(d, 'create_draft', { to: ['a@b.c'], subject: 's', body: 'x' })).toEqual({
      status: 'declined',
      timedOut: true,
    })
    expect(saved).toEqual([])
    answer = 'approved'
    expect(await callMailTool(d, 'create_draft', { to: ['a@b.c'], subject: 's', body: 'x' })).toMatchObject({
      status: 'ok',
    })
    expect(asked[0]).toEqual({ from: null, to: ['a@b.c'], cc: [], bcc: [], subject: 's', reply: false })
  })

  it('needs the person when Mail scripting isn’t allowed, and when drafts are off', async () => {
    const { deps: d } = deps({ drafts: { save: async () => ({ kind: 'not-allowed' }) } })
    expect(await callMailTool(d, 'create_draft', { to: ['a@b.c'], body: 'x' })).toEqual({
      status: 'needsUser',
      reason: 'other',
    })
    const { deps: off } = deps({ draftsEnabled: () => false })
    expect(await callMailTool(off, 'create_draft', { to: ['a@b.c'], body: 'x' })).toMatchObject({
      errorClass: 'not-found',
    })
  })

  it('needs the person when the reader is missing', async () => {
    const store = new MailStore(
      new DirectMailFiles({ mailDir: join(root, 'x'), accountsDb: join(root, 'y') }),
      {
        allowedAccounts: () => new Set([ALLOWED]),
      },
    )
    const { deps: d } = deps({ store })
    expect(await callMailTool(d, 'search', {})).toEqual({ status: 'needsUser', reason: 'other' })
  })
})
