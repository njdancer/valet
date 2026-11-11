// The session read cache (D28): answers a tool's repeated read from memory instead of asking the
// site again. Fewer requests is the point; the site sees a slower, quieter visitor.
//
// What may be cached is declared, never guessed: a `read` request declaration with `cacheSeconds`.
// A `write` declaration may name, with `refreshes`, the read its own response answers (a trolley
// update answers with the trolley), and a 2xx JSON response then becomes that read's cached answer.
// Nothing else is kept. An irreversible request is never cached and never fills the cache; the
// manifest schema refuses both.
//
// The cache belongs to one adapter's session and is dropped whenever the session may have changed:
// at any login, at any ensure() that isn't ok, when a call ends any way but ok, at any write (before
// it is sent, so a write that fails halfway leaves nothing stale), and at click() and evaluate(),
// which can change the site out of this wrapper's sight. Answers also expire by their declared time,
// because the person can change the same account from their own browser.
//
// The wrapper sits outside the guarded page, so every request that is sent still passes the guard
// exactly as before. A request answered here is never sent, so it is not counted against the run's
// ceiling and takes no slot of the rate budget. Only a request the guard would let any tool make is
// answered: one that core's decideRequest allows and whose declaration is a read.
//
// Tool code runs in a fresh process per call and keeps nothing between calls; this cache is the one
// thing that outlives a call, and it holds only the site's own answers to declared reads.

import {
  type AdapterManifest,
  decideRequest,
  type FetchInit,
  type FetchResult,
  type ToolPage,
} from '@valet/core'
import type { CallState } from './call-state'
import type { Clock } from './clock'

/** Answers kept per adapter. The oldest goes first. */
export const MAX_CACHE_ENTRIES = 50
/** An answer longer than this, as JSON text, is not kept. */
export const MAX_CACHED_BODY_CHARS = 2_000_000

interface CachedAnswer {
  readonly expiresAt: number
  readonly status: number
  readonly contentType: string | null
  /** The body as JSON text: immutable, and each use gets its own copy. */
  readonly body: string
  /**
   * The session values of the call that stored it. A call answered from here adds them to its own,
   * so output redaction still catches a value the site has since rotated out.
   */
  readonly sessionValues: readonly string[]
}

/** One adapter's cached answers. */
export class ReadCache {
  private readonly answers = new Map<string, CachedAnswer>()
  private generation = 0

  constructor(private readonly clock: Clock) {}

  /** Changes at every clear(), so an answer fetched before a clear isn't stored after it. */
  get epoch(): number {
    return this.generation
  }

  get size(): number {
    return this.answers.size
  }

  get(key: string): CachedAnswer | undefined {
    const answer = this.answers.get(key)
    if (answer === undefined) return undefined
    if (this.clock.now() >= answer.expiresAt) {
      this.answers.delete(key)
      return undefined
    }
    return answer
  }

  set(key: string, answer: CachedAnswer): void {
    this.answers.delete(key)
    this.answers.set(key, answer)
    for (const oldest of this.answers.keys()) {
      if (this.answers.size <= MAX_CACHE_ENTRIES) break
      this.answers.delete(oldest)
    }
  }

  delete(key: string): void {
    this.answers.delete(key)
  }

  clear(): void {
    this.generation++
    this.answers.clear()
  }
}

type ManifestRequest = AdapterManifest['requests'][number]

export interface CachedPageOptions {
  readonly manifest: AdapterManifest
  /** The guarded page: every request that is sent goes through it. */
  readonly inner: ToolPage
  readonly cache: ReadCache
  readonly state: CallState
  readonly clock: Clock
}

/** The tool page handed to tool code: the guarded page, with declared reads answered from the cache. */
export class CachedToolPage implements ToolPage {
  constructor(private readonly options: CachedPageOptions) {}

  goto(url: string): Promise<void> {
    return this.options.inner.goto(url)
  }

  currentUrl(): string {
    return this.options.inner.currentUrl()
  }

  click(selector: string): Promise<void> {
    // A click can submit a form.
    this.options.cache.clear()
    return this.options.inner.click(selector)
  }

  fill(selector: string, text: string): Promise<void> {
    return this.options.inner.fill(selector, text)
  }

  extract(
    selector: string,
    options?: { readonly attribute?: string; readonly all?: boolean },
  ): Promise<unknown> {
    return this.options.inner.extract(selector, options)
  }

  evaluate(source: string, args?: unknown): Promise<unknown> {
    // Adapter code in the page can make the page's own requests.
    this.options.cache.clear()
    return this.options.inner.evaluate(source, args)
  }

