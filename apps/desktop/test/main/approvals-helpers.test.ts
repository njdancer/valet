// @vitest-environment node
// The packaged app's signer (the valet-approver helper) and Keychain anchor, against fakes: what
// each exit code means, and that nothing but a well-formed key or signature is ever taken back.

import { EventEmitter } from 'node:events'
import { type AnchorState, CredentialError } from '@valet/core'
import { type ChildLike, MemoryKeychain, type Spawner } from '@valet/credentials'
import { describe, expect, it } from 'vitest'
import {
  AnchoredFile,
  ApproverError,
  type FileOps,
  HelperSigner,
  KeychainAnchor,
  SoftwareSigner,
  TrustedLedger,
} from '../../src/main/core/approvals'

const HELPER = '/Applications/Valet.app/Contents/MacOS/valet-approver'
const KEY = 'A'.repeat(122)
const SIGNATURE = 'B'.repeat(86)

function helper(answers: Record<string, { code: number; stdout?: string }>) {
  const ran: { args: readonly string[]; input: string | null }[] = []
  const spawn: Spawner = (_command, args, options) => {
    const entry = { args, input: null as string | null }
    ran.push(entry)
    const child = new EventEmitter() as EventEmitter & ChildLike
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const stdin =
      options?.input === true
        ? {
            end: (chunk: Buffer, done?: () => void) => {
              entry.input = chunk.toString('utf8')
              done?.()
            },
            on: () => undefined,
          }
        : null
    Object.assign(child, { stdout, stderr, stdin, kill: () => true })
    const answer = answers[args[0] ?? '']
    queueMicrotask(() => {
      if (answer?.stdout !== undefined) stdout.emit('data', Buffer.from(answer.stdout))
      child.emit('close', answer?.code ?? 1)
    })
    return child
  }
  return { signer: new HelperSigner({ helperPath: HELPER, spawner: spawn }), ran }
}

const keys = JSON.stringify({ approvalKey: KEY, transportKey: KEY, agreementKey: KEY })

describe('the helper signer', () => {
  it('reads the keys, and creates them only when there are none at all', async () => {
    const existing = helper({ keys: { code: 0, stdout: keys } })
    expect(await existing.signer.keys()).toEqual({ approvalKey: KEY, transportKey: KEY, agreementKey: KEY })
    expect(existing.ran.map((r) => r.args[0])).toEqual(['keys'])
    // Cached: the identity can't change under a running app.
    await existing.signer.keys()
    expect(existing.ran).toHaveLength(1)

    const fresh = helper({ keys: { code: 44 }, create: { code: 0, stdout: keys } })
    await fresh.signer.keys()
    expect(fresh.ran.map((r) => r.args[0])).toEqual(['keys', 'create'])
  })

  it('never makes new keys because the old ones could not be read', async () => {
    const broken = helper({ keys: { code: 1 }, create: { code: 0, stdout: keys } })
    await expect(broken.signer.keys()).rejects.toEqual(new ApproverError('failed'))
    expect(broken.ran.map((r) => r.args[0])).toEqual(['keys'])
    await expect(helper({ keys: { code: 44 }, create: { code: 69 } }).signer.keys()).rejects.toEqual(
      new ApproverError('unavailable'),
    )
    await expect(helper({ keys: { code: 77 } }).signer.keys()).rejects.toEqual(new ApproverError('refused'))
    await expect(
      helper({ keys: { code: 0, stdout: '{"approvalKey":"x y"}' } }).signer.keys(),
    ).rejects.toThrow()
  })

  it('hands the helper the request text and payload, and takes back only a signature', async () => {
    const ok = helper({ 'sign-decision': { code: 0, stdout: `${SIGNATURE}\n` } })
    const request = { text: '{"kind":"resume"}', digest: '0'.repeat(64), request: {} } as never
    expect(await ok.signer.signDecision(request, '{"p":1}')).toBe(SIGNATURE)
    expect(JSON.parse(ok.ran[0]?.input ?? '')).toEqual({
      requestText: '{"kind":"resume"}',
      payload: '{"p":1}',
    })
    expect(await helper({ 'sign-decision': { code: 50 } }).signer.signDecision(request, '{}')).toBeNull()
    expect(await helper({ 'sign-decision': { code: 64 } }).signer.signDecision(request, '{}')).toBeNull()
    expect(
      await helper({ 'sign-decision': { code: 0, stdout: 'not a signature' } }).signer.signDecision(
        request,
        '{}',
      ),
    ).toBeNull()
  })
})

describe('the Keychain anchor', () => {
  const state: AnchorState = { generation: 3, sha256: 'c'.repeat(64), next: null }

  it('round-trips a state, and reads a missing item as none', async () => {
    const anchor = new KeychainAnchor(new MemoryKeychain())
    expect(await anchor.read('trusted')).toBeNull()
    await anchor.write('trusted', state)
    expect(await anchor.read('trusted')).toEqual(state)
  })

  it('throws on any other failure, and the ledger then opens locked down', async () => {
    const keychain = new MemoryKeychain()
    keychain.read = async () => {
      throw new CredentialError('locked')
    }
    const anchor = new KeychainAnchor(keychain)
    await expect(anchor.read('trusted')).rejects.toThrow()
    const files: FileOps = { read: async () => null, write: async () => undefined }
    const ledger = await TrustedLedger.open(new AnchoredFile('/x', 'trusted', anchor, files))
    expect(ledger.tampered).toBe('unreadable')
    expect(ledger.data.safety.lockdown).toBe(true)
  })
})

describe('the software signer', () => {
  it('asks the stand-in finger every time', async () => {
    let answers = 0
    const signer = new SoftwareSigner(() => {
      answers++
      return answers === 1
    })
    const request = { text: '{}', digest: 'ab12'.repeat(16), request: { kind: 'resume' } } as never
    expect(await signer.signDecision(request, '{"a":1}')).not.toBeNull()
    expect(await signer.signDecision(request, '{"a":1}')).toBeNull()
    expect(signer.prompts).toEqual(['resume Valet (request AB12)', 'resume Valet (request AB12)'])
  })
})
