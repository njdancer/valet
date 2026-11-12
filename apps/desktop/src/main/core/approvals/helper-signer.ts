// The MacSigner a packaged app uses: the valet-approver helper in Contents/MacOS
// (swift-bridge/Sources/valet-approver), which holds the Mac's keys in the Secure Enclave and signs
// an approval only after Touch ID. It checks that the payload approves exactly the request it is
// shown and writes the prompt's reason itself, so this side can't put words in front of the
// person's finger. Private keys never leave the helper; only public keys and signatures come back.

import type { SerializedRequest } from '@valet/core'
import { nodeSpawner, nodeTimers, runProcess, type Spawner, type Timers } from '@valet/credentials'
import type { MacKeys, MacSigner } from './signer'

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

export class HelperSigner implements MacSigner {
  private cached: MacKeys | null = null

  constructor(private readonly options: HelperSignerOptions) {}

  /**
   * The Mac's public keys. Creates them only when the helper says there are none at all: a key
   * that can't be read is an error, never a reason to make a new identity.
   */
  async keys(): Promise<MacKeys> {
    if (this.cached !== null) return this.cached
    let outcome = await this.run(['keys'], KEYS_TIMEOUT_MS)
    if (outcome.code === APPROVER_EXIT.noKeys) outcome = await this.run(['create'], KEYS_TIMEOUT_MS)
    if (outcome.code === APPROVER_EXIT.unavailable) throw new ApproverError('unavailable')
    if (outcome.code === APPROVER_EXIT.refused) throw new ApproverError('refused')
    if (outcome.code !== APPROVER_EXIT.ok) throw new ApproverError('failed')
    let parsed: unknown
    try {
      parsed = JSON.parse(outcome.stdout)
    } catch {
      throw new ApproverError('failed')
    }
    const { approvalKey, transportKey, agreementKey } = (parsed ?? {}) as Record<string, unknown>
    if (![approvalKey, transportKey, agreementKey].every((k) => typeof k === 'string' && KEY.test(k))) {
      throw new ApproverError('failed')
    }
    this.cached = {
      approvalKey: approvalKey as string,
      transportKey: transportKey as string,
      agreementKey: agreementKey as string,
    }
    return this.cached
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
