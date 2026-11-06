// A secret value that resists accidental disclosure: it never stringifies, serialises or inspects
// to its contents, and its bytes are zeroed on dispose. Only the privileged filler reads it.

import { inspect } from 'node:util'

const REDACTED = '[secret]'
const bytes = new WeakMap<SecretValue, Buffer>()

export class SecretValue {
  /** Takes ownership of `buffer`; the caller must not keep a reference to it. */
  static fromBuffer(buffer: Buffer): SecretValue {
    const secret = new SecretValue()
    bytes.set(secret, buffer)
    return secret
  }

  static fromString(value: string): SecretValue {
    return SecretValue.fromBuffer(Buffer.from(value, 'utf8'))
  }

  private constructor() {}

  get disposed(): boolean {
    return !bytes.has(this)
  }

  /**
   * Runs `use` with the plaintext and returns its result. The plaintext must not escape `use`.
   * Throws once disposed.
   */
  reveal<T>(use: (plaintext: string) => T): T {
    const buffer = bytes.get(this)
    if (buffer === undefined) throw new Error('secret already disposed')
    return use(buffer.toString('utf8'))
  }

  /** True when `text` contains this secret. For redaction; never throws once disposed. */
  occursIn(text: string): boolean {
    const buffer = bytes.get(this)
    if (buffer === undefined || buffer.length === 0) return false
    return text.includes(buffer.toString('utf8'))
  }

  dispose(): void {
    const buffer = bytes.get(this)
    if (buffer !== undefined) buffer.fill(0)
    bytes.delete(this)
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return REDACTED
  }
}
