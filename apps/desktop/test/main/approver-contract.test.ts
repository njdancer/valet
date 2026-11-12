// @vitest-environment node
// The real valet-approver helper (swift-bridge/Sources/valet-approver), built in debug, against a
// throwaway keychain and software keys: CI runners have no Secure Enclave. CI sets
// VALET_SWIFT_APPROVER to the binary's path; skipped everywhere else.
//
// It checks the helper against the TypeScript side it stands in for: the same prompt wording
// (prompts.ts), signatures core's verifyDecision accepts, and a broker approving through it.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApprovalRequest,
  type AuditRecord,
  decisionPayload,
  keyId,
  SIGNING_DOMAINS,
  serializeRequest,
  verifyP256,
} from '@valet/core'
import { helperEnv, nodeTimers, type Spawner } from '@valet/credentials'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AnchoredFile,
  ApprovalBroker,
  DeviceStore,
  HelperSigner,
  MemoryAnchor,
  promptReason,
  TrustedLedger,
} from '../../src/main/core/approvals'

const HELPER = process.env['VALET_SWIFT_APPROVER']

describe.skipIf(HELPER === undefined || HELPER === '')('valet-approver with software keys', () => {
  let dir: string
  let keychainPath: string
  let present = '1'
  let reasons: string[] = []
  const spawner: Spawner = (command, args, options) => {
    const child = spawn(command, [...args], {
      stdio: [options?.input === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...helperEnv(),
        VALET_KEYCHAIN_PATH: keychainPath,
        VALET_APPROVER_SOFTWARE: '1',
        VALET_APPROVER_PRESENT: present,
      },
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const match = /^valet-approver: reason: (.*)$/.exec(line)
        if (match?.[1] !== undefined) reasons.push(match[1])
      }
    })
    return child
  }
  const signer = () => new HelperSigner({ helperPath: HELPER as string, spawner, timers: nodeTimers })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'valet-approver-'))
    keychainPath = join(dir, 'contract.keychain-db')
    for (const args of [
      ['create-keychain', '-p', 'contract', keychainPath],
      ['unlock-keychain', '-p', 'contract', keychainPath],
      ['set-keychain-settings', keychainPath],
    ]) {
      const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`security ${args[0]} failed: ${result.stderr}`)
    }
  })

  afterAll(() => {
    spawnSync('/usr/bin/security', ['delete-keychain', keychainPath])
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates keys once and reads the same ones back', async () => {
    const first = await signer().keys()
    const again = await signer().keys()
    expect(again).toEqual(first)
    expect(new Set([first.approvalKey, first.transportKey, first.agreementKey]).size).toBe(3)
    const create = spawnSync(HELPER as string, ['create'], {
      env: { ...helperEnv(), VALET_KEYCHAIN_PATH: keychainPath, VALET_APPROVER_SOFTWARE: '1' },
    })
    expect(create.status).toBe(73)
  })

  function request(macId: string, kind: ApprovalRequest['kind'], subject: unknown) {
    return serializeRequest({
      v: 1,
      id: 'r'.repeat(22),
      macId,
      kind,
      tier: kind === 'irreversible-call' ? 'approve-each-use' : 'approve',
      requester: { kind: 'person' },
      agentNote: null,
      subject,
      createdAt: '2026-11-12T03:00:00.000Z',
      expiresAt: '2026-11-12T03:10:00.000Z',
    } as ApprovalRequest)
  }

  const subjects: [ApprovalRequest['kind'], unknown][] = [
    [
      'adapter-install',
      {
        adapterId: 'yahoo-finance',
        adapterName: 'Yahoo Finance',
        version: '1.0.0',
        adapterHash: 'a'.repeat(64),
        packageHash: 'b'.repeat(64),
        previousHash: null,
        source: 'draft',
        inheritsSession: false,
        references: [],
        changes: [{ area: 'navigation', change: 'added', items: ['https://finance.yahoo.com'], risk: 'low' }],
        unsandboxed: false,
      },
    ],
    [
      'tool-enable',
      {
        adapterId: 'yahoo-finance',
        adapterHash: 'a'.repeat(64),
        tool: 'get_quote',
        scope: 'remote',
        clientId: null,
        sideEffect: 'read',
      },
    ],
    [
      'secret-grant',
      {
        adapterId: 'woolworths',
        adapterHash: 'a'.repeat(64),
        secret: 'login',
        fields: ['username', 'password'],
        provider: 'keychain-copy',
        itemTitle: 'Woolworths',
        itemFingerprint: '0123456789abcdef',
        origins: ['https://auth.woolworths.com.au', 'https://www.woolworths.com.au:8443'],
      },
    ],
    ['resume', { from: 'lockdown' }],
    [
      'private-network',
      { adapterId: 'home-hub', draftId: 'd1', address: '192.168.1.20', port: 8080, minutes: 30 },
    ],
    [
      'private-network',
      { adapterId: 'home-hub', draftId: 'd1', address: '192.168.1.20', port: null, minutes: 30 },
    ],
  ]

  it('signs what core verifies, with the same prompt wording as the app', async () => {
    const keys = await signer().keys()
    const macId = keyId(keys.approvalKey)
    for (const [kind, subject] of subjects) {
      reasons = []
      const serialized = request(macId, kind, subject)
      const payload = decisionPayload({
        v: 1,
        decision: 'approve',
        macId,
        requestId: serialized.request.id,
        requestDigest: serialized.digest,
        deviceId: macId,
        decidedAt: '2026-11-12T03:01:00.000Z',
      })
      const signature = await signer().signDecision(serialized, payload)
      expect(signature).not.toBeNull()
      expect(
        verifyP256(keys.approvalKey, SIGNING_DOMAINS.approvalDecision, payload, signature as string),
      ).toBe(true)
      expect(reasons).toEqual([promptReason(serialized)])
    }
  })

  it('refuses to sign anything but an approval of the request it was shown', async () => {
    const keys = await signer().keys()
    const macId = keyId(keys.approvalKey)
    const shown = request(macId, 'resume', { from: 'lockdown' })
    const other = request(macId, 'resume', { from: 'paused' })
    const decision = {
      v: 1,
      decision: 'approve',
      macId,
      requestId: shown.request.id,
      requestDigest: other.digest,
      deviceId: macId,
      decidedAt: '2026-11-12T03:01:00.000Z',
    } as const
    expect(await signer().signDecision(shown, decisionPayload(decision))).toBeNull()
    expect(
      await signer().signDecision(
        shown,
        decisionPayload({ ...decision, requestDigest: shown.digest, deviceId: 'f'.repeat(32) }),
      ),
    ).toBeNull()
    expect(await signer().signDecision(shown, '{"anything":"else"}')).toBeNull()
    present = '0'
    expect(
      await signer().signDecision(shown, decisionPayload({ ...decision, requestDigest: shown.digest })),
    ).toBeNull()
    present = '1'
  })

  it('approves through a broker end to end', async () => {
    const helperSigner = signer()
    const files = new Map<string, string>()
    const ledger = await TrustedLedger.open(
      new AnchoredFile('/trusted.json', 'trusted', new MemoryAnchor(), {
        read: async (p) => files.get(p) ?? null,
        write: async (p, t) => void files.set(p, t),
      }),
    )
    const broker = await ApprovalBroker.open({
      ledger,
      devices: new DeviceStore(ledger, await helperSigner.keys()),
      signer: helperSigner,
      audit: { append: async (event) => ({ event }) as unknown as AuditRecord },
      handlers: {},
    })
    await broker.lockdown()
    const resume = await broker.request('resume', { from: 'lockdown' }, { kind: 'person' })
    if (!resume.ok) throw new Error('refused')
    expect(await broker.approveOnMac(resume.requestId)).toEqual({ ok: true })
    expect(broker.isLockedDown()).toBe(false)
  })
})
