// A software passkey for the hub's tests: what a platform authenticator returns, in the JSON form
// browsers give (PublicKeyCredential.toJSON), with "none" attestation and an ES256 key.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor> | { readonly [key: string]: Cbor }

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value]
  if (value < 256) return [(major << 5) | 24, value]
  if (value < 65536) return [(major << 5) | 25, value >> 8, value & 255]
  return [(major << 5) | 26, (value >>> 24) & 255, (value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function cbor(value: Cbor): number[] {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = [...Buffer.from(value, 'utf8')]
    return [...head(3, bytes.length), ...bytes]
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value]
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value)
  return [...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])]
}

const b64 = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url')

export interface TestPasskey {
  readonly id: string
  /** Answers navigator.credentials.create's options. */
  register(options: { challenge: string; user: { id: string } }, origin: string): Record<string, unknown>
  /** Answers navigator.credentials.get's options. */
  assert(options: { challenge: string }, origin: string): Record<string, unknown>
}

export function testPasskey(rpId: string): TestPasskey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const credentialId = randomBytes(16)
  const id = b64(credentialId)
  const rpIdHash = createHash('sha256').update(rpId).digest()
  let counter = 0
  let userHandle = ''

  const counterBytes = () => {
    const out = Buffer.alloc(4)
    out.writeUInt32BE(counter)
    return out
  }

  return {
    id,
    register(options, origin) {
      userHandle = options.user.id
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }),
      )
      const coseKey = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ])
      const idLength = Buffer.alloc(2)
      idLength.writeUInt16BE(credentialId.length)
      const authData = Buffer.concat([
        rpIdHash,
        Buffer.from([0x45]), // user present, user verified, attested credential data
        counterBytes(),
        Buffer.alloc(16), // aaguid
        idLength,
        credentialId,
        Buffer.from(cbor(coseKey)),
      ])
      const attestationObject = Buffer.from(cbor({ fmt: 'none', attStmt: {}, authData }))
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64(clientData),
          attestationObject: b64(attestationObject),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
      }
    },
    assert(options, origin) {
      counter++
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }),
      )
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), counterBytes()])
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
        privateKey,
      )
      return {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: b64(clientData),
          authenticatorData: b64(authData),
          signature: b64(signature),
          userHandle,
        },
        clientExtensionResults: {},
      }
    },
  }
}
