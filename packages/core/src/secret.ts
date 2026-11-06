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

  /**
   * Runs `use` once per character (Unicode code point), in order, without ever building the whole
   * plaintext as one string, so only single characters reach the V8 heap. For paced typing. Same
   * privilege as reveal(). Throws once disposed, including if disposed between characters.
   */
  async revealEach(use: (character: string) => Promise<void>): Promise<void> {
    const buffer = bytes.get(this)
    if (buffer === undefined) throw new Error('secret already disposed')
    let i = 0
    while (i < buffer.length) {
      if (!bytes.has(this)) throw new Error('secret already disposed')
      const lead = buffer[i] as number
      const length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
      await use(buffer.toString('utf8', i, i + length))
      i += length
    }
  }

  /**
   * An independent copy that outlives this one's dispose(). The runtime keeps one for the length of
   * a run so tool output can still be redacted after the filler has disposed the original.
   */
  clone(): SecretValue {
    const buffer = bytes.get(this)
    if (buffer === undefined) throw new Error('secret already disposed')
    return SecretValue.fromBuffer(Buffer.from(buffer))
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
