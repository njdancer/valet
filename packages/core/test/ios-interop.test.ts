// Shared vectors between core and the iPhone app's Swift port (docs/ios-app.md, Testing). The
// Swift tests read ios/ValetPhoneKit/Tests/ValetCryptoTests/Vectors/core-vectors.json; this suite
// checks that file still agrees with core, so a contract change that breaks the phone fails here
// as well as there.
//
// - VALET_WRITE_IOS_VECTORS=<path> writes a fresh vector file (new keys and signatures).
// - VALET_IOS_SWIFT_OUT=<path> checks decisions the Swift code signed, with verifyDecision, as the
//   Mac will. The iOS CI job sets it after `swift test`.

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type ApprovalRequest,
  canonicalJson,
  type DeviceLookup,
  decisionPayload,
  domainDigest,
  isDisplayText,
  keyId,
  parseRequestText,
  SIGNING_DOMAINS,
  type SignedText,
  serializeRequest,
  signingInput,
  verifyDecision,
  verifyDeviceRecord,
} from '../src'

const VECTORS = fileURLToPath(
  new URL('../../../ios/ValetPhoneKit/Tests/ValetCryptoTests/Vectors/core-vectors.json', import.meta.url),
)

interface Keys {
  readonly privateKey: KeyObject
  readonly spki: string
}

function p256(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}

