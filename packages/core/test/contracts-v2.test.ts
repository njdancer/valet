import { createCipheriv, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type DeviceLookup,
  decisionPayload,
  envelopeInfo,
  keyId,
  macToPhoneMessageSchema,
  macToRelaySchema,
  normaliseRecoveryCode,
  openSealed,
  pairingAad,
  pairingChallengePayload,
  pairingCode,
  pairingOfferId,
  pairingReplySchema,
  pairingSealKey,
  phoneToMacMessageSchema,
  phoneToRelaySchema,
  recoveryCodeHash,
  relayAuthPayload,
  relayHelloSchema,
  SIGNING_DOMAINS,
  seqVerdict,
  serializeRequest,
  signingInput,
  verifyDecision,
  verifyPairingChallenge,
  verifyRelayBinding,
} from '../src'

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}
const signWith = (
  key: KeyObject,
  domain: (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS],
  payload: string,
) => sign('sha256', signingInput(domain, payload), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')

describe('pairing', () => {
  const secret = randomBytes(32).toString('base64url')
  const macId = 'a'.repeat(32)

  it('names an offer without revealing the secret, and seals a reply only the secret opens', () => {
    const offerId = pairingOfferId(secret)
    expect(offerId).toMatch(/^[0-9a-f]{32}$/)
    expect(pairingOfferId(randomBytes(32).toString('base64url'))).not.toBe(offerId)
    const reply = JSON.stringify({
      v: 1,
      deviceName: 'Nick’s iPhone',
      platform: 'ios',
      approvalKey: p256().spki,
      transportKey: p256().spki,
      agreementKey: p256().spki,
    })
    expect(pairingReplySchema.safeParse(JSON.parse(reply)).success).toBe(true)
    const key = pairingSealKey(secret, macId)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(pairingAad('reply', offerId)))
    const ct = Buffer.concat([cipher.update(reply, 'utf8'), cipher.final(), cipher.getAuthTag()])
    const sealed = { iv: iv.toString('base64url'), ct: ct.toString('base64url') }
    expect(openSealed(key, sealed, pairingAad('reply', offerId))).toBe(reply)
    expect(
      openSealed(
        pairingSealKey(randomBytes(32).toString('base64url'), macId),
        sealed,
        pairingAad('reply', offerId),
      ),
    ).toBeNull()
    expect(openSealed(key, sealed, pairingAad('result', offerId))).toBeNull()
  })

  it('shows six digits that change with any part of the transcript', () => {
    const nonce = randomBytes(32).toString('base64url')
    const code = pairingCode(secret, macId, 'offer', 'reply', nonce)
    expect(code).toMatch(/^\d{6}$/)
    expect(pairingCode(secret, macId, 'offer', 'reply', nonce)).toBe(code)
    const fresh = new Set(
      Array.from({ length: 20 }, () =>
        pairingCode(secret, macId, 'offer', 'reply', randomBytes(32).toString('base64url')),
      ),
    )
    expect(fresh.size).toBeGreaterThan(15)
    const others = [
      pairingCode(secret, macId, 'offer!', 'reply', nonce),
      pairingCode(secret, macId, 'offer', 'reply!', nonce),
      pairingCode(secret, 'b'.repeat(32), 'offer', 'reply', nonce),
    ]
    expect(others.filter((c) => c === code).length).toBeLessThan(2)
  })

  it('lets a phone send a pairing reply before it has a hello, and nothing else', () => {
    const frame = {
      type: 'pairing-reply',
      macId,
      offerId: 'c'.repeat(32),
      sealed: { iv: 'A'.repeat(16), ct: 'B'.repeat(40) },
    }
    expect(phoneToRelaySchema.safeParse(frame).success).toBe(true)
    expect(phoneToRelaySchema.safeParse({ type: 'relay-lock' }).success).toBe(true)
    expect(phoneToRelaySchema.safeParse({ type: 'relay-unlock' }).success).toBe(false)
    expect(macToRelaySchema.safeParse({ type: 'relay-unlock' }).success).toBe(true)
  })
})

describe('relay hello', () => {
  const approval = p256()
  const transport = p256()
  const macId = keyId(approval.spki)

  it('signs a fixed key order', () => {
    expect(relayAuthPayload({ id: 'x', role: 'mac', relay: 'https://r', nonce: 'n' })).toBe(
      '{"nonce":"n","relay":"https://r","role":"mac","id":"x"}',
    )
  })

  it('binds a Mac’s first transport key to the approval key its id names', () => {
    const hello = {
      type: 'hello' as const,
      role: 'mac' as const,
      id: macId,
      transportKey: transport.spki,
      binding: {
        approvalKey: approval.spki,
        signature: signWith(approval.privateKey, SIGNING_DOMAINS.relayBinding, transport.spki),
      },
      signature: 'A'.repeat(86),
    }
    expect(verifyRelayBinding(relayHelloSchema.parse(hello))).toBe(true)
    const squatter = p256()
    const stolenId = {
      ...hello,
      binding: {
        approvalKey: squatter.spki,
        signature: signWith(squatter.privateKey, SIGNING_DOMAINS.relayBinding, transport.spki),
      },
    }
    expect(verifyRelayBinding(relayHelloSchema.parse(stolenId))).toBe(false)
    expect(relayHelloSchema.safeParse({ ...hello, binding: undefined }).success).toBe(false)
    expect(relayHelloSchema.safeParse({ ...hello, role: 'phone' }).success).toBe(false)
  })
})

