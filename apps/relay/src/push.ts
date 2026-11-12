// Pushes to phones (agent-run-security.md: pushes carry fixed text only). The Mac picks a kind;
// the payload is exactly `pushPayloadSchema`, so Apple sees nothing but a wake-up.
//
// APNs token auth: an ES256 JWT signed with the APNs key, reused for 50 minutes (Apple refuses one
// older than an hour, and one refreshed more often than every 20 minutes).

import { pushPayloadSchema } from '@valet/core/relay-protocol'
import { toBase64url } from './encoding'

export type PushKind = 'needs-you' | 'alert'
/** `gone`: Apple says the token is no longer valid; forget it. */
export type PushResult = 'sent' | 'gone' | 'failed' | 'off'

export interface PushSender {
  send(token: string, kind: PushKind): Promise<PushResult>
}

export const NO_PUSH: PushSender = { send: async () => 'off' }

export function pushPayload(kind: PushKind): string {
  const payload = {
    aps: {
      alert: { title: 'Valet', body: kind === 'needs-you' ? 'Valet needs you' : 'Something changed in Valet' },
    },
  }
  return JSON.stringify(pushPayloadSchema.parse(payload))
}

export interface ApnsSettings {
  /** The .p8 key's PEM text. A Worker secret. */
  readonly key: string
  readonly keyId: string
  readonly teamId: string
  /** The iOS app's bundle id. */
  readonly topic: string
  /** api.push.apple.com, or api.sandbox.push.apple.com for development builds. */
  readonly host: string
}

const JWT_REUSE_MS = 50 * 60_000

export class ApnsPushSender implements PushSender {
  private jwt: { readonly token: string; readonly at: number } | null = null
  private key: CryptoKey | null = null

  constructor(
    private readonly settings: ApnsSettings,
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly now: () => number = Date.now,
  ) {}

  async send(token: string, kind: PushKind): Promise<PushResult> {
    if (!/^[0-9a-f]{64,200}$/.test(token)) return 'failed'
    try {
      const response = await this.fetcher(`https://${this.settings.host}/3/device/${token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${await this.bearer()}`,
          'apns-topic': this.settings.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': '0',
          'content-type': 'application/json',
        },
        body: pushPayload(kind),
      })
      if (response.status === 200) return 'sent'
      if (response.status === 410) return 'gone'
      // Apple's 403 ExpiredProviderToken or InvalidProviderToken: mint a new JWT next time.
      if (response.status === 403) this.jwt = null
      return 'failed'
    } catch {
      return 'failed'
    }
  }

  private async bearer(): Promise<string> {
    const now = this.now()
    if (this.jwt !== null && now - this.jwt.at < JWT_REUSE_MS) return this.jwt.token
    this.key ??= await importP8(this.settings.key)
    const encode = (value: unknown) => toBase64url(new TextEncoder().encode(JSON.stringify(value)))
    const unsigned = `${encode({ alg: 'ES256', kid: this.settings.keyId })}.${encode({ iss: this.settings.teamId, iat: Math.floor(now / 1000) })}`
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.key,
      new TextEncoder().encode(unsigned),
    )
    const token = `${unsigned}.${toBase64url(new Uint8Array(signature))}`
    this.jwt = { token, at: now }
    return token
  }
}

async function importP8(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const binary = atob(body)
  const der = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i)
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}
