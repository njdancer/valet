import { createECDH, diffieHellman, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'
import { describe, expect, it } from 'vitest'
import { envelopeInfo, keyId, openSealed, pairingAad } from '../src'
import { openEnvelope, rawPoint, sealEnvelope, sealPairing } from '../src/channel-seal'

function party() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  return {
    spki,
    id: keyId(spki),
    privateKey,
    publicKey,
    agree: async (peer: KeyObject) => diffieHellman({ privateKey, publicKey: peer }),
  }
}

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

async function webKeys(p: ReturnType<typeof party>) {
  const kem = new DhkemP256HkdfSha256()
  const d = p.privateKey.export({ format: 'jwk' }).d as string
  const priv = await kem.deserializePrivateKey(new Uint8Array(Buffer.from(d, 'base64url')))
  const pub = await kem.deserializePublicKey(new Uint8Array(rawPoint(p.publicKey)))
  return { priv, pub }
}

describe('channel seal (RFC 9180 auth mode)', () => {
  it('round-trips, and an independent HPKE implementation opens what it seals', async () => {
    const mac = party()
    const phone = party()
    const parties = { from: mac.id, to: phone.id, senderKey: mac.spki, recipientKey: phone.spki }
    const env = await sealEnvelope('{"type":"ack","seq":1,"ackSeq":1}', parties, mac.agree)
    expect(env.enc).toHaveLength(87)
    expect(await openEnvelope(env, parties, phone.agree)).toBe('{"type":"ack","seq":1,"ackSeq":1}')

    const r = await webKeys(phone)
    const s = await webKeys(mac)
    const recipient = await suite.createRecipientContext({
      recipientKey: r.priv,
      enc: new Uint8Array(Buffer.from(env.enc, 'base64url')).buffer,
      info: new Uint8Array(envelopeInfo(mac.id, phone.id)).buffer,
      senderPublicKey: s.pub,
    })
    const pt = await recipient.open(new Uint8Array(Buffer.from(env.ct, 'base64url')).buffer)
    expect(Buffer.from(pt).toString()).toBe('{"type":"ack","seq":1,"ackSeq":1}')
  })

  it('opens what an independent HPKE implementation seals', async () => {
    const mac = party()
    const phone = party()
    const r = await webKeys(mac)
    const s = await webKeys(phone)
    const sender = await suite.createSenderContext({
      recipientPublicKey: r.pub,
      info: new Uint8Array(envelopeInfo(phone.id, mac.id)).buffer,
      senderKey: { privateKey: s.priv, publicKey: s.pub },
    })
    const ct = await sender.seal(new TextEncoder().encode('hello mac').buffer)
    const env = {
      v: 1 as const,
      suite: 'hpke-auth-p256-sha256-aes256gcm' as const,
      from: phone.id,
      to: mac.id,
      enc: Buffer.from(sender.enc).toString('base64url'),
      ct: Buffer.from(ct).toString('base64url'),
    }
    const parties = { from: phone.id, to: mac.id, senderKey: phone.spki, recipientKey: mac.spki }
    expect(await openEnvelope(env, parties, mac.agree)).toBe('hello mac')
  })

  it('refuses the wrong sender, the wrong recipient and altered bytes', async () => {
    const mac = party()
    const phone = party()
    const other = party()
    const parties = { from: mac.id, to: phone.id, senderKey: mac.spki, recipientKey: phone.spki }
    const env = await sealEnvelope('x', parties, mac.agree)
    expect(await openEnvelope(env, { ...parties, senderKey: other.spki }, phone.agree)).toBeNull()
    expect(await openEnvelope(env, { ...parties, from: other.id }, phone.agree)).toBeNull()
    expect(await openEnvelope(env, { ...parties, recipientKey: other.spki }, other.agree)).toBeNull()
    const bytes = Buffer.from(env.ct, 'base64url')
    bytes[0] ^= 1
    expect(await openEnvelope({ ...env, ct: bytes.toString('base64url') }, parties, phone.agree)).toBeNull()
  })

  it('seals pairing messages that openSealed opens', () => {
    const key = Buffer.alloc(32, 7)
    const sealed = sealPairing(key, 'result', pairingAad('result', 'a'.repeat(32)))
    expect(openSealed(key, sealed, pairingAad('result', 'a'.repeat(32)))).toBe('result')
    expect(openSealed(key, sealed, pairingAad('reply', 'a'.repeat(32)))).toBeNull()
  })

  it('a fixed ephemeral gives the same envelope twice', async () => {
    const mac = party()
    const phone = party()
    const parties = { from: mac.id, to: phone.id, senderKey: mac.spki, recipientKey: phone.spki }
    const e = createECDH('prime256v1')
    e.generateKeys()
    const a = await sealEnvelope('same', parties, mac.agree, e.getPrivateKey())
    const b = await sealEnvelope('same', parties, mac.agree, e.getPrivateKey())
    expect(a).toEqual(b)
  })
})
