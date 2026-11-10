// How long run artefacts are kept (D27): traces and screenshots under one folder, removed once older
// than the person's setting (14 days by default). The audit log is never pruned; it rotates instead
// (audit-log.ts).

import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isErrno } from './files'

export const DEFAULT_TRACE_RETENTION_DAYS = 14
export const MIN_TRACE_RETENTION_DAYS = 1
export const MAX_TRACE_RETENTION_DAYS = 365

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Removes every entry directly under `dir` (a file, or a run's folder with everything in it) last
 * modified more than `days` days before `now`. A symbolic link is removed itself, never followed.
 * A missing folder has nothing to prune. Resolves to the names removed.
 */
export async function pruneOlderThan(dir: string, days: number, now: number): Promise<string[]> {
  if (!Number.isInteger(days) || days < MIN_TRACE_RETENTION_DAYS || days > MAX_TRACE_RETENTION_DAYS) {
    throw new RangeError(`retention is ${MIN_TRACE_RETENTION_DAYS} to ${MAX_TRACE_RETENTION_DAYS} days`)
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return []
    throw error
  }
  const cutoff = now - days * DAY_MS
  const removed: string[] = []
  for (const name of names.sort()) {
    const path = join(dir, name)
    const info = await lstat(path).catch(() => null)
    if (info === null || info.mtimeMs >= cutoff) continue
    await rm(path, { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}
