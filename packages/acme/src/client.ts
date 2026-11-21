// A small ACME client (RFC 8555) for one job: a certificate for one name, proved with TLS-ALPN-01
// (RFC 8737), renewed when ACME Renewal Info says so (RFC 9773). Let's Encrypt only in practice;
// Pebble in tests. Every request after the directory is a JWS signed with the account's P-256 key.

import { createHash, type KeyObject, sign, X509Certificate } from 'node:crypto'
import { certificateRequest, type KeyPair } from './x509'

export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory'
export const LETS_ENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

export interface AcmeDirectory {
  readonly newNonce: string
  readonly newAccount: string
  readonly newOrder: string
  readonly renewalInfo?: string
  readonly meta?: { readonly termsOfService?: string }
}

/** The CA said no; `type` is its problem type (urn:ietf:params:acme:error:…). */
export class AcmeError extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    detail: string,
    /** When the CA said to come back, for rate limits. */
    readonly retryAfter: Date | null = null,
  ) {
    super(`${type}: ${detail}`.slice(0, 500))
  }

  get rateLimited(): boolean {
    return this.type === 'urn:ietf:params:acme:error:rateLimited'
  }
}

export interface AcmeClientOptions {
  readonly directoryUrl: string
  /** The account key. One per Mac: no shared credentials. */
  readonly accountKey: KeyPair
  /** The account's URL from an earlier run, so it isn't looked up again. */
  readonly accountUrl?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** Waits between polls. Tests pass a short one. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly pollMs?: number
  /** Gives up on an order after this long. */
  readonly orderTimeoutMs?: number
}

export interface IssueOptions {
  readonly name: string
  /** The certificate's own key, which never leaves the Mac. */
  readonly certificateKey: KeyPair
  /**
   * Sets up the TLS-ALPN-01 answer for `name` (a self-signed certificate carrying the key
   * authorisation), before the CA is told to look. Undone with `clear` after.
   */
  readonly present: (name: string, keyAuthorization: string) => void | Promise<void>
  readonly clear: (name: string) => void | Promise<void>
  /** ARI: the certificate this one replaces, so its renewal is exempt from rate limits. */
  readonly replaces?: string
}

export interface Issued {
  /** The chain, leaf first, PEM. */
  readonly pem: string
  readonly notAfter: Date
  /** The ARI id of this certificate. */
  readonly certId: string
}

export interface RenewalWindow {
  readonly start: Date
  readonly end: Date
  /** When to ask again, from Retry-After. */
  readonly checkAgainAt: Date
}

type Json = Record<string, unknown>

