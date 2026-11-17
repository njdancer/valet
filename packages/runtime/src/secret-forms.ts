// The encoded copies of a secret that output redaction also looks for
// (docs/adapter-kinds.md#f2-secrets-version-2). Tool code chooses what it returns, so a hostile
// adapter that holds a secret (an entrusted one), or a server that echoes one, can hand it back
// encoded rather than as it is. Redaction matches each of these as well as the plain value:
//
// - base64 and base64url, at all three byte alignments, so a secret inside a longer string that
//   was encoded as a whole is still found (the characters that depend on its neighbours are
//   dropped from each end);
// - hex, upper or lower case, and every byte percent-encoded, either case;
// - URL encoding (encodeURIComponent, and form encoding's "+" for spaces);
// - the value reversed, by character;
// - JSON string escaping, and every character as a \uXXXX escape;
// - for a value of several lines (an SSH key), each long line on its own, and the value with its
//   line breaks removed.
//
// It is a backstop, not the boundary: a transform it doesn't list (XOR, a cipher, one character per
// call) is not caught. The boundaries are that a kept secret never reaches adapter code, and that an
// entrusted one reaches only its endpoints under an upload budget (workstreams A and F).

import { SecretValue } from '@valet/core'

/** One form to look for, and whether its case matters. */
export interface SecretForm {
  readonly value: SecretValue
  readonly ignoreCase: boolean
}

/**
 * A base64 core shorter than this is dropped: it is too short to be the secret rather than a
 * coincidence, and would redact ordinary text. The plain value and its other forms are kept.
 */
export const MIN_FORM_LENGTH = 6
/** Each line of a multi-line secret at least this long is matched on its own. */
export const MIN_LINE_LENGTH = 16
const ARMOUR = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/

/**
 * Every encoded form of `secret` other than the secret itself, each a SecretValue the caller owns
 * and disposes. Builds them inside reveal(), so the plaintext doesn't outlive this call except as
 * the forms.
 */
export function encodedForms(secret: SecretValue): SecretForm[] {
  return secret.reveal((plain) => {
    const exact = new Set<string>()
    const caseless = new Set<string>()
    const bytes = Buffer.from(plain, 'utf8')
    try {
      for (const core of base64Cores(bytes)) {
        exact.add(core)
        exact.add(core.replaceAll('+', '-').replaceAll('/', '_'))
      }
      caseless.add(bytes.toString('hex'))
      caseless.add([...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''))
      const uri = encodeURIComponentSafe(plain)
      if (uri !== null) {
        exact.add(uri)
        exact.add(uri.replaceAll('%20', '+'))
      }
      exact.add([...plain].reverse().join(''))
      exact.add(JSON.stringify(plain).slice(1, -1))
      caseless.add(
        [...plain]
          .flatMap((c) => (c.length === 2 ? [c.charCodeAt(0), c.charCodeAt(1)] : [c.charCodeAt(0)]))
          .map((u) => `\\u${u.toString(16).padStart(4, '0')}`)
          .join(''),
      )
      if (/[\r\n]/.test(plain)) {
        for (const line of plain.split(/\r?\n/)) {
          const trimmed = line.trim()
          // PEM armour ("-----BEGIN ... KEY-----") is the same in every key: it is not the secret.
          if (trimmed.length >= MIN_LINE_LENGTH && !ARMOUR.test(trimmed)) exact.add(trimmed)
        }
        const joined = plain.replace(/\s+/g, '')
        if (joined.length >= MIN_LINE_LENGTH) exact.add(joined)
      }
    } finally {
      bytes.fill(0)
    }
    exact.delete(plain)
    exact.delete('')
    caseless.delete('')
    const forms: SecretForm[] = []
    for (const value of exact) forms.push({ value: SecretValue.fromString(value), ignoreCase: false })
    for (const value of caseless) {
      // A caseless form that is the plain value, or another exact form, in some case is still worth
      // matching caselessly; only an exact duplicate is dropped.
      forms.push({ value: SecretValue.fromString(value), ignoreCase: true })
    }
    return forms
  })
}

/**
 * The base64 of `bytes` at each of the three alignments it can have inside a longer encoded
 * string, keeping only the characters every encoding of a string containing it shares.
 */
function base64Cores(bytes: Buffer): string[] {
  const cores: string[] = []
  for (const offset of [0, 1, 2]) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes])
    const encoded = padded.toString('base64')
    padded.fill(0)
    // Characters that mix a prefix byte with the secret: none at offset 0, then 2 and 3.
    const lead = offset === 0 ? 0 : offset + 1
    // Whole groups only: the last partial group depends on whatever follows the secret.
    const end = Math.floor(padded.length / 3) * 4
    const core = encoded.slice(lead, end)
    if (core.length >= MIN_FORM_LENGTH) cores.push(core)
    // A secret encoded on its own ends with its padded last group; match that too.
    if (offset === 0 && encoded.length >= MIN_FORM_LENGTH) cores.push(encoded.replace(/=+$/, ''))
  }
  return cores
}

function encodeURIComponentSafe(value: string): string | null {
  try {
    return encodeURIComponent(value)
  } catch {
    // A lone surrogate can't be encoded, so it can't be sent that way either.
    return null
  }
}
