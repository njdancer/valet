// Reads a token (the 1Password service-account token) from the macOS Keychain with the `security`
// tool. The wait is bounded: a hung Keychain approval prompt once froze the earlier app's main process for
// hours, so an unanswered prompt is reported as locked instead.
//
// v0 only. The Keychain checks its ACL against the calling binary, which here is /usr/bin/security,
// not the signed app, so the item's designated requirement protects nothing yet, and "Always Allow"
// would let any process read the token. See "The service-account token" in docs/security-model.md;
// the replacement reads in process through SecItemCopyMatching behind the same TokenSource.

import { CredentialError, SecretValue, type TokenSource } from '@siteadapter/core'
import { nodeSpawner, nodeTimers, runProcess, type Spawner, type Timers } from './process'

export interface KeychainTokenOptions {
  readonly service: string
  readonly account: string
  /** Absolute by default so a planted `security` earlier on PATH is never run. */
  readonly securityPath?: string
  readonly spawner?: Spawner
  readonly timers?: Timers
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TOKEN_BYTES = 16 * 1024
// errSecItemNotFound, as the security tool's exit status.
const EXIT_ITEM_NOT_FOUND = 44
const LOCKED = /\bcancel|\bdenied\b|\binteraction is not allowed\b|\bauthori[sz]ation\b|\blocked\b/i
const NOT_FOUND = /\bcould not be found\b/i

/** Hands out the token from the Keychain on each call. The caller disposes each value it gets. */
export class KeychainTokenSource implements TokenSource {
  readonly #options: Required<KeychainTokenOptions>

  constructor(options: KeychainTokenOptions) {
    this.#options = {
      service: options.service,
      account: options.account,
      securityPath: options.securityPath ?? '/usr/bin/security',
      spawner: options.spawner ?? nodeSpawner,
      timers: options.timers ?? nodeTimers,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
  }

  async token(): Promise<SecretValue> {
    const { service, account, securityPath, spawner, timers, timeoutMs } = this.#options
    const outcome = await runProcess(
      spawner,
      securityPath,
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeoutMs, maxStdoutBytes: MAX_TOKEN_BYTES, timers },
    )
    switch (outcome.kind) {
      case 'timed-out':
        throw new CredentialError('locked')
      case 'missing':
      case 'failed':
        throw new CredentialError('unavailable')
      case 'exited': {
        if (outcome.code !== 0) {
          outcome.stdout.fill(0)
          if (outcome.code === EXIT_ITEM_NOT_FOUND || NOT_FOUND.test(outcome.stderr)) {
            throw new CredentialError('not-found')
          }
          if (LOCKED.test(outcome.stderr)) throw new CredentialError('locked')
          throw new CredentialError('unavailable')
        }
        const token = withoutTrailingNewline(outcome.stdout)
        if (token.length === 0) throw new CredentialError('not-found')
        return SecretValue.fromBuffer(token)
      }
    }
  }
}

/** `security -w` ends its output with one newline. Copies the rest out and zeroes the original. */
function withoutTrailingNewline(output: Buffer): Buffer {
  const end = output.length > 0 && output[output.length - 1] === 0x0a ? output.length - 1 : output.length
  const copy = Buffer.alloc(end)
  output.copy(copy, 0, 0, end)
  output.fill(0)
  return copy
}