  async fetch(pathOrUrl: string, init?: FetchInit): Promise<FetchResult> {
    const { manifest, inner, cache, state } = this.options
    state.assertLive()
    const request = readInit(init)
    const target = typeof pathOrUrl === 'string' ? resolve(pathOrUrl, manifest.home) : null
    if (request === null || target === null) {
      // Nothing this wrapper understands. The guard decides; nothing is assumed about the cache.
      cache.clear()
      return inner.fetch(pathOrUrl, init)
    }
    const decision = decideRequest(request.method, target.href, manifest.egress, manifest.requests)
    // The guard refuses it, and says why.
    if (!decision.allowed) return inner.fetch(pathOrUrl, request.init)
    const declared = manifest.requests.find((r) => r === decision.declaration)
    if (declared === undefined || declared.purpose !== 'read') {
      // Before it is sent: whatever happens to it, the old answers are no longer the site's.
      cache.clear()
      const epoch = cache.epoch
      const result = await inner.fetch(pathOrUrl, request.init)
      const refreshed = refreshedBy(manifest, declared)
      if (refreshed !== null && cache.epoch === epoch) {
        this.store(`GET ${new URL(refreshed.path, manifest.home).href} `, refreshed, result)
      }
      return result
    }
    // Headers can change the answer, so a request that sets any is always sent, and never kept.
    if (declared.cacheSeconds === undefined || request.hasHeaders) {
      return inner.fetch(pathOrUrl, request.init)
    }
    const key = `${request.method} ${target.href} ${request.body}`
    if (!request.reload) {
      const held = cache.get(key)
      if (held !== undefined) {
        for (const value of held.sessionValues) state.sessionValues.add(value)
        return {
          status: held.status,
          contentType: held.contentType,
          body: JSON.parse(held.body) as unknown,
          fromCache: true,
        }
      }
    }
    cache.delete(key)
    const epoch = cache.epoch
    const result = await inner.fetch(pathOrUrl, request.init)
    if (cache.epoch === epoch) this.store(key, declared, result)
    return result
  }

  /** Keeps a 2xx JSON answer for the time `declared` allows. Anything else is not kept. */
  private store(key: string, declared: ManifestRequest, result: FetchResult): void {
    const { cache, state, clock } = this.options
    const seconds = declared.cacheSeconds
    if (seconds === undefined) return
    if (result.status < 200 || result.status > 299) return
    if (!(result.contentType ?? '').toLowerCase().includes('json')) return
    if (result.body === null || typeof result.body !== 'object') return
    let body: string
    try {
      body = JSON.stringify(result.body)
    } catch {
      return
    }
    if (typeof body !== 'string' || body.length > MAX_CACHED_BODY_CHARS) return
    cache.set(key, {
      expiresAt: clock.now() + seconds * 1000,
      status: result.status,
      contentType: result.contentType,
      body,
      sessionValues: [...state.sessionValues],
    })
  }
}

/** The cached read a write's response answers, when its declaration names one. */
function refreshedBy(
  manifest: AdapterManifest,
  declared: ManifestRequest | undefined,
): ManifestRequest | null {
  if (declared === undefined || declared.purpose !== 'write' || declared.refreshes === undefined) return null
  const read = manifest.requests.find((r) => r.method === 'GET' && r.path === declared.refreshes)
  // The schema requires all of this; a hand-built manifest might not have been parsed.
  if (read === undefined || read.purpose !== 'read' || read.cacheSeconds === undefined) return null
  if (read.path.includes('?') || read.path.split('/').some((part) => part.startsWith(':') || part === '*'))
    return null
  return read
}

interface ReadRequest {
  readonly method: string
  /** What the guard is given: a plain copy, read once, without `cache`. */
  readonly init: FetchInit
  readonly hasHeaders: boolean
  /** The JSON body as text, '' for none. */
  readonly body: string
  readonly reload: boolean
}

/**
 * Reads each field of `init` once into a plain copy, so the guard is given exactly what was looked
 * at here. Null when it can't be read; the guard then gets the original and refuses it.
 */
function readInit(init: FetchInit | undefined): ReadRequest | null {
  if (init === undefined) return { method: 'GET', init: {}, hasHeaders: false, body: '', reload: false }
  try {
    if (init === null || typeof init !== 'object') return null
    const method: unknown = init.method
    const rawHeaders: unknown = init.headers
    const rawJson: unknown = init.json
    const reload = init.cache === 'reload'
    if (method !== undefined && typeof method !== 'string') return null
    let headers: Record<string, string> | undefined
    if (rawHeaders !== undefined) {
      if (rawHeaders === null || typeof rawHeaders !== 'object') return null
      headers = {}
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (typeof value === 'string') Object.defineProperty(headers, name, { value, enumerable: true })
      }
    }
    let body = ''
    let json: unknown
    if (rawJson !== undefined) {
      const text: unknown = JSON.stringify(rawJson)
      if (typeof text !== 'string') return null
      body = text
      json = JSON.parse(text)
    }
    return {
      method: (method ?? 'GET').toUpperCase(),
      init: {
        ...(method === undefined ? {} : { method }),
        ...(headers === undefined ? {} : { headers }),
        ...(rawJson === undefined ? {} : { json }),
      },
      hasHeaders: headers !== undefined && Object.keys(headers).length > 0,
      body,
      reload,
    }
  } catch {
    return null
  }
}

function resolve(pathOrUrl: string, home: string): URL | null {
  try {
    return new URL(pathOrUrl, home)
  } catch {
    return null
  }
}
