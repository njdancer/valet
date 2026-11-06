// Where the site circuit breakers keep their state between runs of the app. A restart straight after
// a block must not hit the site again, so each host's retry time and current cooldown are written to
// a small JSON file whenever they change.
//
// The file is read once. A file that can't be read or doesn't parse fails closed: the caller treats
// every host as blocked for its base cooldown rather than guessing that nothing was blocked.

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { isErrno, writeFileAtomic } from './files'

/** Text storage for one JSON document. Injected so tests never touch the disk. */
export interface JsonStore {
  /** The stored text, or null when nothing has been stored yet. Throws when it can't be read. */
  read(): Promise<string | null>
  /** Replaces the stored text. */
  write(text: string): Promise<void>
}

/** A JsonStore backed by one file, replaced atomically on every write. */
export class JsonFileStore implements JsonStore {
  constructor(private readonly path: string) {}

  async read(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    }
  }

  write(text: string): Promise<void> {
    return writeFileAtomic(this.path, text)
  }
}

export interface BreakerState {
  /** When calls to the host may resume, in ms since the epoch. */
  readonly retryAt: number
  /** The cooldown the last block in a row applied, so the next one doubles it; 0 when none. */
  readonly cooldownMs: number
}

const MAX_MS = 7 * 24 * 60 * 60_000

const fileSchema = z
  .object({
    version: z.literal(1),
    hosts: z.record(
      z.string().regex(/^[a-z0-9.-]{1,253}$/),
      z
        .object({
          retryAt: z.number().int().nonnegative(),
          cooldownMs: z.number().int().min(0).max(MAX_MS),
        })
        .strict(),
    ),
  })
  .strict()

/** Parses the stored text. Returns null for anything that isn't exactly the expected shape. */
export function parseBreakerFile(text: string): Map<string, BreakerState> | null {
  let parsed: z.infer<typeof fileSchema>
  try {
    parsed = fileSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
  // Object.entries reads own properties only, so a "__proto__" key is just a host name here.
  return new Map(Object.entries(parsed.hosts))
}

export function serialiseBreakerFile(states: ReadonlyMap<string, BreakerState>): string {
  const hosts: Record<string, BreakerState> = {}
  for (const [host, state] of [...states].sort(([a], [b]) => a.localeCompare(b))) {
    Object.defineProperty(hosts, host, { value: state, enumerable: true })
  }
  return `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`
}
