// GuardedImap on its own, with a backend that records what reached it: what tool code may ask
// for, refused and audited before the protocol host hears of it.

import { parseManifest, SecretValue, ValetError } from '@valet/core'
import { RunMeter } from '@valet/egress'
import { describe, expect, it } from 'vitest'
import { CallState } from '../src/call-state'
import { GuardedImap, type ImapBackend, type ImapCall, NO_IMAP_ACCESS } from '../src/guarded-imap'
import { SecretRedactionSet } from '../src/redaction'
import type { SiteGuards } from '../src/site-protection'

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'icloud-mail',
  name: 'iCloud Mail',
  version: '0.1.0',
  description: 'For GuardedImap unit tests',
  runtime: 'protocol',
  protocols: {
    imap: { endpoint: 'imap.mail.me.com:993', credential: 'mail', folders: ['INBOX', 'Receipts'] },
  },
  credentials: {
    mail: {
      description: 'App-specific password',
      kind: 'password',
      custody: 'kept',
      use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
    },
  },
  limits: { requestsPerRun: 5 },
  tools: [{ name: 'read_it', title: 'Read', description: 'A read', sideEffect: 'read' }],
})

function setup(
  sideEffect: 'read' | 'write' | 'irreversible' = 'read',
  options: { breakerOpen?: boolean; failOp?: ValetError } = {},
) {
  const ops: { op: string; args: readonly unknown[] }[] = []
  const connects: ImapCall[] = []
  let ended = 0
  const backend: ImapBackend = {
    endpoint: 'imap.mail.me.com:993',
    folders: ['INBOX', 'Receipts'],
    connect: async (call) => {
      connects.push(call)
      return {
        operation: async (op, args) => {
          ops.push({ op, args })
          if (options.failOp !== undefined) throw options.failOp
          return { op }
        },
        end: async () => {
          ended++
        },
      }
    },
  }
  const site: SiteGuards = {
    budget: { acquire: async () => {} },
    breaker: {
      isOpen: () => options.breakerOpen === true,
      admit: () => 0,
      recordSuccess: () => {},
      trip: () => {},
    },
  } as unknown as SiteGuards
  const controller = new AbortController()
  const state = new CallState('call-1', controller.signal, () => new SecretRedactionSet())
  const audits: Record<string, unknown>[] = []
  const imap = new GuardedImap({
    adapterId: manifest.id,
    manifest,
    sideEffect,
    site,
    state,
    audit: async (e) => void audits.push(e as unknown as Record<string, unknown>),
    backend,
    run: { meter: new RunMeter(64 * 1024), signal: controller.signal, record: () => {} },
    signIn: async () => ({ username: SecretValue.fromString('u'), secret: SecretValue.fromString('p') }),
  })
  return { imap, ops, connects, audits, state, controller, ended: () => ended }
}

