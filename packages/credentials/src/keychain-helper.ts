// Valet's own Keychain items, through the valet-keychain helper that ships in the app's
// Contents/MacOS (swift-bridge/Sources/valet-keychain). The helper reads with SecItemCopyMatching in
// its own process, so the Keychain's ACL names a binary signed with Valet's Team ID, not
// /usr/bin/security: an item the helper wrote is read back without a prompt, which is what makes
// unattended logins possible (D6). A signed helper answers only a parent signed by the same team.
//
// Secrets go in on stdin and come back on stdout, never in argv. Every wait is bounded, as with
// `security`: an unanswered Keychain prompt is reported as locked.

import { CredentialError, SecretValue, type TokenSource } from '@valet/core'
import {
  nodeSpawner,
  nodeTimers,
  type ProcessOutcome,
  runProcess,
  type Spawner,
  type Timers,
} from './process'

export interface KeychainHelperOptions {
  /** The helper's absolute path: the app's Contents/MacOS/valet-keychain. */
  readonly helperPath: string
  readonly spawner?: Spawner
  readonly timers?: Timers
  readonly timeoutMs?: number
}

/** What the helper's exit codes mean (swift-bridge/Sources/valet-keychain/main.swift). */
export const KEYCHAIN_EXIT = { ok: 0, notFound: 44, interaction: 51, usage: 64, refused: 77 } as const

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_SECRET_BYTES = 16 * 1024
const MAX_COMMENT_BYTES = 2 * 1024
// The helper's own rules (Keychain.swift): valet or valet.<name>, and a printable account.
const SERVICE = /^valet(\.[a-z0-9-]{1,32}){0,3}$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function isKeychainService(service: string): boolean {
  return SERVICE.test(service)
}

function checkItem(service: string, account: string): void {
  const bytes = Buffer.byteLength(account, 'utf8')
  if (!isKeychainService(service) || bytes === 0 || bytes > 512 || CONTROL.test(account)) {
    throw new CredentialError('not-found')
  }
}

export class KeychainHelper {
  readonly #options: Required<KeychainHelperOptions>

  constructor(options: KeychainHelperOptions) {
    this.#options = {
      helperPath: options.helperPath,
      spawner: options.spawner ?? nodeSpawner,
      timers: options.timers ?? nodeTimers,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }
  }

  /** The item's secret, exactly as stored. The caller disposes it. */
  async read(service: string, account: string): Promise<SecretValue> {
    checkItem(service, account)
    const outcome = await this.#run(['read', service, account], MAX_SECRET_BYTES)
    const stdout = succeeded(outcome)
    if (stdout.length === 0) throw new CredentialError('not-found')
    return SecretValue.fromBuffer(stdout)
  }

  /** The item's comment, or null when there is no such item. Never reads the secret. */
  async info(service: string, account: string): Promise<string | null> {
    checkItem(service, account)
    const outcome = await this.#run(['info', service, account], MAX_COMMENT_BYTES)
    if (outcome.kind === 'exited' && outcome.code === KEYCHAIN_EXIT.notFound) return null
    const stdout = succeeded(outcome)
    const comment = stdout.toString('utf8')
    stdout.fill(0)
    return comment
  }

  /**
   * Stores `secret` (taking ownership and zeroing it when done) with a comment, which must not be
   * secret: the helper reads it from argv and shows it to anyone who lists the item.
   */
  async write(service: string, account: string, secret: Buffer, comment: string): Promise<void> {
    try {
      checkItem(service, account)
      if (
        secret.length === 0 ||
        secret.length > MAX_SECRET_BYTES ||
        Buffer.byteLength(comment, 'utf8') > MAX_COMMENT_BYTES ||
        CONTROL.test(comment)
      ) {
        throw new CredentialError('unavailable')
      }
      const outcome = await this.#run(['write', service, account, comment], 1024, secret)
      succeeded(outcome).fill(0)
    } finally {
      secret.fill(0)
    }
  }

  /** Removes the item. One that isn't there is not an error. */
  async delete(service: string, account: string): Promise<void> {
    checkItem(service, account)
    const outcome = await this.#run(['delete', service, account], 1024)
    if (outcome.kind === 'exited' && outcome.code === KEYCHAIN_EXIT.notFound) return
    succeeded(outcome).fill(0)
  }

  /**
   * Removes every item of one of Valet's services, whatever its account, for an uninstall or a
   * reset: it doesn't depend on the app still knowing what it stored. Nothing there is not an error.
   */
  async purge(service: string): Promise<void> {
    if (!isKeychainService(service)) throw new CredentialError('not-found')
    const outcome = await this.#run(['purge', service], 1024)
    if (outcome.kind === 'exited' && outcome.code === KEYCHAIN_EXIT.notFound) return
    succeeded(outcome).fill(0)
  }

  #run(args: readonly string[], maxStdoutBytes: number, input?: Buffer): Promise<ProcessOutcome> {
    const { helperPath, spawner, timers, timeoutMs } = this.#options
    return runProcess(spawner, helperPath, args, {
      timeoutMs,
      maxStdoutBytes,
      timers,
      ...(input === undefined ? {} : { input }),
    })
  }
}

/** stdout of a run that exited 0, or the failure its exit code stands for. */
function succeeded(outcome: ProcessOutcome): Buffer {
  switch (outcome.kind) {
    case 'timed-out':
      throw new CredentialError('locked')
    case 'missing':
    case 'failed':
      throw new CredentialError('unavailable')
    case 'exited':
      if (outcome.code === KEYCHAIN_EXIT.ok) return outcome.stdout
      outcome.stdout.fill(0)
      if (outcome.code === KEYCHAIN_EXIT.notFound) throw new CredentialError('not-found')
      if (outcome.code === KEYCHAIN_EXIT.interaction) throw new CredentialError('locked')
      throw new CredentialError('unavailable')
  }
}

/** The service-account token, read through the helper instead of /usr/bin/security. */
export class HelperKeychainTokenSource implements TokenSource {
  readonly #helper: KeychainHelper
  readonly #service: string
  readonly #account: string

  constructor(helper: KeychainHelper, service: string, account: string) {
    this.#helper = helper
    this.#service = service
    this.#account = account
  }

  token(): Promise<SecretValue> {
    return this.#helper.read(this.#service, this.#account)
  }
}
