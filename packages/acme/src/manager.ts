// Keeps one certificate for this Mac's public name: gets it the first time the relay connection is
// up, renews it when ACME Renewal Info says (any time in the window the CA suggests, which is
// exempt from rate limits), and waits, saying so, when the CA's weekly limit for the domain is
// reached. Its keys are stored by the app (Keychain, after first unlock), never sent anywhere.

import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { createSecureContext, type SecureContext } from 'node:tls'
import { AcmeClient, AcmeError, ariCertId } from './client'
import { generateP256, type KeyPair, privateKeyPem, selfSignedCertificate, toPem } from './x509'

export interface StoredCertificate {
  readonly name: string
  readonly directoryUrl: string
  readonly accountKeyPem: string
  readonly accountUrl: string | null
  readonly certificateKeyPem: string
  /** The chain, leaf first. */
  readonly certificatePem: string | null
}

export interface CertificateStore {
  load(): Promise<StoredCertificate | null>
  save(state: StoredCertificate): Promise<void>
}

export type CertificateStatus =
  /** Waiting for the relay connection: the CA must reach this Mac to check the name. */
  | { readonly state: 'waiting-for-relay' }
  | { readonly state: 'issuing' }
  | { readonly state: 'ready'; readonly notAfter: Date; readonly renewAt: Date | null }
  /**
   * No certificate yet (or an expired one), and the CA said to come back later: its weekly limit
   * for the domain, usually. The app says remote access is being set up.
   */
  | { readonly state: 'queued'; readonly until: Date; readonly reason: 'rate-limited' | 'failed' }
  | { readonly state: 'stopped' }

export interface CertificateManagerOptions {
  readonly name: string
  readonly directoryUrl: string
  readonly store: CertificateStore
  /** True while the relay connection is up, so the CA can reach the name. */
  readonly reachable: () => boolean
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly random?: () => number
  readonly onStatus?: (status: CertificateStatus) => void
  readonly log?: (line: string) => void
  /** For tests: how often the CA is polled during an order. */
  readonly pollMs?: number
  /** The least time between tries, whatever the CA says. A minute unless a test says. */
  readonly minRetryMs?: number
  /** Without ARI: renew when this share of the lifetime is left. */
  readonly renewAtRemaining?: number
}

const HOUR = 3600_000
const MAX_BACKOFF = 6 * HOUR

export class CertificateManager {
  private state: StoredCertificate | null = null
  private context: SecureContext | null = null
  private notAfter: Date | null = null
  private readonly challenges = new Map<string, SecureContext>()
  private current: CertificateStatus = { state: 'stopped' }
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private busy = false
  private failures = 0
  private renewAt: Date | null = null
  private readonly now: () => number

  constructor(private readonly options: CertificateManagerOptions) {
    this.now = options.now ?? Date.now
  }

  get status(): CertificateStatus {
    return this.current
  }

  /** The certificate for TLS, or null when there is none that is still valid. */
  certificate(): SecureContext | null {
    if (this.notAfter === null || this.notAfter.getTime() <= this.now()) return null
    return this.context
  }

  /** The TLS-ALPN-01 answer for a name being validated now. */
  challenge(name: string): SecureContext | null {
    return this.challenges.get(name.toLowerCase()) ?? null
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    const loaded = await this.options.store.load()
    if (
      loaded !== null &&
      loaded.name === this.options.name &&
      loaded.directoryUrl === this.options.directoryUrl
    ) {
      this.state = loaded
      if (loaded.certificatePem !== null) this.use(loaded.certificatePem, loaded.certificateKeyPem)
    }
    void this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.setStatus({ state: 'stopped' })
  }

  /** The relay connection came up: try now if waiting for it. */
  kick(): void {
    if (!this.running || this.busy) return
    if (this.current.state === 'waiting-for-relay') void this.tick()
  }

  /** Checks now whether to get or renew the certificate (after the Mac wakes, say). */
  async checkNow(): Promise<void> {
    await this.tick()
  }

  private async tick(): Promise<void> {
    if (!this.running || this.busy) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.busy = true
    try {
      await this.step()
    } catch (error) {
      // The store or a key failed, not the CA: try again later rather than stop for good.
      this.options.log?.(`[certificate] ${error instanceof Error ? error.message.slice(0, 200) : 'error'}`)
      this.later(15 * 60_000)
    } finally {
      this.busy = false
    }
  }

