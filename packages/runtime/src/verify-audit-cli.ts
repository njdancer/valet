// AC14's verifier as a command: `valet-verify-audit [--head <hash>] [path]`. It checks the whole
// hash chain and exits 0 when it holds, 1 at the first bad line (printed), and 2 on bad usage.
// Without a path it checks the release app's log, ~/Library/Application Support/Valet/audit.jsonl.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { type AuditVerification, verifyAuditLog } from './audit-log'
import { isErrno } from './files'

export interface VerifyAuditIo {
  readonly output: Writable
  readonly errors: Writable
  /** The default log's directory; ~/Library/Application Support/Valet unless a test says otherwise. */
  readonly dataDir?: string
  /** What a relative path is relative to; pnpm scripts run in the repo root, so it passes INIT_CWD. */
  readonly cwd?: string
}

export const VERIFY_AUDIT_USAGE = 'usage: valet-verify-audit [--head <sha256 hex>] [audit.jsonl]\n'

/** How much of a bad line to echo; enough to find it, not a whole event dump. */
const SHOWN_LINE_CHARS = 400

const PROBLEMS: Record<Exclude<AuditVerification, { ok: true }>['problem'], string> = {
  malformed: 'not a complete audit record (edited, merged with another line, or cut off)',
  sequence: 'out of sequence (a record was removed or moved)',
  chain: 'does not link to the record before it (a record was removed, moved or replaced)',
  hash: 'its hash does not match its contents (the record was edited)',
  'head-mismatch': 'the log ends before the expected head (records were removed from the end)',
}

/** Verifies one audit log. Resolves to the process exit code. */
export async function main(args: readonly string[], io: VerifyAuditIo): Promise<number> {
  const parsed = parseArgs(args)
  if (parsed === null) {
    io.errors.write(VERIFY_AUDIT_USAGE)
    return 2
  }
  const path =
    parsed.path !== undefined
      ? resolve(io.cwd ?? process.cwd(), parsed.path)
      : join(io.dataDir ?? defaultDataDir(), 'audit.jsonl')
  let result: AuditVerification
  try {
    // A missing file verifies as empty in the library (a fresh install), but asking the CLI to
    // check a file that isn't there is almost always a typo, so say so.
    await readFile(path)
    result = await verifyAuditLog(path, parsed.head === undefined ? {} : { expectedHead: parsed.head })
  } catch (error) {
    io.errors.write(
      `valet-verify-audit: ${path}: ${isErrno(error, 'ENOENT') ? 'no such file' : 'cannot be read'}\n`,
    )
    return 1
  }
  if (result.ok) {
    io.output.write(`ok: ${result.records} record${result.records === 1 ? '' : 's'}, head ${result.head}\n`)
    return 0
  }
  io.errors.write(`FAILED: ${path}: line ${result.line}: ${PROBLEMS[result.problem]}\n`)
  const line = await badLine(path, result.line)
  if (line !== null) io.errors.write(`  ${line}\n`)
  return 1
}

function parseArgs(args: readonly string[]): { path?: string; head?: string } | null {
  let path: string | undefined
  let head: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--head') {
      const value = args[++i]
      if (value === undefined || !/^[0-9a-f]{64}$/.test(value) || head !== undefined) return null
      head = value
    } else if (arg.startsWith('-') || path !== undefined) {
      return null
    } else {
      path = arg
    }
  }
  return { ...(path === undefined ? {} : { path }), ...(head === undefined ? {} : { head }) }
}

function defaultDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Valet')
}

/** The text of 1-based line `n`, shortened, or null past the end of the file. */
async function badLine(path: string, n: number): Promise<string | null> {
  const text = await readFile(path, 'utf8').catch(() => '')
  const line = text.split('\n')[n - 1]
  if (line === undefined || line.length === 0) return null
  return line.length > SHOWN_LINE_CHARS ? `${line.slice(0, SHOWN_LINE_CHARS)}…` : line
}

/* v8 ignore start -- the process entry point; main() is what the tests exercise. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    output: process.stdout,
    errors: process.stderr,
    ...(process.env['INIT_CWD'] === undefined ? {} : { cwd: process.env['INIT_CWD'] }),
  }).then((code) => {
    process.exitCode = code
  })
}
/* v8 ignore stop */
