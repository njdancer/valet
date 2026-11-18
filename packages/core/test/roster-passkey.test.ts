import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  keyId,
  nextRosterChange,
  PASSKEY_SIGNER,
  passkeyChallenge,
  type Roster,
  type RosterChange,
  type RosterDevice,
  type RosterPasskey,
  rawFromDerSignature,
  SIGNING_DOMAINS,
  type SignedRosterChange,
  spkiFromCoseP256,
  verifyRoster,
} from '../src/index'

const ACCOUNT = 'acct_0123456789abcdef'
const AT = '2026-11-18T00:00:00.000Z'
const RP = 'valet.dncr.me'

function keyPair(): { publicKey: string; privateKey: KeyObject; jwk: { x: string; y: string } } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  return {
    publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url'),
    privateKey,
    jwk,
  }
}

function device(role: 'mac' | 'phone') {
  const approval = keyPair()
  const record: RosterDevice = {
    deviceId: keyId(approval.publicKey),
    role,
    platform: role === 'mac' ? 'macos' : 'ios',
    name: role === 'mac' ? 'MacBook Pro' : 'iPhone',
    approvalKey: approval.publicKey,
    transportKey: keyPair().publicKey,
    agreementKey: keyPair().publicKey,
  }
  return {
    record,
    sign: (payload: string): SignedRosterChange => ({
      payload,
      signature: sign('sha256', Buffer.from(`${SIGNING_DOMAINS.rosterChange}\n${payload}`), {
        key: approval.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url'),
    }),
  }
}

/** A passkey as a browser's authenticator would use it: signs WebAuthn assertions over a challenge. */
function passkey(rpId = RP) {
  const pair = keyPair()
  const record: RosterPasskey = {
    passkeyId: keyId(pair.publicKey),
    credentialId: 'Y3JlZGVudGlhbC0xMjM0NTY3OA',
    publicKey: pair.publicKey,
    rpId,
    name: 'iCloud Keychain',
  }
  return {
    record,
    pair,
    assert(
      payload: string,
      tweak: { origin?: string; type?: string; flags?: number; challenge?: string; rpId?: string } = {},
    ): SignedRosterChange {
      const client = Buffer.from(
        JSON.stringify({
          type: tweak.type ?? 'webauthn.get',
          challenge: tweak.challenge ?? passkeyChallenge(payload).toString('base64url'),
          origin: tweak.origin ?? `https://${rpId}`,
          crossOrigin: false,
        }),
      )
      const authenticatorData = Buffer.concat([
        createHash('sha256')
          .update(tweak.rpId ?? rpId)
          .digest(),
        Buffer.from([tweak.flags ?? 0x05]),
        Buffer.from([0, 0, 0, 1]),
      ])
      const der = sign(
        'sha256',
        Buffer.concat([authenticatorData, createHash('sha256').update(client).digest()]),
        {
          key: pair.privateKey,
          dsaEncoding: 'der',
        },
      )
      return {
        payload,
        signature: rawFromDerSignature(der) as string,
        webauthn: {
          credentialId: record.credentialId,
          authenticatorData: authenticatorData.toString('base64url'),
          clientDataJSON: client.toString('base64url'),
        },
      }
    },
  }
}

function roster(chain: SignedRosterChange[]): Roster {
  const check = verifyRoster(chain)
  if (!check.ok) throw new Error(`chain failed: ${check.reason} at ${check.at}`)
  return check.roster
}

function next(chain: SignedRosterChange[], by: string, change: RosterChange['change']): string {
  return nextRosterChange(chain.length === 0 ? null : roster(chain), ACCOUNT, by, change, AT)
}

/** A list with a Mac on it that put `key` on it. */
function listWith(key: ReturnType<typeof passkey>) {
  const mac = device('mac')
  const chain: SignedRosterChange[] = []
  chain.push(mac.sign(next(chain, mac.record.deviceId, { op: 'add', device: mac.record })))
  chain.push(mac.sign(next(chain, mac.record.deviceId, { op: 'add-passkey', passkey: key.record })))
  return { mac, chain }
}

describe('passkeys on the account’s list', () => {
  it('lets a passkey a device put on the list sign an iPhone in', () => {
    const key = passkey()
    const { chain } = listWith(key)
    expect([...roster(chain).passkeys.keys()]).toEqual([key.record.passkeyId])
    const phone = device('phone')
    chain.push(key.assert(next(chain, PASSKEY_SIGNER, { op: 'add', device: phone.record })))
    const after = roster(chain)
    expect(after.devices.get(phone.record.deviceId)).toEqual(phone.record)
    // The phone is a full member: it can sign changes itself.
    const tablet = device('phone')
    chain.push(phone.sign(next(chain, phone.record.deviceId, { op: 'add', device: tablet.record })))
    expect(roster(chain).devices.size).toBe(3)
  })

  it('never lets a passkey add a Mac, remove anything or add another passkey', () => {
    const key = passkey()
    const by = PASSKEY_SIGNER
    for (const change of [
      { op: 'add', device: device('mac').record },
      { op: 'add', device: { ...device('phone').record, platform: 'macos' } },
      { op: 'add-passkey', passkey: passkey().record },
    ] as RosterChange['change'][]) {
      const { chain } = listWith(key)
      chain.push(key.assert(next(chain, by, change)))
      expect(verifyRoster(chain)).toMatchObject({ ok: false, at: 2, reason: 'not-allowed' })
    }
    const { mac, chain } = listWith(key)
    chain.push(key.assert(next(chain, by, { op: 'remove', deviceId: mac.record.deviceId })))
    expect(verifyRoster(chain)).toMatchObject({ ok: false, reason: 'not-allowed' })
  })

  it('refuses an assertion for anything but exactly this change, here, with the person verified', () => {
    const key = passkey()
    const cases: Parameters<typeof key.assert>[1][] = [
      { origin: 'https://evil.example' },
      { origin: `http://${RP}` },
      { type: 'webauthn.create' },
      { flags: 0x01 },
      { challenge: passkeyChallenge('{"other":1}').toString('base64url') },
      { rpId: 'evil.example' },
    ]
    for (const tweak of cases) {
      const { chain } = listWith(key)
      chain.push(
        key.assert(next(chain, PASSKEY_SIGNER, { op: 'add', device: device('phone').record }), tweak),
      )
      expect(verifyRoster(chain), JSON.stringify(tweak)).toMatchObject({ ok: false, reason: 'bad-signature' })
    }
    // Another passkey's signature, a passkey not (or no longer) on the list, a missing assertion.
    const { mac, chain } = listWith(key)
    const other = passkey()
    const payload = next(chain, PASSKEY_SIGNER, { op: 'add', device: device('phone').record })
    expect(verifyRoster([...chain, other.assert(payload)])).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    })
    const bare = key.assert(payload)
    expect(verifyRoster([...chain, { payload, signature: bare.signature }])).toMatchObject({
      ok: false,
      reason: 'malformed',
    })
    chain.push(
      mac.sign(next(chain, mac.record.deviceId, { op: 'remove-passkey', passkeyId: key.record.passkeyId })),
    )
    expect(roster(chain).passkeys.size).toBe(0)
    const late = key.assert(next(chain, PASSKEY_SIGNER, { op: 'add', device: device('phone').record }))
    expect(verifyRoster([...chain, late])).toMatchObject({ ok: false, reason: 'not-a-member' })
    // A device's change can't carry an assertion.
    const signed = mac.sign(next(chain, mac.record.deviceId, { op: 'add', device: device('phone').record }))
    expect(verifyRoster([...chain, { ...signed, webauthn: bare.webauthn }])).toMatchObject({
      ok: false,
      reason: 'malformed',
    })
  })

  it('reads a P-256 COSE key as SPKI and turns a DER signature into raw r||s', () => {
    const key = passkey()
    const x = Buffer.from(key.pair.jwk.x, 'base64url')
    const y = Buffer.from(key.pair.jwk.y, 'base64url')
    // {1: 2, 3: -7, -1: 1, -2: x, -3: y}
    const cose = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      x,
      Buffer.from([0x22, 0x58, 0x20]),
      y,
    ])
    expect(spkiFromCoseP256(cose)).toBe(key.record.publicKey)
    // RS256 (alg -257) or Ed25519 keys don't qualify.
    expect(spkiFromCoseP256(Buffer.from([0xa2, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00]))).toBeNull()
    expect(spkiFromCoseP256(Buffer.from([0x00]))).toBeNull()
    expect(rawFromDerSignature(Buffer.from([0x30, 0x02, 0x00, 0x00]))).toBeNull()
  })
})