  private async step(): Promise<void> {
    const state = await this.ensureKeys()
    const client = this.client(state)
    const valid = this.certificate() !== null
    if (valid && state.certificatePem !== null) {
      const due = await this.renewalDue(client, state.certificatePem)
      if (due.at > this.now()) {
        this.renewAt = new Date(due.at)
        this.ready()
        return this.later(Math.min(due.at, due.checkAgainAt) - this.now())
      }
    }
    if (!this.options.reachable()) {
      if (!valid) this.setStatus({ state: 'waiting-for-relay' })
      // Renewal can wait for kick(); a check now and then in case it was missed.
      return this.later(HOUR)
    }
    if (!valid) this.setStatus({ state: 'issuing' })
    try {
      const certificateKey = generateP256()
      const replaces =
        valid && state.certificatePem !== null
          ? ariCertId(new X509Certificate(state.certificatePem))
          : undefined
      const issued = await client.issue({
        name: this.options.name,
        certificateKey,
        present: (name, keyAuthorization) => {
          const keys = generateP256()
          const der = selfSignedCertificate(keys, { names: [name], acmeKeyAuthorization: keyAuthorization })
          this.challenges.set(
            name.toLowerCase(),
            createSecureContext({ key: privateKeyPem(keys), cert: toPem(der, 'CERTIFICATE') }),
          )
        },
        clear: (name) => {
          this.challenges.delete(name.toLowerCase())
        },
        ...(replaces === undefined ? {} : { replaces }),
      })
      const next: StoredCertificate = {
        ...state,
        accountUrl: client.accountUrl,
        certificateKeyPem: privateKeyPem(certificateKey),
        certificatePem: issued.pem,
      }
      await this.options.store.save(next)
      this.state = next
      this.use(issued.pem, next.certificateKeyPem)
      this.failures = 0
      this.renewAt = null
      this.options.log?.(
        `[certificate] issued for ${this.options.name}, valid until ${issued.notAfter.toISOString()}`,
      )
      return this.later(0)
    } catch (error) {
      this.failures++
      const rateLimited = error instanceof AcmeError && error.rateLimited
      const backoff = Math.min(MAX_BACKOFF, 60_000 * 2 ** Math.min(this.failures, 10))
      const until =
        error instanceof AcmeError && error.retryAfter !== null
          ? Math.max(error.retryAfter.getTime(), this.now() + (this.options.minRetryMs ?? 60_000))
          : this.now() + (rateLimited ? HOUR : backoff)
      this.options.log?.(
        `[certificate] ${rateLimited ? 'rate limited' : 'failed'}: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}`,
      )
      if (this.certificate() === null)
        this.setStatus({
          state: 'queued',
          until: new Date(until),
          reason: rateLimited ? 'rate-limited' : 'failed',
        })
      else this.ready()
      return this.later(until - this.now())
    }
  }

  /** When to renew: a random time in the ARI window, else when a third of the lifetime is left. */
  private async renewalDue(client: AcmeClient, pem: string): Promise<{ at: number; checkAgainAt: number }> {
    const cert = new X509Certificate(pem)
    const from = Date.parse(cert.validFrom)
    const to = Date.parse(cert.validTo)
    const fallback = to - (to - from) * (this.options.renewAtRemaining ?? 1 / 3)
    try {
      const window = await client.renewalWindow(ariCertId(cert))
      if (window !== null) {
        const random = this.options.random ?? Math.random
        const start = window.start.getTime()
        const end = window.end.getTime()
        // The same point in the window on every check, so polling doesn't keep moving it.
        const at =
          this.renewAt !== null && this.renewAt.getTime() >= start && this.renewAt.getTime() <= end
            ? this.renewAt.getTime()
            : start + random() * (end - start)
        return { at, checkAgainAt: window.checkAgainAt.getTime() }
      }
    } catch {
      // ARI down: the lifetime rule, checked again in a few hours.
    }
    return { at: fallback, checkAgainAt: this.now() + 6 * HOUR }
  }

  private async ensureKeys(): Promise<StoredCertificate> {
    if (this.state !== null) return this.state
    const account = generateP256()
    const certificate = generateP256()
    const state: StoredCertificate = {
      name: this.options.name,
      directoryUrl: this.options.directoryUrl,
      accountKeyPem: privateKeyPem(account),
      accountUrl: null,
      certificateKeyPem: privateKeyPem(certificate),
      certificatePem: null,
    }
    await this.options.store.save(state)
    this.state = state
    return state
  }

  private client(state: StoredCertificate): AcmeClient {
    return new AcmeClient({
      directoryUrl: state.directoryUrl,
      accountKey: keyPairFromPem(state.accountKeyPem),
      ...(state.accountUrl === null ? {} : { accountUrl: state.accountUrl }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.pollMs === undefined ? {} : { pollMs: this.options.pollMs }),
      now: this.now,
    })
  }

  private use(pem: string, keyPem: string): void {
    try {
      const cert = new X509Certificate(pem)
      this.context = createSecureContext({ key: keyPem, cert: pem })
      this.notAfter = new Date(cert.validTo)
    } catch {
      this.context = null
      this.notAfter = null
    }
  }

  private ready(): void {
    if (this.notAfter === null) return
    this.setStatus({ state: 'ready', notAfter: this.notAfter, renewAt: this.renewAt })
  }

  private later(ms: number): void {
    if (!this.running) return
    // setTimeout holds 24.8 days at most; a check every day is plenty.
    this.timer = setTimeout(() => void this.tick(), Math.max(0, Math.min(ms, 24 * HOUR)))
    this.timer.unref?.()
  }

  private setStatus(status: CertificateStatus): void {
    this.current = status
    try {
      this.options.onStatus?.(status)
    } catch {
      // Not ours to fail.
    }
  }
}

function keyPairFromPem(pem: string): KeyPair {
  const privateKey = createPrivateKey(pem)
  return { privateKey, publicKey: createPublicKey(privateKey) }
}