describe('GuardedImap', () => {
  it('connects once, lazily, with the tool’s purpose, and runs each operation', async () => {
    const t = setup('write')
    expect(t.connects).toHaveLength(0)
    await t.imap.search('INBOX', { seen: false })
    await t.imap.setFlags('inbox', [1], { add: ['\\Flagged'] })
    await t.imap.copy('INBOX', [1], 'Receipts')
    expect(t.connects).toHaveLength(1)
    expect(t.connects[0]?.purpose).toBe('write')
    expect(t.ops.map((o) => o.op)).toEqual(['search', 'setFlags', 'copy'])
    expect(t.audits).toEqual([])
  })

  it('refuses a change from a read tool, audits it, and stays refused', async () => {
    const t = setup('read')
    await expect(t.imap.move('INBOX', [1], 'Receipts')).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    expect(t.audits).toEqual([
      expect.objectContaining({
        type: 'request-blocked',
        method: 'IMAP',
        target: 'imaps://imap.mail.me.com:993/move',
        reason: 'command-not-allowed',
        initiator: 'tool',
      }),
    ])
    await expect(t.imap.search('INBOX')).rejects.toBeInstanceOf(ValetError)
    expect(t.connects).toHaveLength(0)
    expect(t.ops).toEqual([])
  })

  it('counts \\Deleted as irreversible, however it is written', async () => {
    const t = setup('write')
    await expect(t.imap.setFlags('INBOX', [1], { remove: ['\\DELETED'] })).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    const u = setup('write')
    await expect(u.imap.append('INBOX', 'X: y', { flags: ['\\deleted'] })).rejects.toMatchObject({
      errorClass: 'command-not-allowed',
    })
    const v = setup('irreversible')
    await v.imap.setFlags('INBOX', [1], { add: ['\\Deleted'] })
    await v.imap.expunge('INBOX', [1])
    expect(v.ops.map((o) => o.op)).toEqual(['setFlags', 'expunge'])
  })

  it('keeps to the manifest’s folders, both ends of a copy included', async () => {
    for (const call of [
      (t: ReturnType<typeof setup>) => t.imap.status('Archive'),
      (t: ReturnType<typeof setup>) => t.imap.copy('INBOX', [1], 'Archive'),
      (t: ReturnType<typeof setup>) => t.imap.copy('Archive', [1], 'INBOX'),
      (t: ReturnType<typeof setup>) => t.imap.message('receipts', 1),
    ]) {
      const t = setup('write')
      await expect(call(t)).rejects.toMatchObject({ errorClass: 'command-not-allowed' })
      expect(t.ops).toEqual([])
    }
  })

  it('refuses malformed calls from the isolation channel', async () => {
    const t = setup('irreversible')
    await expect(t.imap.op('raw', [])).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(t.imap.op('search', 'INBOX' as never)).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(t.imap.op('search', [1, 2, 3, 4, 5])).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(t.imap.op('status', [{ toString: () => 'INBOX' }])).rejects.toMatchObject({
      errorClass: 'invalid',
    })
    await expect(t.imap.op('__proto__', [])).rejects.toMatchObject({ errorClass: 'invalid' })
    expect(t.ops).toEqual([])
  })

  it('stops at the run’s request ceiling', async () => {
    const t = setup('read')
    for (let i = 0; i < 5; i++) await t.imap.status('INBOX')
    await expect(t.imap.status('INBOX')).rejects.toMatchObject({ errorClass: 'request-ceiling' })
    expect(t.ops).toHaveLength(5)
  })

  it('refuses while the site’s breaker is open', async () => {
    const t = setup('read', { breakerOpen: true })
    await expect(t.imap.status('INBOX')).rejects.toBeInstanceOf(ValetError)
    expect(t.connects).toHaveLength(0)
  })

  it('ends the connection when the call is aborted, and runs nothing after', async () => {
    const t = setup('read')
    await t.imap.status('INBOX')
    t.controller.abort()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.ended()).toBe(1)
    await expect(t.imap.status('INBOX')).rejects.toBeInstanceOf(ValetError)
    expect(t.ops).toHaveLength(1)
  })

  it('ends the call when the host refuses what these checks let through', async () => {
    const t = setup('read', { failOp: new ValetError('request-surface', 'command-not-allowed') })
    await expect(t.imap.status('INBOX')).rejects.toMatchObject({ errorClass: 'command-not-allowed' })
    expect(t.state.violation).not.toBeNull()
    await expect(t.imap.status('INBOX')).rejects.toBeInstanceOf(ValetError)
  })

  it('turns anything else the backend throws into unavailable', async () => {
    const t = setup('read', { failOp: new Error('boom') as ValetError })
    await expect(t.imap.status('INBOX')).rejects.toMatchObject({ errorClass: 'unavailable' })
  })

  it('has nothing for an adapter without IMAP', async () => {
    await expect(NO_IMAP_ACCESS.search('INBOX')).rejects.toMatchObject({ errorClass: 'not-granted' })
    await expect(NO_IMAP_ACCESS.deleteFolder('x')).rejects.toMatchObject({ errorClass: 'not-granted' })
  })
})
