// Fakes for the runtime's injected effects. They record what they were asked to do so tests can
// assert on it, and never touch a real browser, file or clock.

import {
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  type BlockedRequest,
  type FetchInit,
  type FetchResult,
  type NeedsUserReason,
  type SessionDriver,
  SiteAdapterError,
  type ToolPage,
  type ToolRunPolicy,
} from '@siteadapter/core'
import type { JsonStore } from '../src/breaker-state'
import type { LoginMarkerState, LoginMarkerStore } from '../src/login-marker'
import type { ConfirmationAnswer, ConfirmationPrompt, ConfirmationRequest } from '../src/types'

export type FetchHandler = (url: string, init: FetchInit | undefined) => FetchResult | Promise<FetchResult>

export const json = (body: unknown, status = 200): FetchResult => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body,
})

export const akamaiDenied: FetchResult = {
  status: 403,
  contentType: 'text/html',
  body: '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.abc</BODY></HTML>',
}

export class FakeToolPage implements ToolPage {
  readonly fetches: { url: string; init: FetchInit | undefined }[] = []
  readonly gotos: string[] = []
  readonly clicks: string[] = []
  readonly fills: { selector: string; text: string }[] = []
  readonly evaluated: string[] = []
  url = 'https://www.example.com/'
  extractResult: unknown = null
  evaluateResult: unknown = null
  private readonly routes = new Map<string, FetchHandler>()

  route(method: string, url: string, answer: FetchResult | FetchHandler): void {
    this.routes.set(`${method} ${url}`, typeof answer === 'function' ? answer : () => answer)
  }

  async goto(url: string): Promise<void> {
    this.gotos.push(url)
    this.url = url
  }

  currentUrl(): string {
    return this.url
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector)
  }

  async fill(selector: string, text: string): Promise<void> {
    this.fills.push({ selector, text })
  }

  async extract(): Promise<unknown> {
    return this.extractResult
  }

  async evaluate(source: string): Promise<unknown> {
    this.evaluated.push(source)
    return this.evaluateResult
  }

  async fetch(url: string, init?: FetchInit): Promise<FetchResult> {
    this.fetches.push({ url, init })
    const handler = this.routes.get(`${(init?.method ?? 'GET').toUpperCase()} ${url}`)
    if (handler === undefined) return json({ error: 'no route' }, 404)
    return handler(url, init)
  }

  /** URLs fetched, without the runtime's own login probes. */
  toolFetches(): string[] {
    return this.fetches.map((f) => f.url).filter((url) => !url.endsWith('/api/session'))
  }
}

export class FakeSessionDriver implements SessionDriver {
  readonly page = new FakeToolPage()
  /** What sessionSecrets() returns: cookie values and handed-off storage values. */
  cookieValues: string[] = []
  /** What cookieNames() returns. */
  cookieNameList: string[] = []
  readonly handoffs: { cookieDomains: readonly string[]; storage: readonly unknown[] }[] = []
  readonly sessionSecretRequests: { cookieDomains: readonly string[]; storage: readonly unknown[] }[] = []
  /** beginRun, unlockIrreversible and endRun, in the order they were called. */
  readonly runEvents: string[] = []
  readonly policies: ToolRunPolicy[] = []
  /** The current run's onBlocked, so a test can report what the driver refused. */
  onBlocked: ((request: BlockedRequest) => void) | null = null
  toolPageCalls = 0
  onHandoff: () => void | Promise<void> = () => {}

  async openAuthPage(): Promise<never> {
    throw new Error('only the auth flow opens auth pages')
  }

  async toolPage(): Promise<ToolPage> {
    this.toolPageCalls++
    return this.page
  }