function signText(keys: Keys, domain: (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS], payload: string): SignedText {
  const signature = sign('sha256', signingInput(domain, payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' })
  return { payload, signature: signature.toString('base64url') }
}

const HASH_A = 'a1'.repeat(32)
const HASH_B = 'b2'.repeat(32)
const created = '2026-11-12T08:40:00.000Z'
const agent = { kind: 'agent', clientId: 'local:claude-code', clientName: 'Claude Code' } as const

function requests(macId: string): ApprovalRequest[] {
  const base = (id: string, expiresAt: string) => ({
    v: 1 as const,
    id: id.padEnd(22, 'x'),
    macId,
    requester: agent,
    agentNote: 'You asked for stock quotes. "Quotes" é́ \u{1F600}',
    createdAt: created,
    expiresAt,
  })
  const day = '2026-11-13T08:40:00.000Z'
  return [
    {
      ...base('7B3F', day),
      kind: 'adapter-install',
      tier: 'approve',
      subject: {
        adapterId: 'yahoo-finance',
        adapterName: 'Yahoo Finance',
        version: '1.0.0',
        adapterHash: HASH_A,
        packageHash: HASH_B,
        previousHash: null,
        source: 'draft',
        inheritsSession: false,
        references: ['https://github.com/example/yahoo-adapter'],
        changes: [{ area: 'egress', change: 'added', items: ['query1.finance.yahoo.com'], risk: 'low' }],
        unsandboxed: false,
      },
    },
    {
      ...base('2A10', day),
      kind: 'secret-grant',
      tier: 'approve',
      subject: {
        adapterId: 'woolworths',
        adapterHash: HASH_A,
        secret: 'account',
        fields: ['username', 'password'],
        provider: 'onepassword-service-account',
        itemTitle: 'Woolworths',
        itemFingerprint: '0123456789abcdef',
        origins: ['https://auth.woolworths.com.au'],
      },
    },
    {
      ...base('9D02', day),
      kind: 'tool-enable',
      tier: 'approve',
      subject: {
        adapterId: 'yahoo-finance',
        adapterHash: HASH_A,
        tool: 'search_symbols',
        scope: 'remote',
        clientId: 'remote:claude-app',
        sideEffect: 'read',
      },
    },
    {
      ...base('4C55', '2026-11-12T08:50:00.000Z'),
      requester: { kind: 'person' },
      agentNote: null,
      kind: 'remote-client',
      tier: 'approve',
      subject: {
        clientId: 'remote:new-client',
        host: 'claude.ai',
        sourceAddress: '203.0.113.7',
        code: 'K7QX-29PD',
        tools: ['yahoo-finance.get_quote'],
      },
    },
    {
      ...base('3B77', day),
      kind: 'setting',
      tier: 'approve',
      subject: {
        scope: 'adapter',
        adapterId: 'woolworths',
        setting: 'store',
        label: 'Woolworths store',
        from: 'Town Hall',
        to: 'Bondi Junction',
      },
    },
    {
      ...base('6E11', '2026-11-12T09:10:00.000Z'),
      kind: 'authoring-session',
      tier: 'approve',
      subject: { adapterId: 'woolworths', draftId: 'draft-4e1c', origins: ['https://www.woolworths.com.au'], minutes: 30 },
    },
    {
      ...base('8F20', '2026-11-12T08:42:00.000Z'),
      kind: 'irreversible-call',
      tier: 'approve-each-use',
      subject: {
        adapterId: 'woolworths',
        adapterHash: HASH_A,
        tool: 'checkout',
        callId: 'call-6b3e',
        preview: ['12 items, $84.20', 'Card ending 4421'],
      },
    },
    { ...base('5R00', '2026-11-12T08:50:00.000Z'), kind: 'resume', tier: 'approve', subject: { from: 'lockdown' } },
    {
      ...base('1P00', '2026-11-12T08:45:00.000Z'),
      kind: 'device-pair',
      tier: 'approve',
      subject: { deviceId: '0'.repeat(32), deviceName: 'iPhone', platform: 'ios', confirmation: '042917' },
    },
  ] as ApprovalRequest[]
}

const DISPLAY_CASES = [
  'Yahoo Finance',
  'Woolworths Bondi Junction',
  'café',
  'café',
  'á́́',
  'two  spaces',
  'four    spaces',
  'line\nbreak',
  'tab\there',
  'zero​width',
  'rtl ‮evil',
  'ㅤ',
  'braille⠀',
  'variation️',
  '́',
  ' ',
  'emoji \u{1F6D2}',
  'enclosing ⃝',
  'line sep',
  'שלום',
]

function writeVectors(path: string): void {
  const mac = { approval: p256() }
  const phone = { approval: p256(), transport: p256(), agreement: p256() }
  const macId = keyId(mac.approval.spki)
  const phoneId = keyId(phone.approval.spki)
  const serialized = requests(macId).map((r) => serializeRequest(r))
  const valid = serialized[0]
  if (valid === undefined) throw new Error('no requests')
  const record = canonicalJson({
    v: 1,
    deviceId: phoneId,
    macId,
    role: 'phone',
    platform: 'ios',
    name: 'iPhone',
    approvalKey: phone.approval.spki,
    transportKey: phone.transport.spki,
    agreementKey: phone.agreement.spki,
    pairedAt: created,
  })
  const hello = { id: phoneId, nonce: 'N'.repeat(43), relay: 'https://relay.valet.test' }
  const decision = {
    v: 1 as const,
    decision: 'approve' as const,
    macId,
    requestId: valid.request.id,
    requestDigest: valid.digest,
    deviceId: phoneId,
    decidedAt: '2026-11-12T08:41:00.000Z',
  }
  const vectors = {
    note: 'Written by packages/core/test/ios-interop.test.ts with VALET_WRITE_IOS_VECTORS. Do not edit by hand.',
    macId,
    macApprovalKey: mac.approval.spki,
    requests: serialized.map((s) => ({ kind: s.request.kind, text: s.text, digest: s.digest })),
    invalidRequests: [
      { why: 'unknown key', text: valid.text.replace('"v":1', '"v":1,"extra":true') },
      { why: 'wrong tier', text: valid.text.replace('"tier":"approve"', '"tier":"approve-each-use"') },
      { why: 'bad display text', text: valid.text.replace('Yahoo Finance', 'Yahoo\\u200bFinance') },
      { why: 'expires before created', text: valid.text.replace('2026-11-13T08:40:00.000Z', '2026-11-12T08:39:00.000Z') },
      { why: 'unsandboxed refinement', text: valid.text.replace('"risk":"low"', '"risk":"critical"').replace('"area":"egress"', '"area":"sandbox-mode"') },
    ],
    deviceRecord: { signed: signText(mac.approval, SIGNING_DOMAINS.deviceRecord, record), deviceId: phoneId },
    hello: { ...hello, payload: canonicalJson({ ...hello, role: 'phone' }) },
    decision: { ...decision, payload: decisionPayload(decision) },
    displayText: DISPLAY_CASES.map((value) => ({ value, valid: isDisplayText(value) })),
  }
  writeFileSync(path, `${JSON.stringify(vectors, null, 2)}\n`)
}

const writeTo = process.env.VALET_WRITE_IOS_VECTORS
if (writeTo !== undefined && writeTo !== '') writeVectors(writeTo)

interface Vectors {
  macId: string
  macApprovalKey: string
  requests: { kind: string; text: string; digest: string }[]
  invalidRequests: { why: string; text: string }[]
  deviceRecord: { signed: SignedText; deviceId: string }
  hello: { id: string; nonce: string; relay: string; payload: string }
  decision: Record<string, unknown> & { payload: string }
  displayText: { value: string; valid: boolean }[]
}

describe('iOS vectors', () => {
  const vectors = JSON.parse(readFileSync(VECTORS, 'utf8')) as Vectors

  it('has one valid request per kind, whose text and digest are what core produces', () => {
    expect(new Set(vectors.requests.map((r) => r.kind)).size).toBe(9)
    for (const r of vectors.requests) {
      const parsed = parseRequestText(r.text)
      expect(parsed?.digest).toBe(r.digest)
      expect(parsed?.digest).toBe(domainDigest(SIGNING_DOMAINS.approvalRequest, r.text))
      expect(canonicalJson(JSON.parse(r.text))).toBe(r.text)
    }
  })

  it('has invalid requests that core refuses', () => {
    for (const r of vectors.invalidRequests) expect(parseRequestText(r.text), r.why).toBeNull()
  })

  it('has a device record the Mac signed', () => {
    const check = verifyDeviceRecord(vectors.deviceRecord.signed, vectors.macApprovalKey)
    expect(check.ok).toBe(true)
  })

  it('has the hello and decision payloads core writes', () => {
    const { payload, ...hello } = vectors.hello
    expect(canonicalJson({ ...hello, role: 'phone' })).toBe(payload)
    const { payload: decisionText, ...decision } = vectors.decision
    expect(decisionPayload(decision as never)).toBe(decisionText)
  })

  it('has display text verdicts core agrees with', () => {
    for (const c of vectors.displayText) expect(isDisplayText(c.value), JSON.stringify(c.value)).toBe(c.valid)
  })
})

interface SwiftOut {
  macId: string
  phoneApprovalKey: string
  phoneDeviceId: string
  requestText: string
  decision: SignedText
}

const swiftOut = process.env.VALET_IOS_SWIFT_OUT
describe.runIf(swiftOut !== undefined && swiftOut !== '')('decisions the Swift code signed', () => {
  it('pass verifyDecision as the Mac will check them', () => {
    expect(existsSync(swiftOut as string)).toBe(true)
    const out = JSON.parse(readFileSync(swiftOut as string, 'utf8')) as SwiftOut
    const request = parseRequestText(out.requestText)
    if (request === null) throw new Error('request text from Swift does not parse')
    const devices: DeviceLookup = {
      device: (id) =>
        id === out.phoneDeviceId
          ? {
              v: 1,
              deviceId: out.phoneDeviceId,
              macId: out.macId,
              role: 'phone',
              platform: 'ios',
              name: 'iPhone',
              approvalKey: out.phoneApprovalKey,
              transportKey: out.phoneApprovalKey,
              agreementKey: out.phoneApprovalKey,
              pairedAt: created,
            }
          : null,
      revokedAt: () => null,
    }
    const check = verifyDecision(out.decision, request, {
      macId: out.macId,
      devices,
      mode: 'live',
      isPending: (id) => id === request.request.id,
      now: new Date(Date.parse(request.request.createdAt) + 1000),
    })
    expect(check).toMatchObject({ ok: true, role: 'phone' })
    // A tampered payload or another request fails.
    const tampered = { ...out.decision, payload: out.decision.payload.replace(out.macId, '0'.repeat(32)) }
    expect(verifyDecision(tampered, request, { macId: out.macId, devices, mode: 'live', isPending: () => true }).ok).toBe(false)
  })
})
