// The relay Worker in a local Workers runtime (miniflare), as CI runs it. Builds the bundle once.

import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { deserialize } from 'node:v8'
import { Miniflare } from 'miniflare'
// @ts-expect-error: a plain .mjs build script
import { buildWorker } from '../scripts/build.mjs'

export const RELAY_HOST = 'relay.test'
export const RELAY_ORIGIN = `https://${RELAY_HOST}`

// Under the package: workerd won't load a module from outside its starting directory.
const SCRATCH = fileURLToPath(new URL('../.test-runtime/', import.meta.url))
let built: Promise<string> | null = null

export interface Runtime {
  /** http://127.0.0.1:<port>, where devices connect. */
  readonly url: string
  /** A fetch that reaches the Worker as if from `source` on the internet. */
  fetch(input: string, init?: RequestInit & { source?: string }): Promise<Response>
  /** Everything every Durable Object has stored, by key. */
  stored(): Record<string, unknown>[]
  close(): Promise<void>
}

export async function startRelay(
  options: { limits?: Partial<Record<'CONNECT_LIMIT' | 'FORWARD_LIMIT' | 'SIGN_IN_LIMIT' | 'POLL_LIMIT', number>> } = {},
): Promise<Runtime> {
  mkdirSync(SCRATCH, { recursive: true })
  built ??= buildWorker(join(mkdtempSync(join(SCRATCH, 'build-')), 'worker.js'))
  const scriptPath = await built
  const persist = mkdtempSync(join(SCRATCH, 'do-'))
  const limit = (name: keyof NonNullable<typeof options.limits>, namespace: string) => ({
    namespace_id: namespace,
    simple: { limit: options.limits?.[name] ?? 10_000, period: 60 as const },
  })
  const mf = new Miniflare({
    modules: true,
    scriptPath,
    compatibilityDate: '2026-08-01',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    durableObjects: { MAC_RELAY: 'MacRelay', PUSH: 'PushRelay' },
    durableObjectsPersist: persist,
    bindings: { RELAY_HOST, RELAY_ORIGIN, WAIT_SECRET: 'test-wait-secret' },
    ratelimits: {
      CONNECT_LIMIT: limit('CONNECT_LIMIT', '1'),
      FORWARD_LIMIT: limit('FORWARD_LIMIT', '2'),
      SIGN_IN_LIMIT: limit('SIGN_IN_LIMIT', '3'),
      POLL_LIMIT: limit('POLL_LIMIT', '4'),
    },
    port: 0,
  })
  const url = (await mf.ready).toString().replace(/\/$/, '')
  return {
    url,
    fetch: async (input, init = {}) => {
      const { source = '203.0.113.7', ...rest } = init
      const headers = new Headers(rest.headers)
      headers.set('cf-connecting-ip', source)
      const response = await mf.dispatchFetch(input, { ...rest, headers, redirect: 'manual' } as never)
      return response as unknown as Response
    },
    stored: () => {
      const out: Record<string, unknown>[] = []
      for (const file of walk(persist)) {
        if (!file.endsWith('.sqlite')) continue
        const db = new DatabaseSync(file, { readOnly: true })
        try {
          const rows = db.prepare('SELECT key, value FROM _cf_KV').all() as { key: string; value: Uint8Array }[]
          const entry: Record<string, unknown> = {}
          for (const row of rows) entry[row.key] = deserialize(Buffer.from(row.value))
          if (rows.length > 0) out.push(entry)
        } catch {
          // An object that never stored anything has no table.
        } finally {
          db.close()
        }
      }
      return out
    },
    close: async () => {
      await mf.dispose()
      rmSync(persist, { recursive: true, force: true })
    },
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}