  async handoff(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<void> {
    this.handoffs.push({ cookieDomains, storage })
    await this.onHandoff()
  }

  async sessionSecrets(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<readonly string[]> {
    this.sessionSecretRequests.push({ cookieDomains, storage })
    return [...this.cookieValues]
  }

  async cookieNames(_cookieDomains: readonly string[]): Promise<readonly string[]> {
    return [...this.cookieNameList]
  }

  beginRun(policy: ToolRunPolicy, onBlocked: (request: BlockedRequest) => void): void {
    this.runEvents.push('begin')
    this.policies.push(policy)
    this.onBlocked = onBlocked
  }

  unlockIrreversible(): void {
    this.runEvents.push('unlock')
  }

  endRun(): void {
    this.runEvents.push('end')
    this.onBlocked = null
  }

  async close(): Promise<void> {}
}

/** A JsonStore in memory. `text` is what is stored; null when nothing is. */
export class MemoryJsonStore implements JsonStore {
  text: string | null = null
  readonly writes: string[] = []
  failRead = false
  failWrite = false

  async read(): Promise<string | null> {
    if (this.failRead) throw new Error('EIO')
    return this.text
  }

  async write(text: string): Promise<void> {
    if (this.failWrite) throw new Error('ENOSPC')
    this.writes.push(text)
    this.text = text
  }
}

export class MemoryAudit implements AuditSink {
  readonly events: AuditEvent[] = []
  failNext: AuditEvent['type'] | null = null

  async append(event: AuditEvent): Promise<AuditRecord> {
    if (this.failNext === event.type) {
      this.failNext = null
      throw new Error('disk full')
    }
    this.events.push(event)
    return { seq: this.events.length, at: '2026-11-07T00:00:00.000Z', event, prev: '', hash: '' }
  }

  types(): string[] {
    return this.events.map((e) => e.type)
  }
}

export class FakePrompt implements ConfirmationPrompt {
  /** 'hang' never answers, and ignores its signal, like a window nobody looks at. */
  answer: ConfirmationAnswer | 'throw' | 'hang' = 'approved'
  readonly requests: ConfirmationRequest[] = []
  readonly signals: AbortSignal[] = []

  async ask(request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationAnswer> {
    this.requests.push(request)
    this.signals.push(signal)
    if (this.answer === 'throw') throw new Error('window closed')
    if (this.answer === 'hang') return new Promise<never>(() => {})
    return this.answer
  }
}

export class MemoryMarkers implements LoginMarkerStore {
  readonly states = new Map<string, LoginMarkerState>()
  failOn: 'read' | 'set' | 'hold' | 'clear' | null = null

  async read(adapterId: string): Promise<LoginMarkerState> {
    if (this.failOn === 'read') throw new Error('EIO')
    return this.states.get(adapterId) ?? { kind: 'unset' }
  }

  async set(adapterId: string): Promise<void> {
    if (this.failOn === 'set') throw new Error('EIO')
    this.states.set(adapterId, { kind: 'in-progress' })
  }

  async hold(
    adapterId: string,
    failures: number,
    retryAt: number | null,
    reason?: NeedsUserReason,
  ): Promise<void> {
    if (this.failOn === 'hold') throw new Error('EIO')
    this.states.set(adapterId, {
      kind: 'held',
      failures,
      retryAt,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  async clear(adapterId: string): Promise<void> {
    if (this.failOn === 'clear') throw new Error('EIO')
    this.states.delete(adapterId)
  }

  kind(adapterId = 'example-shop'): LoginMarkerState['kind'] {
    return this.states.get(adapterId)?.kind ?? 'unset'
  }
}

/** A manual clock. sleep() waits until advance() moves time past its deadline, or it is aborted. */
export class FakeClock {
  private current = Date.UTC(2026, 10, 7, 9, 0, 0)
  private timers: { at: number; resolve: () => void }[] = []

  now = (): number => this.current

  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SiteAdapterError('tool-run', 'aborted'))
        return
      }
      if (ms <= 0) {
        resolve()
        return
      }
      const timer = { at: this.current + ms, resolve }
      this.timers.push(timer)
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((t) => t !== timer)
        reject(new SiteAdapterError('tool-run', 'aborted'))
      })
    })

  /**
   * For the rate budget: moves time on by `ms` and resolves, recording the wait, so pacing doesn't
   * have to be driven by hand. Deadlines still use sleep().
   */
  readonly paced: number[] = []
  pacingSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new SiteAdapterError('tool-run', 'aborted')
    this.paced.push(ms)
    await this.advance(ms)
  }

  async advance(ms: number): Promise<void> {
    this.current += ms
    const due = this.timers.filter((t) => t.at <= this.current)
    this.timers = this.timers.filter((t) => t.at > this.current)
    for (const timer of due) timer.resolve()
    await flush()
  }

  pendingTimers(): number {
    return this.timers.length
  }
}

/** Lets queued promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
