// Strict SemVer 2.0 parsing and precedence, for the updater's own downgrade check. electron-updater
// compares versions too, but it parses loosely ("v1.2.3", "=1.2.3") and lets a channel switch turn
// downgrades back on, so the decision that matters is made here, on a version string we accept only
// in its canonical form. No dependency: `semver` isn't a dependency of this package.

/** Longer than any version we publish; a feed's version is untrusted text and gets shown in the UI. */
export const MAX_VERSION_LENGTH = 64

const NUMERIC = '0|[1-9]\\d*'
const IDENTIFIER = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const VERSION = new RegExp(
  `^(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`,
)

export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Dot-separated prerelease identifiers; empty for a release. */
  readonly prerelease: readonly string[]
}

/** Parses a canonical SemVer 2.0 version, or returns null. Build metadata is accepted and ignored. */
export function parseVersion(text: unknown): Version | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_VERSION_LENGTH) return null
  const match = VERSION.exec(text)
  if (match === null) return null
  const [, major, minor, patch, prerelease] = match
  const numbers = [major, minor, patch].map(Number)
  // Beyond 2^53 the comparison below would silently be wrong.
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null
  return {
    major: numbers[0] as number,
    minor: numbers[1] as number,
    patch: numbers[2] as number,
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b))
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** SemVer precedence: negative if a < b, 0 if equal (build metadata ignored), positive if a > b. */
export function compareVersions(a: Version, b: Version): number {
  const core = Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch)
  if (core !== 0) return core
  // A release outranks any of its prereleases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length)
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const order = compareIdentifiers(x, y)
    if (order !== 0) return order
  }
  return 0
}

/** The canonical text for a parsed version (without build metadata), safe to log and show. */
export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join('.')}`
}