// Shared with the iPhone app's Swift port (ios/ValetPhoneKit, CryptoTests): a chain a Mac started,
// put a passkey on, and a passkey added a phone to. VALET_WRITE_PASSKEY_VECTORS=1 writes it afresh.
const PASSKEY_VECTORS = fileURLToPath(
  new URL('../../../ios/ValetPhoneKit/Tests/ValetCryptoTests/Vectors/passkey-vectors.json', import.meta.url),
)

if (process.env['VALET_WRITE_PASSKEY_VECTORS'] === '1') {
  const key = passkey()
  const { chain } = listWith(key)
  const phone = device('phone')
  chain.push(key.assert(next(chain, PASSKEY_SIGNER, { op: 'add', device: phone.record })))
  const checked = roster(chain)
  const evil = key.assert(next(chain.slice(0, 2), PASSKEY_SIGNER, { op: 'add', device: device('phone').record }), {
    origin: 'https://evil.example',
  })
  writeFileSync(
    PASSKEY_VECTORS,
    `${JSON.stringify(
      {
        note: 'Written by packages/core/test/roster-passkey.test.ts with VALET_WRITE_PASSKEY_VECTORS=1. Do not edit by hand.',
        chain,
        passkeyId: key.record.passkeyId,
        phoneId: phone.record.deviceId,
        head: checked.head,
        wrongOrigin: [...chain.slice(0, 2), evil],
      },
      null,
      2,
    )}\n`,
  )
}

describe('the passkey vectors the iPhone app checks', () => {
  it('still check in core, and the wrong-origin one still fails', () => {
    const v = JSON.parse(readFileSync(PASSKEY_VECTORS, 'utf8')) as {
      chain: SignedRosterChange[]
      passkeyId: string
      phoneId: string
      head: string
      wrongOrigin: SignedRosterChange[]
    }
    const checked = roster(v.chain)
    expect(checked.head).toBe(v.head)
    expect(checked.passkeys.has(v.passkeyId)).toBe(true)
    expect(checked.devices.get(v.phoneId)?.role).toBe('phone')
    expect(verifyRoster(v.wrongOrigin)).toMatchObject({ ok: false, at: 2, reason: 'bad-signature' })
  })
})