describe('choices on a setting card', () => {
  const mac = p256()
  const phone = p256()
  const macId = keyId(mac.spki)
  const phoneId = keyId(phone.spki)
  const devices: DeviceLookup = {
    device: (id) =>
      id === phoneId
        ? {
            v: 1,
            deviceId: phoneId,
            macId,
            role: 'phone',
            platform: 'ios',
            name: 'Phone',
            approvalKey: phone.spki,
            transportKey: p256().spki,
            agreementKey: p256().spki,
            pairedAt: '2026-11-12T00:00:00.000Z',
          }
        : null,
    revokedAt: () => null,
  }
  const request = serializeRequest({
    v: 1,
    id: 'AAAAAAAAAAAAAAAAAAAAAA',
    macId,
    kind: 'setting',
    tier: 'approve',
    requester: { kind: 'person' },
    agentNote: null,
    createdAt: '2026-11-12T01:00:00.000Z',
    expiresAt: '2026-11-12T01:10:00.000Z',
    context: { kind: 'follows', requestId: 'BBBBBBBBBBBBBBBBBBBBBB' },
    display: { because: 'You asked from your phone', client: { label: 'Your phone', badge: 'person' } },
    subject: {
      scope: 'adapter',
      adapterId: 'woolworths',
      setting: 'store',
      label: 'Store',
      from: 'Bondi',
      to: 'Pick one',
      choices: [
        { value: '1234', label: 'Bondi Junction' },
        { value: '5678', label: 'Randwick' },
      ],
    },
  } as ApprovalRequest)
  const decide = (choice?: string) => {
    const decision: ApprovalDecision = {
      v: 1,
      decision: 'approve',
      macId,
      requestId: request.request.id,
      requestDigest: request.digest,
      deviceId: phoneId,
      decidedAt: '2026-11-12T01:04:00.000Z',
      ...(choice === undefined ? {} : { choice }),
    }
    const payload = decisionPayload(decision)
    return { payload, signature: signWith(phone.privateKey, SIGNING_DOMAINS.approvalDecision, payload) }
  }
  const live = {
    macId,
    devices,
    mode: 'live' as const,
    isPending: () => true,
    now: new Date('2026-11-12T01:05:00.000Z'),
  }

  it('signs the value picked, and refuses one that was not offered or a missing one', () => {
    expect(verifyDecision(decide('5678'), request, live)).toMatchObject({
      ok: true,
      decision: { choice: '5678' },
    })
    expect(verifyDecision(decide('9999'), request, live)).toEqual({ ok: false, reason: 'bad-choice' })
    expect(verifyDecision(decide(), request, live)).toEqual({ ok: false, reason: 'bad-choice' })
  })

  it('takes a remote client consent only with the code the person typed, never one shown to them', () => {
    const consent = serializeRequest({
      ...request.request,
      id: 'CCCCCCCCCCCCCCCCCCCCCC',
      kind: 'remote-client',
      context: undefined,
      subject: { clientId: 'remote:abc', host: 'claude.ai', sourceAddress: null, tools: [] },
    } as unknown as ApprovalRequest)
    expect(consent.text).not.toContain('code')
    const sign2 = (typedCode?: string) => {
      const payload = decisionPayload({
        v: 1,
        decision: 'approve',
        macId,
        requestId: consent.request.id,
        requestDigest: consent.digest,
        deviceId: phoneId,
        decidedAt: '2026-11-12T01:04:00.000Z',
        ...(typedCode === undefined ? {} : { typedCode }),
      })
      return { payload, signature: signWith(phone.privateKey, SIGNING_DOMAINS.approvalDecision, payload) }
    }
    const ctx = { ...live, consentCode: () => 'KXRT-MWPA' }
    expect(verifyDecision(sign2('KXRT-MWPA'), consent, ctx)).toMatchObject({ ok: true })
    expect(verifyDecision(sign2('KXRT-MWPB'), consent, ctx)).toEqual({ ok: false, reason: 'wrong-code' })
    expect(verifyDecision(sign2(), consent, ctx)).toEqual({ ok: false, reason: 'wrong-code' })
    expect(() => sign2('KXRT-MW0A')).toThrow()
    expect(verifyDecision(sign2('KXRT-MWPA'), request, live)).toMatchObject({ ok: false })
  })
})

