// The decisions scripts/release.mjs makes, kept pure so test/updater/release.test.ts can hold them
// in place on any machine: whether a release may start, which variables it takes, how the signed
// requirement is compared, and the order files go up in. The script itself runs the commands.
//
// Erasable TypeScript only: the script imports this file through tsx, and the tests through Vitest.

/** The feed a dry run compiles in: a public-shaped host nobody publishes to (example.com is IANA's). */
export const DRY_RUN_FEED_URL = 'https://updates.example.com/valet-dry-run/mac/'

/** What a real release needs from the environment, besides what electron-builder.config.ts checks. */
export const REAL_RELEASE_ENV = [
  'VALET_TEAM_ID',
  'VALET_UPDATE_URL',
  'CSC_NAME',
  'APPLE_KEYCHAIN_PROFILE',
  // The 1Password reference to the feed's private key (D61), read with `op read` and Touch ID.
  'VALET_FEED_KEY_REF',
] as const

/** Variables a dry run refuses, so no real identity, notary profile or feed key is within reach. */
export function dryRunRefusedEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined && env[name] !== '')
    .filter(
      (name) =>
        /^(CSC_|APPLE_)/.test(name) ||
        ['VALET_TEAM_ID', 'VALET_FEED_KEY_REF', 'VALET_UPDATE_URL'].includes(name),
    )
    .sort()
}

export interface StartState {
  readonly dryRun: boolean
  /** The version asked for, and the one in apps/desktop/package.json. */
  readonly version: string
  readonly packageVersion: string
  readonly platform: string
  readonly branch: string
  /** `git status --porcelain` printed anything. */
  readonly dirty: boolean
  /** The tag v<version> exists already. */
  readonly tagExists: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  /** Options, each refused outside a dry run. */
  readonly skipCheck: boolean
  readonly allowDirty: boolean
  /** A real release that stops before uploading and tagging. Required until D23 is answered. */
  readonly noPublish: boolean
  /**
   * The full CI suite on the commit being released (fullSuiteVerdict). Pull requests run only the
   * fast suite, so a real release waits for a full run; a dry run doesn't ask.
   */
  readonly fullSuite?: FullSuiteVerdict
}

export interface StartVerdict {
  /** Each one stops the release before anything is built. */
  readonly refusals: string[]
  /** What a dry run would have refused as a release, printed and carried on past. */
  readonly notes: string[]
}

/**
 * Whether a release may start: docs/release-and-updates.md, "The release script". A real release
 * needs a clean tree on main, a new tag, and its signing variables; a dry run takes none of the
 * signing variables, and reports the branch and tag rules instead of stopping on them, so it runs on
 * any CI branch.
 */
export function checkStart(state: StartState): StartVerdict {
  const refusals: string[] = []
  const notes: string[] = []
  if (state.platform !== 'darwin') refusals.push('a release is built on macOS')
  if (state.version !== state.packageVersion) {
    refusals.push(
      `version ${state.version} is not apps/desktop/package.json's (${state.packageVersion}): bump it in a commit first`,
    )
  }
  if (state.dirty && !(state.dryRun && state.allowDirty)) refusals.push('the working tree is not clean')
  if (state.dirty && state.dryRun && state.allowDirty)
    notes.push('the working tree is not clean (--allow-dirty)')
  const branchRule = state.branch === 'main' ? null : `not on main (on ${state.branch || 'a detached HEAD'})`
  const tagRule = state.tagExists ? `the tag v${state.version} exists already` : null
  for (const rule of [branchRule, tagRule]) {
    if (rule === null) continue
    if (state.dryRun) notes.push(rule)
    else refusals.push(rule)
  }
  if (state.dryRun) {
    const refused = dryRunRefusedEnv(state.env)
    if (refused.length > 0) {
      refusals.push(
        `a dry run uses no real identity, notary profile, feed key or feed: unset ${refused.join(', ')}`,
      )
    }
    if (state.noPublish) notes.push('--no-publish: a dry run never publishes anyway')
    if (state.skipCheck) notes.push('pnpm check skipped (--skip-check)')
  } else {
    if (state.skipCheck) refusals.push('--skip-check is for dry runs only: a release runs pnpm check')
    if (state.allowDirty) refusals.push('--allow-dirty is for dry runs only')
    const full = state.fullSuite ?? { passed: false, reason: 'the full suite was not checked' }
    if (!full.passed) refusals.push(`${full.reason}: ${FULL_SUITE_HINT}`)
    const missing = REAL_RELEASE_ENV.filter((name) => (state.env[name] ?? '') === '')
    if (missing.length > 0) refusals.push(`a release needs ${missing.join(', ')}`)
    if (!state.noPublish) {
      refusals.push(
        'publishing waits on the feed host (D23, not answered yet): pass --no-publish to build, sign, notarise and stage the feed without uploading or tagging',
      )
    }
  }
  return { refusals, notes }
}

/** How to get the full suite run on the commit at HEAD, said with each refusal for its lack. */
export const FULL_SUITE_HINT =
  'run the full suite on it (Actions > CI > Run workflow on main, or `gh workflow run ci.yml --ref main`), wait for it to pass, then release again'

