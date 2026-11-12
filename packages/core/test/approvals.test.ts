import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_ACTION_TIERS,
  APPROVAL_KINDS,
  type ApprovalDecision,
  type ApprovalRequest,
  adminTier,
  approvableOn,
  approvalRequestSchema,
  canRevokeDevice,
  type DeviceLookup,
  type DeviceRecord,
  decisionPayload,
  deviceRevocationSchema,
  domainDigest,
  isDisplayText,
  KIND_TIER,
  keyId,
  NEVER_OVER_MCP,
  type PermissionChange,
  parsePhoneToMac,
  parseRequestText,
  SIGNING_DOMAINS,
  type SignedText,
  serializeRequest,
  signingInput,
  verifyDecision,
  verifyDeviceRecord,
  verifyEvidence,
  verifyP256,
} from '../src'

interface Keys {
  readonly privateKey: KeyObject
  readonly spki: string
}

function p256(): Keys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}

function signText(
  keys: Keys,
  domain: (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS],
  payload: string,
): SignedText {
  const signature = sign('sha256', signingInput(domain, payload), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  })
  return { payload, signature: signature.toString('base64url') }
}

const mac = { approval: p256(), transport: p256(), agreement: p256() }
const phone = { approval: p256(), transport: p256(), agreement: p256() }
const macId = keyId(mac.approval.spki)
const phoneId = keyId(phone.approval.spki)

function record(role: 'mac' | 'phone', keys: typeof mac): DeviceRecord {
  return {
    v: 1,
    deviceId: keyId(keys.approval.spki),
    macId,
    role,
    platform: role === 'mac' ? 'macos' : 'ios',
    name: role === 'mac' ? 'Nick’s MacBook' : 'Nick’s iPhone',
    approvalKey: keys.approval.spki,
    transportKey: keys.transport.spki,
    agreementKey: keys.agreement.spki,
    pairedAt: '2026-11-12T00:00:00.000Z',
  }
}

function lookup(revoked: Record<string, string> = {}): DeviceLookup {
  const records = new Map([
    [macId, record('mac', mac)],
    [phoneId, record('phone', phone)],
  ])
  return { device: (id) => records.get(id) ?? null, revokedAt: (id) => revoked[id] ?? null }
}

const createdAt = '2026-11-12T01:00:00.000Z'
const expiresAt = '2026-11-12T01:10:00.000Z'
const now = new Date('2026-11-12T01:05:00.000Z')

function grantRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    v: 1,
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    macId,
    kind: 'secret-grant',
    tier: 'approve',
    requester: { kind: 'agent', clientId: 'remote:abc', clientName: 'Claude' },
    agentNote: 'Needed to log in to Woolworths',
    createdAt,
    expiresAt,
    subject: {
      adapterId: 'woolworths',
      adapterHash: 'a'.repeat(64),
      secret: 'account',
      fields: ['username', 'password'],
      provider: 'onepassword-service-account',
      itemTitle: 'Woolworths',
      itemFingerprint: '0123456789abcdef',
      origins: ['https://auth.woolworths.com.au'],
    },
    ...overrides,
  } as ApprovalRequest
}

function decide(
  keys: Keys,
  deviceId: string,
  request: { request: ApprovalRequest; digest: string },
  changes: Partial<ApprovalDecision> = {},
) {
  const decision: ApprovalDecision = {
    v: 1,
    decision: 'approve',
    macId,
    requestId: request.request.id,
    requestDigest: request.digest,
    deviceId,
    decidedAt: '2026-11-12T01:04:00.000Z',
    ...changes,
  }
  return signText(keys, SIGNING_DOMAINS.approvalDecision, decisionPayload(decision))
}

const live = (pending = true) => ({
  macId,
  devices: lookup(),
  mode: 'live' as const,
  isPending: () => pending,
  now,
})