describe('new channel messages', () => {
  it('carries status, hand-offs, asks, decline notes and login codes, each one way', () => {
    expect(
      macToPhoneMessageSchema.safeParse({
        type: 'status',
        seq: 1,
        at: '2026-11-12T01:00:00.000Z',
        safety: 'running',
        sites: [{ adapterId: 'woolworths', name: 'Woolworths', health: 'ok' }],
        agents: [],
        devices: [],
        recent: [],
      }).success,
    ).toBe(true)
    expect(
      phoneToMacMessageSchema.safeParse({
        type: 'ask',
        seq: 2,
        action: 'tool.enable',
        adapterId: 'woolworths',
        tool: 'add_to_cart',
      }).success,
    ).toBe(true)
    expect(phoneToMacMessageSchema.safeParse({ type: 'ask', seq: 2, action: 'valet.resume' }).success).toBe(
      false,
    )
    expect(phoneToMacMessageSchema.safeParse({ type: 'ask', seq: 2, action: 'device.pair' }).success).toBe(
      false,
    )
    expect(
      phoneToMacMessageSchema.safeParse({
        type: 'approval-decline',
        seq: 3,
        requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
        note: 'Not now',
        stopAsking: true,
      }).success,
    ).toBe(true)
    expect(
      phoneToMacMessageSchema.safeParse({
        type: 'login-code',
        seq: 4,
        handoffId: 'handoff01',
        code: '123456',
      }).success,
    ).toBe(true)
    expect(
      phoneToMacMessageSchema.safeParse({ type: 'login-code', seq: 4, handoffId: 'handoff01', code: '12 34' })
        .success,
    ).toBe(false)
    expect(
      macToPhoneMessageSchema.safeParse({
        type: 'approval-closed',
        seq: 5,
        requestId: 'AAAAAAAAAAAAAAAAAAAAAA',
        outcome: 'refused',
        reason: 'expired',
        deviceId: null,
      }).success,
    ).toBe(true)
  })
})

describe('sequence numbers and envelope info', () => {
  it('accepts only the next message, re-acks duplicates and holds gaps', () => {
    expect(seqVerdict(4, 5)).toBe('accept')
    expect(seqVerdict(4, 4)).toBe('duplicate')
    expect(seqVerdict(4, 2)).toBe('duplicate')
    expect(seqVerdict(4, 6)).toBe('gap')
  })

  it('pins the HPKE info as the two key ids’ bytes, sender first', () => {
    expect(envelopeInfo('00'.repeat(16), 'ff'.repeat(16)).toString('hex')).toBe(
      `${'00'.repeat(16)}${'ff'.repeat(16)}`,
    )
  })

  it('tells a revoked phone to unpair', () => {
    expect(
      macToPhoneMessageSchema.safeParse({ type: 'unpaired', seq: 9, at: '2026-11-12T03:00:00.000Z' }).success,
    ).toBe(true)
  })
})

describe('recovery code', () => {
  it('normalises the way the relay does and hashes the result', () => {
    expect(normaliseRecoveryCode('abcd-efgh ijkl-2345')).toBe('ABCDEFGHIJKL2345')
    expect(normaliseRecoveryCode('short-1')).toBeNull()
    expect(normaliseRecoveryCode('ABCD-EFGH-IJKL-234!')).toBeNull()
    // A fixed vector for the relay's own test.
    expect(recoveryCodeHash('abcd-efgh ijkl-2345')).toBe(
      'b9880d7c06e097c42704a1566f627b1cfad0795a8693f185eb7b673001dbeca5',
    )
  })
})

describe('signed pairing challenge (CR-11)', () => {
  it('lets the phone tell a challenge over its own reply from one over an attacker reply', () => {
    const mac = p256()
    const offerId = 'a'.repeat(32)
    const nonce = randomBytes(32).toString('base64url')
    const phoneReply = '{"v":1,"deviceName":"Phone"}'
    const attackerReply = '{"v":1,"deviceName":"Phone "}'
    const sig = (reply: string, n = nonce) =>
      signWith(mac.privateKey, SIGNING_DOMAINS.pairingChallenge, pairingChallengePayload(offerId, n, reply))
    expect(verifyPairingChallenge(mac.spki, offerId, nonce, phoneReply, sig(phoneReply))).toBe(true)
    // The Mac accepted the attacker's reply: its signature names that reply, not the phone's.
    expect(verifyPairingChallenge(mac.spki, offerId, nonce, phoneReply, sig(attackerReply))).toBe(false)
    // A ground nonce the Mac never signed.
    const ground = randomBytes(32).toString('base64url')
    expect(verifyPairingChallenge(mac.spki, offerId, ground, phoneReply, sig(phoneReply))).toBe(false)
    expect(macToRelaySchema.safeParse({ type: 'pairing-challenge', offerId, macNonce: nonce }).success).toBe(
      false,
    )
    expect(
      macToRelaySchema.safeParse({
        type: 'pairing-challenge',
        offerId,
        macNonce: nonce,
        signature: sig(phoneReply),
      }).success,
    ).toBe(true)
  })
})
