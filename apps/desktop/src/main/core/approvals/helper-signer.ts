// The MacSigner a packaged app uses: the valet-approver helper in Contents/MacOS
// (swift-bridge/Sources/valet-approver), which holds the Mac's keys in the Secure Enclave and signs
// an approval only after Touch ID. It checks that the payload approves exactly the request it is
// shown and writes the prompt's reason itself, so this side can't put words in front of the
// person's finger. Private keys never leave the helper; only public keys and signatures come back.

import type { KeyObject } from 'node:crypto'
import type { SerializedRequest, SigningDomain } from '@valet/core'
import { nodeSpawner, nodeTimers, runProcess, type Spawner, type Timers } from '@valet/credentials'
import type { ChannelKeys, MacKeys, MacSigner } from './signer'

/** The helper's exit codes (valet-approver/main.swift). */
export const APPROVER_EXIT = {
  ok: 0,
  noKeys: 44,
  cancelled: 50,
  usage: 64,
  unavailable: 69,
  exists: 73,
  refused: 77,
} as const

export class ApproverError extends Error {
  constructor(readonly reason: 'unavailable' | 'refused' | 'failed') {
    super(`approver ${reason}`)
    this.name = 'ApproverError'
  }
}

export interface HelperSignerOptions {
  readonly helperPath: string
  readonly spawner?: Spawner
  readonly timers?: Timers
  /** Long enough for the person to find the Touch ID sensor. */
  readonly promptTimeoutMs?: number
}

const KEYS_TIMEOUT_MS = 20_000
const PROMPT_TIMEOUT_MS = 120_000
const KEY = /^[A-Za-z0-9_-]{1,200}$/
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/
const CHANNEL_TIMEOUT_MS = 20_000

export class HelperSigner implements MacSigner {
  private cached: MacKeys | null = null
  private locked: boolean | null = null

  /**
   * The phone channel's operations, in the helper: relay sign-ins with the transport key, ECDH
   * with the agreement key, and approval-key signatures over the relay binding, the pairing
   * challenge and device records. The helper checks each payload and writes the Touch ID reason
   * itself; the `reason` passed here is never shown.
   */
  readonly channel: ChannelKeys = {
    signTransport: async (payload) => {
      const outcome = await this.run(['sign-transport'], CHANNEL_TIMEOUT_MS, Buffer.from(payload, 'utf8'))
      const signature = outcome.stdout.trim()
      if (outcome.code !== APPROVER_EXIT.ok || !SIGNATURE.test(signature)) throw new ApproverError('failed')
      return signature
    },
    agree: async (peer: KeyObject) => {
      const spki = peer.export({ type: 'spki', format: 'der' }).toString('base64url')
      const outcome = await this.run(['agree'], CHANNEL_TIMEOUT_MS, Buffer.from(spki, 'utf8'))
      const secret = outcome.stdout.trim()
      if (outcome.code !== APPROVER_EXIT.ok || !SECRET.test(secret)) throw new ApproverError('failed')
      return Buffer.from(secret, 'base64url')
    },
    signApproval: async (domain, payload) => (await this.signApprovals(domain, [payload]))?.[0] ?? null,
    signApprovals: (domain, payloads) => this.signApprovals(domain, payloads),
  }

  constructor(private readonly options: HelperSignerOptions) {}

  /** One Touch ID prompt for every payload; null if the person cancelled or the helper refused. */
  private async signApprovals(domain: SigningDomain, payloads: readonly string[]): Promise<string[] | null> {
    const input = Buffer.from(JSON.stringify({ domain, payloads }), 'utf8')
    const outcome = await this.run(
      ['sign-approval'],
      this.options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
      input,
    )
    if (outcome.code !== APPROVER_EXIT.ok) return null
    try {
      const parsed: unknown = JSON.parse(outcome.stdout)
      if (
        Array.isArray(parsed) &&
        parsed.length === payloads.length &&
        parsed.every((s) => typeof s === 'string' && SIGNATURE.test(s))
      )
        return parsed as string[]
    } catch {
      // Not the helper's output.
    }
    return null
  }

  /**
   * The Mac's public keys. Creates them only when the helper says there are none at all: a key
   * that can't be read is an error, never a reason to make a new identity.
   */
  async keys(): Promise<MacKeys> {
    if (this.cached !== null) return this.cached
    let outcome = await this.run(['keys'], KEYS_TIMEOUT_MS)
    if (outcome.code === APPROVER_EXIT.noKeys) outcome = await this.run(['create'], KEYS_TIMEOUT_MS)
    const parsed = this.parseKeys(outcome)
    this.locked = parsed.worksLocked
    this.cached = parsed.keys
    return this.cached
  }

  async worksLocked(): Promise<boolean> {
    if (this.locked === null) await this.keys()
    return this.locked === true
  }

  /** New transport and agreement keys that work while locked; the approval key stays. */
  async rotateChannel(): Promise<MacKeys> {
    const before = await this.keys()
    const { keys, worksLocked } = this.parseKeys(await this.run(['rotate-channel'], KEYS_TIMEOUT_MS))
    // The same identity, or the helper did something else.
    if (keys.approvalKey !== before.approvalKey) throw new ApproverError('failed')
    this.locked = worksLocked
    this.cached = keys
    return keys
  }

  private parseKeys(outcome: { readonly code: number | null; readonly stdout: string }): {
    readonly keys: MacKeys
    readonly worksLocked: boolean
  } {
    if (outcome.code === APPROVER_EXIT.unavailable) throw new ApproverError('unavailable')
    if (outcome.code === APPROVER_EXIT.refused) throw new ApproverError('refused')
    if (outcome.code !== APPROVER_EXIT.ok) throw new ApproverError('failed')
    let parsed: unknown
    try {
      parsed = JSON.parse(outcome.stdout)
    } catch {
      throw new ApproverError('failed')
    }
    const { approvalKey, transportKey, agreementKey, worksLocked } = (parsed ?? {}) as Record<string, unknown>
    if (![approvalKey, transportKey, agreementKey].every((k) => typeof k === 'string' && KEY.test(k))) {
      throw new ApproverError('failed')
    }
    return {
      keys: {
        approvalKey: approvalKey as string,
        transportKey: transportKey as string,
        agreementKey: agreementKey as string,
      },
      // A helper from before keys could work while locked says nothing: they can't.
      worksLocked: worksLocked === true,
    }
  }

  async signDecision(request: SerializedRequest, payload: string): Promise<string | null> {
    const input = Buffer.from(JSON.stringify({ requestText: request.text, payload }), 'utf8')
    const outcome = await this.run(
      ['sign-decision'],
      this.options.promptTimeoutMs ?? PROMPT_TIMEOUT_MS,
      input,
    )
    if (outcome.code !== APPROVER_EXIT.ok) return null
    const signature = outcome.stdout.trim()
    return SIGNATURE.test(signature) ? signature : null
  }

  private async run(
    args: readonly string[],
    timeoutMs: number,
    input?: Buffer,
  ): Promise<{ readonly code: number | null; readonly stdout: string }> {
    const outcome = await runProcess(this.options.spawner ?? nodeSpawner, this.options.helperPath, args, {
      timeoutMs,
      maxStdoutBytes: 4096,
      timers: this.options.timers ?? nodeTimers,
      ...(input === undefined ? {} : { input }),
    })
    if (outcome.kind !== 'exited') return { code: null, stdout: '' }
    return { code: outcome.code, stdout: outcome.stdout.toString('utf8') }
  }
}