describe('signatures', () => {
  it('verifies a P-256 signature only under its own domain', () => {
    const signed = signText(phone.approval, SIGNING_DOMAINS.approvalDecision, '{"a":1}')
    expect(
      verifyP256(phone.approval.spki, SIGNING_DOMAINS.approvalDecision, signed.payload, signed.signature),
    ).toBe(true)
    expect(
      verifyP256(phone.approval.spki, SIGNING_DOMAINS.deviceRecord, signed.payload, signed.signature),
    ).toBe(false)
    expect(
      verifyP256(mac.approval.spki, SIGNING_DOMAINS.approvalDecision, signed.payload, signed.signature),
    ).toBe(false)
    expect(
      verifyP256(phone.approval.spki, SIGNING_DOMAINS.approvalDecision, '{"a":2}', signed.signature),
    ).toBe(false)
  })

  it('refuses other curves and key types', () => {
    const ed = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url')
    const k1 = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
      .publicKey.export({ type: 'spki', format: 'der' })
      .toString('base64url')
    expect(verifyP256(ed, SIGNING_DOMAINS.approvalDecision, 'x', 'A'.repeat(86))).toBe(false)
    expect(verifyP256(k1, SIGNING_DOMAINS.approvalDecision, 'x', 'A'.repeat(86))).toBe(false)
    expect(verifyP256('not a key', SIGNING_DOMAINS.approvalDecision, 'x', 'A'.repeat(86))).toBe(false)
  })
})

