// Resolves secrets with `op read` through the 1Password desktop app's CLI integration. The secret is
// only ever read from stdout into a Buffer; it never appears in argv, a string or an error.

import { CredentialError, type CredentialProvider, type SecretField, SecretValue } from '@siteadapter/core'
import { parseItemRef, secretReference } from './item-ref'
import { isExecutableFile, locateExecutable } from './locate'
import { nodeSpawner, nodeTimers, runProcess, type Spawner, type Timers } from './process'

/**
 * Where op is looked for before PATH: Homebrew on Apple silicon, then Homebrew on Intel, which is
 * also where 1Password's own installer puts it. An app started from Finder has a minimal PATH that
 * holds neither.
 */
export const DEFAULT_OP_PATHS: readonly string[] = ['/opt/homebrew/bin/op', '/usr/local/bin/op']

export interface OnePasswordCliOptions {
  /** Absolute paths tried in order before PATH. Relative ones are ignored. */
  readonly opPaths?: readonly string[]
  /** Searched for op after opPaths, absolute entries only. Defaults to this process's PATH; null skips it. */
  readonly searchPath?: string | null
  /** True when an executable regular file is at an absolute path. Injected so tests never look at disk. */
  readonly isExecutable?: (path: string) => Promise<boolean>
  readonly spawner?: Spawner
  readonly timers?: Timers
  /** Long enough for the person to answer a Touch ID prompt. */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000

// op's wording varies between versions, so these match phrases rather than whole messages.
const LOCKED =
  /\bnot (currently )?signed in\b|\bsigned out\b|\bsession (has )?expired\b|\bdismissed\b|\blocked\b|\bunlock|\bauthorization (timeout|timed out|denied|declined)|\btimed out\b|\btimeout\b|\bconnecting to (the )?desktop app\b|\bbiometric|\btouch id\b/
const FIELD_MISSING =
  /\b(no|isn't a|is not a|could not find|cannot find|doesn't have a|does not have a|no matching)\s+(\S+\s+)?(field|section)\b|\b(field|section)\b[^.]*\b(not found|does not exist|doesn't exist|cannot be found)/
const NOT_FOUND =
  /\b(isn't|is not) an? (vault|item)\b|\b(no|could not find|cannot find)\s+(\S+\s+)?(vault|item)\b|\b(vault|item)\b[^.]*\b(not found|does not exist|doesn't exist)|\bmore than one (vault|item)\b/
// A password or code is short; anything bigger is not what we asked for.
const MAX_SECRET_BYTES = 64 * 1024

export class OnePasswordCliProvider implements CredentialProvider {
  readonly kind = 'onepassword-cli' as const
  readonly #opPaths: readonly string[]
  readonly #searchPath: string | null
  readonly #isExecutable: (path: string) => Promise<boolean>
  readonly #spawner: Spawner
  readonly #timers: Timers
  readonly #timeoutMs: number
  // Found once and kept, until a run reports it gone.
  #opPath: string | null = null

  constructor(options: OnePasswordCliOptions = {}) {
    this.#opPaths = options.opPaths ?? DEFAULT_OP_PATHS
    this.#searchPath = options.searchPath === undefined ? (process.env['PATH'] ?? null) : options.searchPath
    this.#isExecutable = options.isExecutable ?? isExecutableFile
    this.#spawner = options.spawner ?? nodeSpawner
    this.#timers = options.timers ?? nodeTimers
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async resolve(itemRef: string, field: SecretField): Promise<SecretValue> {
    const ref = parseItemRef(itemRef)
    if (ref === null) throw new CredentialError('not-found')
    const reference = secretReference(ref, field, 'otp')
    const opPath = await this.#locate()
    if (opPath === null) throw new CredentialError('unavailable')
    const outcome = await runProcess(this.#spawner, opPath, ['read', '--no-newline', reference], {
      timeoutMs: this.#timeoutMs,
      maxStdoutBytes: MAX_SECRET_BYTES,
      timers: this.#timers,
    })
    switch (outcome.kind) {
      case 'missing':
        // Removed since it was found; look again next time.
        this.#opPath = null
        throw new CredentialError('unavailable')
      case 'timed-out':
        // Most likely an unanswered Touch ID or unlock prompt.
        throw new CredentialError('locked')
      case 'failed':
        throw new CredentialError('unavailable')
      case 'exited':
        if (outcome.code !== 0) {
          outcome.stdout.fill(0)
          throw new CredentialError(classifyOpFailure(outcome.stderr, reference))
        }
        if (outcome.stdout.length === 0) throw new CredentialError('field-missing')
        return SecretValue.fromBuffer(outcome.stdout)
    }
  }

  async #locate(): Promise<string | null> {
    this.#opPath ??= await locateExecutable('op', this.#opPaths, this.#searchPath, this.#isExecutable)
    return this.#opPath
  }
}

/**
 * Maps op's stderr to a failure. Quoted text and the reference itself are removed first: they hold
 * vault, item and field names the person chose, which must not steer the classification.
 */
export function classifyOpFailure(stderr: string, reference: string): CredentialError['failure'] {
  const text = stderr
    .split(reference)
    .join(' ')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' ')
    .toLowerCase()
  if (LOCKED.test(text)) return 'locked'
  if (FIELD_MISSING.test(text)) return 'field-missing'
  if (NOT_FOUND.test(text)) return 'not-found'
  return 'unavailable'
}