export class AcmeClient {
  private directory: AcmeDirectory | null = null
  private nonce: string | null = null
  private kid: string | null
  private readonly jwk: Json
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: AcmeClientOptions) {
    this.kid = options.accountUrl ?? null
    this.jwk = publicJwk(options.accountKey.publicKey)
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** The account key, for a caller that keeps it. */
  get accountKey(): KeyPair {
    return this.options.accountKey
  }

  /** The account URL, once known; the caller keeps it. */
  get accountUrl(): string | null {
    return this.kid
  }

  /** RFC 8555 section 8.1: token.thumbprint. */
  keyAuthorization(token: string): string {
    return `${token}.${jwkThumbprint(this.jwk)}`
  }

  async getDirectory(): Promise<AcmeDirectory> {
    if (this.directory !== null) return this.directory
    const res = await this.fetch(this.options.directoryUrl)
    if (!res.ok) throw new AcmeError('directory', res.status, 'could not read the directory')
    const body = (await res.json()) as AcmeDirectory
    if (
      typeof body.newNonce !== 'string' ||
      typeof body.newAccount !== 'string' ||
      typeof body.newOrder !== 'string'
    )
      throw new AcmeError('directory', res.status, 'directory is missing endpoints')
    this.directory = body
    return body
  }

  /** Creates the account, or finds it again for this key, and agrees to the terms. */
  async account(): Promise<string> {
    if (this.kid !== null) return this.kid
    const directory = await this.getDirectory()
    const res = await this.post(directory.newAccount, { termsOfServiceAgreed: true }, { useJwk: true })
    const location = res.headers.get('location')
    if (location === null) throw new AcmeError('account', res.status, 'no account URL')
    this.kid = location
    return location
  }

  /** Orders, proves and downloads a certificate for one name. */
  async issue(options: IssueOptions): Promise<Issued> {
    const directory = await this.getDirectory()
    await this.account()
    const started = this.now()
    const deadline = started + (this.options.orderTimeoutMs ?? 5 * 60_000)
    const orderBody: Json = { identifiers: [{ type: 'dns', value: options.name }] }
    if (options.replaces !== undefined && directory.renewalInfo !== undefined)
      orderBody['replaces'] = options.replaces
    let res = await this.post(directory.newOrder, orderBody)
    const orderUrl = res.headers.get('location')
    if (orderUrl === null) throw new AcmeError('order', res.status, 'no order URL')
    let order = (await res.json()) as {
      status: string
      authorizations: string[]
      finalize: string
      certificate?: string
    }
    for (const authzUrl of order.authorizations) await this.authorize(authzUrl, options, deadline)

    const csr = certificateRequest(options.certificateKey, [options.name])
    res = await this.post(order.finalize, { csr: csr.toString('base64url') })
    order = (await res.json()) as typeof order
    while (order.status !== 'valid') {
      if (order.status === 'invalid') throw new AcmeError('order', 0, 'the order failed')
      if (this.now() > deadline) throw new AcmeError('timeout', 0, 'the order took too long')
      await this.sleep(retryAfterMs(res, this.options.pollMs ?? 1000))
      res = await this.post(orderUrl, null)
      order = (await res.json()) as typeof order
    }
    if (order.certificate === undefined) throw new AcmeError('order', 0, 'no certificate URL')
    res = await this.post(order.certificate, null, { accept: 'application/pem-certificate-chain' })
    const pem = await res.text()
    const leaf = new X509Certificate(pem)
    if (!leaf.checkHost(options.name) || !leaf.publicKey.equals(options.certificateKey.publicKey))
      throw new AcmeError('certificate', 0, 'the CA sent a certificate for another name or key')
    return { pem, notAfter: new Date(leaf.validTo), certId: ariCertId(leaf) }
  }

  /** ARI: when the CA wants this certificate renewed. Null when the CA has no ARI. */
  async renewalWindow(certId: string): Promise<RenewalWindow | null> {
    const directory = await this.getDirectory()
    if (directory.renewalInfo === undefined) return null
    const res = await this.fetch(`${directory.renewalInfo.replace(/\/$/, '')}/${certId}`)
    if (!res.ok) throw new AcmeError('renewalInfo', res.status, 'could not read renewal info')
    const body = (await res.json()) as { suggestedWindow?: { start?: string; end?: string } }
    const start = new Date(body.suggestedWindow?.start ?? '')
    const end = new Date(body.suggestedWindow?.end ?? '')
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start)
      throw new AcmeError('renewalInfo', res.status, 'bad renewal window')
    return { start, end, checkAgainAt: new Date(this.now() + retryAfterMs(res, 6 * 3600_000)) }
  }

  private async authorize(url: string, options: IssueOptions, deadline: number): Promise<void> {
    let res = await this.post(url, null)
    let authz = (await res.json()) as {
      status: string
      identifier: { value: string }
      challenges: { type: string; url: string; token: string; status: string }[]
    }
    if (authz.status === 'valid') return
    if (authz.identifier.value !== options.name)
      throw new AcmeError('authz', 0, 'authorisation for another name')
    const challenge = authz.challenges.find((c) => c.type === 'tls-alpn-01')
    if (challenge === undefined) throw new AcmeError('authz', 0, 'the CA offered no tls-alpn-01 challenge')
    if (!/^[A-Za-z0-9_-]+$/.test(challenge.token)) throw new AcmeError('authz', 0, 'bad challenge token')
    await options.present(options.name, this.keyAuthorization(challenge.token))
    try {
      await this.post(challenge.url, {})
      for (;;) {
        await this.sleep(retryAfterMs(res, this.options.pollMs ?? 1000))
        res = await this.post(url, null)
        authz = (await res.json()) as typeof authz
        if (authz.status === 'valid') return
        if (authz.status !== 'pending' && authz.status !== 'processing') {
          const failed = authz.challenges.find((c) => c.type === 'tls-alpn-01') as unknown as {
            error?: { type?: string; detail?: string }
          }
          throw new AcmeError(failed?.error?.type ?? 'authz', 0, failed?.error?.detail ?? 'validation failed')
        }
        if (this.now() > deadline) throw new AcmeError('timeout', 0, 'validation took too long')
      }
    } finally {
      await options.clear(options.name)
    }
  }

  /** A signed POST (POST-as-GET when `payload` is null), retrying once on a stale nonce. */
  private async post(
    url: string,
    payload: Json | null,
    options: { useJwk?: boolean; accept?: string } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const nonce = await this.takeNonce()
      const header: Json = { alg: 'ES256', nonce, url }
      if (options.useJwk === true || this.kid === null) header['jwk'] = this.jwk
      else header['kid'] = this.kid
      const protectedPart = b64(JSON.stringify(header))
      const payloadPart = payload === null ? '' : b64(JSON.stringify(payload))
      const signature = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`), {
        key: this.options.accountKey.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url')
      const res = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/jose+json',
          ...(options.accept === undefined ? {} : { accept: options.accept }),
        },
        body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature }),
      })
      const next = res.headers.get('replay-nonce')
      this.nonce = next
      if (res.ok) return res
      const problem = (await res.json().catch(() => ({}))) as { type?: string; detail?: string }
      const type = problem.type ?? 'unknown'
      if (type === 'urn:ietf:params:acme:error:badNonce' && attempt < 3) continue
      const retryAfter = res.headers.has('retry-after') ? new Date(this.now() + retryAfterMs(res, 0)) : null
      throw new AcmeError(type, res.status, problem.detail ?? '', retryAfter)
    }
  }

  private async takeNonce(): Promise<string> {
    const held = this.nonce
    this.nonce = null
    if (held !== null) return held
    const directory = await this.getDirectory()
    const res = await this.fetch(directory.newNonce, { method: 'HEAD' })
    const nonce = res.headers.get('replay-nonce')
    if (nonce === null) throw new AcmeError('nonce', res.status, 'no nonce')
    return nonce
  }
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function publicJwk(key: KeyObject): Json {
  const jwk = key.export({ format: 'jwk' }) as Json
  return { crv: jwk['crv'], kty: jwk['kty'], x: jwk['x'], y: jwk['y'] }
}

/** RFC 7638: SHA-256 over the required members in lexical order. */
export function jwkThumbprint(jwk: Json): string {
  const canonical = JSON.stringify({ crv: jwk['crv'], kty: jwk['kty'], x: jwk['x'], y: jwk['y'] })
  return createHash('sha256').update(canonical).digest('base64url')
}

function retryAfterMs(res: Response, fallback: number): number {
  const value = res.headers.get('retry-after')
  if (value === null) return fallback
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 86_400) * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? fallback : Math.min(Math.max(date - Date.now(), 0), 86_400_000)
}

/**
 * RFC 9773 section 4.1: base64url(authority key identifier) "." base64url(serial number), the
 * serial as its DER INTEGER content bytes.
 */
export function ariCertId(cert: X509Certificate): string {
  const aki = authorityKeyIdentifier(cert.raw)
  if (aki === null) throw new Error('certificate has no authority key identifier')
  let serial = Buffer.from(
    cert.serialNumber.length % 2 === 0 ? cert.serialNumber : `0${cert.serialNumber}`,
    'hex',
  )
  if (serial.length > 0 && (serial[0] as number) & 0x80) serial = Buffer.concat([Buffer.from([0]), serial])
  return `${aki.toString('base64url')}.${serial.toString('base64url')}`
}

/** The keyIdentifier of the authorityKeyIdentifier extension (2.5.29.35), read from DER. */
function authorityKeyIdentifier(der: Buffer): Buffer | null {
  const oidBytes = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x23])
  const at = der.indexOf(oidBytes)
  if (at < 0) return null
  let i = at + oidBytes.length
  if (der[i] === 0x01) i += 3 // critical BOOLEAN
  if (der[i] !== 0x04) return null
  const [, octetStart] = readLength(der, i + 1)
  i = octetStart
  if (der[i] !== 0x30) return null
  const [, seqStart] = readLength(der, i + 1)
  i = seqStart
  if (der[i] !== 0x80) return null
  const [length, start] = readLength(der, i + 1)
  return der.subarray(start, start + length)
}

function readLength(der: Buffer, at: number): [number, number] {
  const first = der[at] as number
  if (first < 0x80) return [first, at + 1]
  const count = first & 0x7f
  let length = 0
  for (let j = 0; j < count; j++) length = length * 256 + (der[at + 1 + j] as number)
  return [length, at + 1 + count]
}