describe('device records', () => {
  it('accepts a record the Mac signed, and refuses one anyone else did', () => {
    const payload = JSON.stringify(record('phone', phone))
    expect(
      verifyDeviceRecord(signText(mac.approval, SIGNING_DOMAINS.deviceRecord, payload), mac.approval.spki),
    ).toMatchObject({
      ok: true,
    })
    expect(
      verifyDeviceRecord(signText(phone.approval, SIGNING_DOMAINS.deviceRecord, payload), mac.approval.spki),
    ).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('refuses a record whose id is not its approval key, or a phone claiming to be the Mac', () => {
    const wrongId = JSON.stringify({ ...record('phone', phone), deviceId: '0'.repeat(32) })
    expect(
      verifyDeviceRecord(signText(mac.approval, SIGNING_DOMAINS.deviceRecord, wrongId), mac.approval.spki).ok,
    ).toBe(false)
    const asMac = JSON.stringify({ ...record('phone', phone), role: 'mac' })
    expect(
      verifyDeviceRecord(signText(mac.approval, SIGNING_DOMAINS.deviceRecord, asMac), mac.approval.spki).ok,
    ).toBe(false)
  })
})

describe('approval requests', () => {
  it('round-trips through its text with the same digest', () => {
    const serialized = serializeRequest(grantRequest())
    const parsed = parseRequestText(serialized.text)
    expect(parsed?.digest).toBe(serialized.digest)
    expect(serialized.digest).toBe(domainDigest(SIGNING_DOMAINS.approvalRequest, serialized.text))
  })

  it('refuses a tier that does not match the kind', () => {
    expect(() =>
      serializeRequest(grantRequest({ tier: 'approve-each-use' } as Partial<ApprovalRequest>)),
    ).toThrow()
  })

  it('refuses control and direction characters in anything shown', () => {
    expect(() => serializeRequest(grantRequest({ agentNote: 'fine‮evil' }))).toThrow()
    expect(() => serializeRequest(grantRequest({ agentNote: 'line\nbreak' }))).toThrow()
  })

  it('refuses unknown fields, so a device never renders something the Mac did not check', () => {
    const text = JSON.stringify({
      ...serializeRequest(grantRequest()).request,
      headline: 'Approve to continue',
    })
    expect(parseRequestText(text)).toBeNull()
  })

  it('gives every kind a tier, and only the Mac pairs devices or runs code unsandboxed', () => {
    for (const kind of APPROVAL_KINDS) expect(KIND_TIER[kind]).toMatch(/^approve/)
    expect(KIND_TIER['irreversible-call']).toBe('approve-each-use')
    expect(approvableOn('device-pair', {} as never)).toEqual(['mac'])
    expect(approvableOn('resume', { from: 'lockdown' } as never)).toEqual(['mac'])
    expect(approvableOn('adapter-install', { unsandboxed: true, changes: [] } as never)).toEqual(['mac'])
    expect(approvableOn('adapter-install', { unsandboxed: false, changes: [] } as never)).toEqual([
      'mac',
      'phone',
    ])
    expect(approvalRequestSchema).toBeDefined()
  })
})

describe('signed decisions', () => {
  const request = serializeRequest(grantRequest())

  it('accepts the phone’s signature over this pending request', () => {
    expect(verifyDecision(decide(phone.approval, phoneId, request), request, live())).toMatchObject({
      ok: true,
      role: 'phone',
    })
  })

  it('refuses a replay once the request is no longer pending', () => {
    expect(verifyDecision(decide(phone.approval, phoneId, request), request, live(false))).toEqual({
      ok: false,
      reason: 'not-pending',
    })
  })

  it('refuses an approval of a different request, or of different text for the same id', () => {
    const other = serializeRequest(grantRequest({ id: 'BBBBBBBBBBBBBBBBBBBBBB' }))
    expect(verifyDecision(decide(phone.approval, phoneId, other), request, live())).toEqual({
      ok: false,
      reason: 'wrong-request',
    })
    const altered = serializeRequest(grantRequest({ agentNote: 'something else' }))
    expect(verifyDecision(decide(phone.approval, phoneId, altered), request, live())).toEqual({
      ok: false,
      reason: 'wrong-request',
    })
  })

  it('refuses a signature by the transport key, which never needs Face ID', () => {
    expect(verifyDecision(decide(phone.transport, phoneId, request), request, live())).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('refuses an unknown device, a revoked one, an expired request and another Mac', () => {
    const stranger = p256()
    expect(verifyDecision(decide(stranger, keyId(stranger.spki), request), request, live())).toEqual({
      ok: false,
      reason: 'unknown-device',
    })
    const revoked = { ...live(), devices: lookup({ [phoneId]: '2026-11-12T01:03:00.000Z' }) }
    expect(verifyDecision(decide(phone.approval, phoneId, request), request, revoked)).toEqual({
      ok: false,
      reason: 'device-revoked',
    })
    const late = { ...live(), now: new Date(expiresAt) }
    expect(verifyDecision(decide(phone.approval, phoneId, request), request, late)).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(
      verifyDecision(decide(phone.approval, phoneId, request, { macId: 'f'.repeat(32) }), request, live()),
    ).toEqual({
      ok: false,
      reason: 'wrong-mac',
    })
  })

  it('refuses a phone approving what only the Mac may', () => {
    const pairing = serializeRequest({
      v: 1,
      id: 'CCCCCCCCCCCCCCCCCCCCCC',
      macId,
      kind: 'device-pair',
      tier: 'approve',
      requester: { kind: 'person' },
      agentNote: null,
      createdAt,
      expiresAt,
      subject: { deviceId: '1'.repeat(32), deviceName: 'New phone', platform: 'ios', confirmation: '123456' },
    })
    expect(verifyDecision(decide(phone.approval, phoneId, pairing), pairing, live())).toEqual({
      ok: false,
      reason: 'not-allowed-on-device',
    })
    expect(verifyDecision(decide(mac.approval, macId, pairing), pairing, live())).toMatchObject({
      ok: true,
      role: 'mac',
    })
  })

  it('checks stored evidence by the Mac’s receipt, never the signer’s own clock', () => {
    const stored = (receivedAt: string, revoked: Record<string, string> = {}) => ({
      macId,
      devices: lookup(revoked),
      mode: 'stored' as const,
      receivedAt,
      now: new Date('2027-01-01T00:00:00.000Z'),
    })
    const signed = decide(phone.approval, phoneId, request)
    expect(verifyDecision(signed, request, stored('2026-11-12T01:04:00.000Z')).ok).toBe(true)
    expect(verifyDecision(signed, request, stored(expiresAt))).toEqual({ ok: false, reason: 'expired' })
    expect(verifyDecision(signed, request, { ...stored('x'), receivedAt: undefined })).toEqual({
      ok: false,
      reason: 'malformed',
    })
    // Revoked after the Mac received it: still valid. Revoked before: refused, whatever decidedAt says.
    expect(
      verifyDecision(
        signed,
        request,
        stored('2026-11-12T01:04:00.000Z', { [phoneId]: '2026-11-13T00:00:00.000Z' }),
      ).ok,
    ).toBe(true)
    const backdated = decide(phone.approval, phoneId, request, { decidedAt: '2026-11-12T01:00:30.000Z' })
    expect(
      verifyDecision(
        backdated,
        request,
        stored('2026-11-12T01:06:00.000Z', { [phoneId]: '2026-11-12T01:05:00.000Z' }),
      ),
    ).toEqual({ ok: false, reason: 'device-revoked' })
  })

  it('accepts a live approval from a device whose clock is wrong, since stored checks use the receipt', () => {
    const skewed = decide(phone.approval, phoneId, request, { decidedAt: '2026-11-12T00:50:00.000Z' })
    expect(verifyDecision(skewed, request, live()).ok).toBe(true)
  })

  it('makes any critical install line Mac only, and refuses an install that hides being unsandboxed', () => {
    const install = (changes: PermissionChange[], unsandboxed: boolean) => ({
      adapterId: 'example',
      adapterName: 'Example',
      version: '1.0.0',
      adapterHash: 'a'.repeat(64),
      packageHash: 'b'.repeat(64),
      previousHash: null,
      source: 'draft' as const,
      inheritsSession: false,
      references: [],
      changes,
      unsandboxed,
    })
    const command: PermissionChange = {
      area: 'sandbox-exception',
      change: 'added',
      items: ['/opt/tool/run'],
      risk: 'critical',
    }
    expect(approvableOn('adapter-install', install([command], false))).toEqual(['mac'])
    const mode: PermissionChange = {
      area: 'sandbox-mode',
      change: 'widened',
      items: ['Runs unsandboxed'],
      risk: 'critical',
    }
    const base = { ...grantRequest(), kind: 'adapter-install', tier: 'approve' }
    expect(() => serializeRequest({ ...base, subject: install([mode], false) } as ApprovalRequest)).toThrow()
    // An update to an adapter that was already unsandboxed has no sandbox-mode line, and stays Mac only.
    const already = serializeRequest({ ...base, subject: install([], true) } as ApprovalRequest)
    expect(approvableOn('adapter-install', already.request.subject)).toEqual(['mac'])
    expect(
      serializeRequest({ ...base, subject: install([mode], true) } as ApprovalRequest).request.kind,
    ).toBe('adapter-install')
  })

  it('refuses ids with direction or control characters', () => {
    expect(() =>
      serializeRequest(
        grantRequest({
          requester: { kind: 'agent', clientId: 'remote:\u202Eevil\u0000\n', clientName: 'x' },
        }),
      ),
    ).toThrow()
  })

  it('refuses malformed payloads without throwing', () => {
    expect(verifyDecision({ payload: 'nope', signature: 'A'.repeat(86) }, request, live()).ok).toBe(false)
    expect(verifyDecision({ payload: '{}', signature: 'short' }, request, live())).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})

describe('admin action tiers', () => {
  it('reads run without approval, and anything that widens waits for a device', () => {
    expect(adminTier('status.read')).toEqual({ tier: 'none' })
    expect(adminTier('tool.disable')).toEqual({ tier: 'notify' })
    expect(adminTier('draft.submit')).toEqual({ tier: 'approve', kind: 'adapter-install' })
    expect(adminTier('secret.request-grant')).toEqual({ tier: 'approve', kind: 'secret-grant' })
    expect(adminTier('valet.resume')).toBeNull()
  })

  it('knows nothing it was not told, and never offers pairing or answering approvals', () => {
    expect(adminTier('approval.answer')).toBeNull()
    expect(adminTier('toString')).toBeNull()
    for (const action of NEVER_OVER_MCP) expect(Object.hasOwn(ADMIN_ACTION_TIERS, action)).toBe(false)
  })
})

describe('stored evidence', () => {
  const request = serializeRequest(grantRequest())
  const evidence = {
    requestText: request.text,
    decision: decide(phone.approval, phoneId, request),
    receivedAt: '2026-11-12T01:04:01.000Z',
  }
  const context = { macId, devices: lookup() }
  const grantFor = (adapterHash: string) => (r: Extract<ApprovalRequest, { kind: 'secret-grant' }>) =>
    r.subject.adapterId === 'woolworths' && r.subject.adapterHash === adapterHash

  it('honours a record whose evidence approves exactly it', () => {
    expect(verifyEvidence(evidence, 'secret-grant', grantFor('a'.repeat(64)), context).ok).toBe(true)
  })

  it('refuses evidence copied onto another record or used as another kind', () => {
    expect(verifyEvidence(evidence, 'secret-grant', grantFor('b'.repeat(64)), context)).toEqual({
      ok: false,
      reason: 'subject-mismatch',
    })
    expect(verifyEvidence(evidence, 'adapter-install', () => true, context)).toEqual({
      ok: false,
      reason: 'wrong-kind',
    })
  })

  it('refuses kinds that are never remembered', () => {
    const call = serializeRequest({
      ...grantRequest(),
      kind: 'irreversible-call',
      tier: 'approve-each-use',
      subject: {
        adapterId: 'woolworths',
        adapterHash: 'a'.repeat(64),
        tool: 'checkout',
        callId: 'c1',
        confirmationId: 'cf_1',
        preview: ['Place order'],
      },
    } as ApprovalRequest)
    const e = {
      requestText: call.text,
      decision: decide(phone.approval, phoneId, call),
      receivedAt: '2026-11-12T01:04:01.000Z',
    }
    expect(verifyEvidence(e, 'irreversible-call', () => true, context)).toEqual({
      ok: false,
      reason: 'wrong-kind',
    })
  })

  it('refuses request text edited after the device signed it', () => {
    const edited = {
      ...evidence,
      requestText: evidence.requestText.replace('auth.woolworths.com.au', 'evil.example.com'),
    }
    expect(verifyEvidence(edited, 'secret-grant', () => true, context)).toEqual({
      ok: false,
      reason: 'wrong-request',
    })
    expect(verifyEvidence({ ...evidence, requestText: '{' }, 'secret-grant', () => true, context)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })
})

describe('display text and revocation', () => {
  it('refuses invisible letters and piles of combining marks', () => {
    expect(isDisplayText('Woolworths')).toBe(true)
    expect(isDisplayText('Café')).toBe(true)
    expect(isDisplayText('\u3164\u3164')).toBe(false)
    expect(isDisplayText(`a${'\u0336'.repeat(270)}`)).toBe(false)
    expect(isDisplayText('   ')).toBe(false)
    for (const bad of [
      '\u{E0100}\u{E0101}',
      'a\u0489',
      '\u20DD\u20DD',
      '\uFDFD\uFDFD',
      `a${'\u2000'.repeat(5)}b`,
      '\u0301\u0301',
    ]) {
      expect(isDisplayText(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('never lets anyone revoke the Mac itself', () => {
    expect(canRevokeDevice(macId, macId)).toBe(false)
    expect(canRevokeDevice(phoneId, macId)).toBe(true)
    const revocation = { deviceId: macId, macId, revokedAt: '2026-11-12T02:00:00.000Z', by: phoneId }
    expect(deviceRevocationSchema.safeParse(revocation).success).toBe(false)
    expect(deviceRevocationSchema.safeParse({ ...revocation, deviceId: phoneId, by: 'mac-ui' }).success).toBe(
      true,
    )
    const command = (deviceId: string) => ({
      type: 'command',
      seq: 1,
      command: { kind: 'revoke-device', deviceId },
    })
    expect(parsePhoneToMac(command(macId), macId)).toBeNull()
    expect(parsePhoneToMac(command(phoneId), macId)).not.toBeNull()
  })
})
