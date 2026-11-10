// Where the site rate budgets keep the time of their last request between runs of the app. The
// breaker remembers a block across a restart (breaker-state.ts); this remembers the pace. Without
// it a restart straight after a request (an update, or the restart after a crash) could put two
// requests to a site closer together than its gap.
//
// The file is read once. A file that can't be read or doesn't parse fails slow: the caller makes
// every site wait one full gap, rather than guessing that nothing was sent just before.

import { z } from 'zod'

/** When each host's last request was let through, in ms since the epoch. */
export type BudgetTimes = ReadonlyMap<string, number>

/** An entry this old says nothing a gap could still depend on, and is dropped. */
export const BUDGET_MEMORY_MS = 24 * 60 * 60_000

const fileSchema = z
  .object({
    version: z.literal(1),
    hosts: z.record(
      z.string().regex(/^[a-z0-9.-]{1,253}$/),
      z.object({ lastRequestAt: z.number().int().nonnegative() }).strict(),
    ),
  })
  .strict()

/** Parses the stored text. Returns null for anything that isn't exactly the expected shape. */
export function parseBudgetFile(text: string): Map<string, number> | null {
  let parsed: z.infer<typeof fileSchema>
  try {
    parsed = fileSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
  // Object.entries reads own properties only, so a "__proto__" key is just a host name here.
  return new Map(Object.entries(parsed.hosts).map(([host, entry]) => [host, entry.lastRequestAt]))
}

export function serialiseBudgetFile(times: BudgetTimes): string {
  const hosts: Record<string, { lastRequestAt: number }> = {}
  for (const [host, lastRequestAt] of [...times].sort(([a], [b]) => a.localeCompare(b))) {
    Object.defineProperty(hosts, host, { value: { lastRequestAt }, enumerable: true })
  }
  return `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`
}
