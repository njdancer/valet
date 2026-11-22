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