/** The repository whose CI runs gate a release. Public, so its runs can be read without a token. */
export const CI_RUNS_URL = 'https://api.github.com/repos/njdancer/valet/actions/workflows/ci.yml/runs'

export interface FullSuiteVerdict {
  readonly passed: boolean
  /** Why not, in words, when it didn't. */
  readonly reason: string
}

/** One workflow run, as GitHub's list of a workflow's runs gives it. */
export interface CiRun {
  readonly head_sha: string
  readonly event: string
  readonly status: string
  readonly conclusion: string | null
}

/**
 * Whether the full suite passed on `sha`: a CI run on that commit that ran the full suite (nightly or
 * started by hand, never a pull request's or a push's fast one) and succeeded. `runs` is GitHub's
 * `workflow_runs` for `?head_sha=<sha>`, or anything else it answered.
 */
export function fullSuiteVerdict(sha: string, runs: unknown): FullSuiteVerdict {
  if (!Array.isArray(runs)) return { passed: false, reason: `GitHub gave no CI runs for ${sha}` }
  const full = (runs as CiRun[]).filter(
    (run) => run.head_sha === sha && (run.event === 'schedule' || run.event === 'workflow_dispatch'),
  )
  if (full.some((run) => run.status === 'completed' && run.conclusion === 'success')) {
    return { passed: true, reason: '' }
  }
  if (full.some((run) => run.status !== 'completed')) {
    return { passed: false, reason: `the full suite is still running on ${sha}` }
  }
  if (full.length > 0) return { passed: false, reason: `the full suite failed on ${sha}` }
  return { passed: false, reason: `the full suite has not run on ${sha}` }
}

/**
 * A designated requirement as text, normalised for comparison: no `designated =>` prefix, no
 * comments, plain tokens unquoted, one space between tokens. codesign -d -r- prints `designated => …` with its own
 * spacing, and the template has comments and line breaks.
 */
export function normaliseRequirement(text: string): string {
  return (
    text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*=?\s*designated\s*=>\s*/, '')
      // codesign prints a plain token unquoted ("ABCDE12345" as ABCDE12345); the template quotes it.
      .replace(/"([A-Za-z0-9._-]+)"/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Two parsed plists (plutil -convert json) as the same value, whatever their key order. */
export function samePlist(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

export interface Upload {
  readonly file: string
  readonly cacheControl: string
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_CACHE = 'no-cache'

/**
 * The upload order: the versioned files (zips, blockmaps, DMGs), never overwritten; then each
 * channel file; then each signed envelope and its signature, last. A client only sees the release
 * once the envelope lands, by which time everything it points at exists, and a client that checks
 * between the yml and the envelope fails closed (the hash doesn't match) and succeeds next time.
 */
export function uploadOrder(files: readonly string[], version: string): Upload[] {
  const versioned = files.filter((f) => f.includes(`-${version}-`) && /\.(zip|zip\.blockmap|dmg)$/.test(f))
  const channels = files.filter((f) => /^(latest|beta)-mac\.yml$/.test(f))
  const envelopes = files.filter((f) => /^(latest|beta)-mac\.envelope\.json(\.sig)?$/.test(f))
  const unknown = files.filter((f) => ![...versioned, ...channels, ...envelopes].includes(f))
  if (unknown.length > 0) throw new Error(`not a release file: ${unknown.join(', ')}`)
  if (channels.length === 0 || envelopes.length !== channels.length * 2) {
    throw new Error('every channel file needs its envelope and signature')
  }
  return [
    ...versioned.sort().map((file) => ({ file, cacheControl: IMMUTABLE })),
    ...channels.sort().map((file) => ({ file, cacheControl: NO_CACHE })),
    // The envelope before its signature: the signature is what makes the pair complete.
    ...envelopes.sort().map((file) => ({ file, cacheControl: NO_CACHE })),
  ]
}

/**
 * The launches the release check makes of the built app, one per row of "Command-line switches"
 * in docs/release-and-updates.md, plus a relative bridge path. Each must exit 64 at once, show no
 * window and write nothing under userData; nothing may answer on `port` afterwards.
 */
export function refusalLaunches(port: number, scratch: string): { name: string; args: string[] }[] {
  return [
    { name: '--remote-debugging-port', args: [`--remote-debugging-port=${port}`] },
    { name: '-remote-debugging-port (one dash)', args: [`-remote-debugging-port=${port}`] },
    { name: '--remote-debugging-pipe', args: ['--remote-debugging-pipe'] },
    { name: '--host-resolver-rules', args: ['--host-resolver-rules=MAP auth.woolworths.com.au 127.0.0.1'] },
    {
      name: '--host-rules with --ignore-certificate-errors',
      args: ['--host-rules=MAP * 127.0.0.1', '--ignore-certificate-errors'],
    },
    { name: '--proxy-server', args: ['--proxy-server=127.0.0.1:9'] },
    { name: '--proxy-pac-url', args: ['--proxy-pac-url=http://127.0.0.1:9/proxy.pac'] },
    { name: '--js-flags', args: ['--js-flags=--no-opt'] },
    { name: '--user-data-dir', args: [`--user-data-dir=${scratch}/attacker-profile`] },
    { name: '--inspect', args: ['--inspect=0'] },
    { name: '--mcp-bridge with a relative path', args: ['--mcp-bridge', 'bridge.json'] },
  ]
}
