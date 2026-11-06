// The tool page as tool code sees it. Every fetch is checked against the manifest's request surface
// before it leaves, counted against the per-run ceiling, paced by the site's rate budget, and
// watched for bot-protection blocks. URLs are resolved against the manifest's home, never the
// page's current URL, so that navigating to another allowed host can't change where a relative
// fetch goes.
//
// Navigation is held to https on the egress hosts, unambiguous paths, denied segments, and the GET
// declarations: a tool can't goto() a declared endpoint whose purpose outranks its own side effect.
// Beyond that, navigation, like click(), is not checked against the request surface here: a read tool
// can still navigate to an undeclared page on an egress host that changes state when loaded.
//
// Tool code runs in this process and hands us its own objects, so every check runs against one
// snapshot of what it passed, and only that snapshot reaches the driver: a getter or Proxy can't
// show the check one thing and the request another.
//
// This guards the capability API, and fails fast with a precise error. Requests the page makes by
// itself, or that evaluate()d code makes with the page's own fetch, are held to the same run policy
// by the browser driver (SessionDriver.beginRun), which reports what it refuses to the tool host.

import {
  type AdapterManifest,
  type AuditEvent,
  ambiguousPath,
  decideRequest,
  type ErrorClass,
  type FetchInit,
  type FetchResult,
  hostAllowed,
  type Purpose,
  pathMatches,
  SiteAdapterError,
  type Stage,
  type ToolPage,
  touchesDeniedSegment,
} from '@siteadapter/core'
import type { CallState } from './call-state'
import { blockCause, breakerRefusal, isHtml, type SiteGuards, siteRefusal } from './site-protection'

const PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

/** Headers some servers honour to turn one method into another, which would bypass method matching. */
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override']

export const MAX_TARGET_LENGTH = 300

export interface GuardedPageOptions {
  readonly adapterId: string
  readonly manifest: AdapterManifest
  /** The running tool's declared side effect. A request may not do more than its tool declares. */
  readonly sideEffect: Purpose
  readonly inner: ToolPage
  readonly site: SiteGuards
  readonly state: CallState
  /** Appends an audit event. Must not throw. */
  readonly audit: (event: AuditEvent) => Promise<void>
}

export class GuardedToolPage implements ToolPage {
  constructor(private readonly options: GuardedPageOptions) {}

  async goto(url: string): Promise<void> {
    const { state, manifest, sideEffect, inner } = this.options
    state.assertLive()
    const target = resolve(url, manifest.home)
    if (target === null || target.protocol !== 'https:' || !hostAllowed(target.hostname, manifest.egress)) {
      return this.deny('egress', 'host-not-allowed', 'GET', target, url)
    }
    if (ambiguousPath(target.pathname)) {
      return this.deny('request-surface', 'ambiguous-path', 'GET', target, url)
    }
    if (touchesDeniedSegment(target.pathname) && sideEffect !== 'irreversible') {
      return this.deny('request-surface', 'denied-path', 'GET', target, url)
    }
    const outranked = manifest.requests.some(
      (d) =>
        d.method.toUpperCase() === 'GET' &&
        pathMatches(d.path, target.pathname) &&
        PURPOSE_RANK[d.purpose] > PURPOSE_RANK[sideEffect],
    )
    if (outranked) return this.deny('request-surface', 'denied-path', 'GET', target, url)
    await this.admit('GET', target, url)
    await state.track(inner.goto(target.href))
  }

  currentUrl(): string {
    return this.options.inner.currentUrl()
  }

  async click(selector: string): Promise<void> {
    this.options.state.assertLive()
    await this.options.state.track(this.options.inner.click(selector))
  }

  async fill(selector: string, text: string): Promise<void> {
    this.options.state.assertLive()
    await this.options.state.track(this.options.inner.fill(selector, text))
  }

  async extract(
    selector: string,
    options?: { readonly attribute?: string; readonly all?: boolean },
  ): Promise<unknown> {
    this.options.state.assertLive()
    return this.options.state.track(this.options.inner.extract(selector, options))
  }

  async evaluate(source: string, args?: unknown): Promise<unknown> {
    this.options.state.assertLive()
    return this.options.state.track(this.options.inner.evaluate(source, args))
  }

  async fetch(pathOrUrl: string, init?: FetchInit): Promise<FetchResult> {
    const { state, manifest, sideEffect, inner, site } = this.options
    state.assertLive()
    const target = resolve(pathOrUrl, manifest.home)
    const request = snapshotInit(init)
    const method = request === null ? 'INVALID' : request.method
    if (target === null) return this.deny('request-surface', 'host-not-allowed', method, null, pathOrUrl)
    if (request === null) return this.deny('request-surface', 'undeclared-request', method, target, pathOrUrl)
    if (METHOD_OVERRIDE_HEADERS.some((name) => headerValue(request.headers, name) !== undefined)) {
      return this.deny('request-surface', 'undeclared-request', method, target, pathOrUrl)
    }
    const decision = decideRequest(method, target.href, manifest.egress, manifest.requests)
    if (!decision.allowed) {
      return this.deny('request-surface', SURFACE_CLASS[decision.reason], method, target, pathOrUrl)
    }
    if (PURPOSE_RANK[decision.declaration.purpose] > PURPOSE_RANK[sideEffect]) {
      return this.deny('request-surface', 'denied-path', method, target, pathOrUrl)
    }
    await this.admit(method, target, pathOrUrl)
    const result = await state.track(inner.fetch(target.href, request))
    const cause = blockCause(result)
    if (cause !== null) {
      state.blocked = true
      site.breaker.trip(cause, state.callId)
      throw siteRefusal(cause)
    }
    site.breaker.recordSuccess()
    // HTML where an API answer was expected: an error page or a redirect to a login page. Not a
    // block, so the site's breaker (shared with other adapters) stays closed.
    if (expectsJson(request.headers) && isHtml(result)) throw new SiteAdapterError('tool-run', 'invalid')
    return result
  }

  /** Counts the request against the ceiling and waits for the site's rate budget. */
  private async admit(method: string, target: URL, raw: unknown): Promise<void> {
    const { state, manifest, site } = this.options
    state.requests++
    if (state.requests > manifest.limits.requestsPerRun) {
      return this.deny('request-surface', 'request-ceiling', method, target, raw)
    }
    if (site.breaker.isOpen()) {
      state.blocked = true
      throw breakerRefusal()
    }
    await site.budget.acquire(state.signal)
    state.assertLive()
    // The breaker can open while we wait our turn.
    if (site.breaker.isOpen()) {
      state.blocked = true
      throw breakerRefusal()
    }
  }

  private async deny(
    stage: Stage,
    errorClass: ErrorClass,
    method: string,
    target: URL | null,
    raw: unknown,
  ): Promise<never> {
    const { state, adapterId, audit } = this.options
    const error = new SiteAdapterError(stage, errorClass)
    state.violation ??= error
    await audit({
      type: 'request-blocked',
      adapterId,
      method: plainMethod(method),
      target: state.redactTarget(describeTarget(target), raw),
      reason: errorClass,
      initiator: 'tool',
      callId: state.callId,
    })
    throw error
  }
}

const SURFACE_CLASS = {
  'host-not-allowed': 'host-not-allowed',
  'bad-url': 'host-not-allowed',
  undeclared: 'undeclared-request',
  'denied-path': 'denied-path',
  'ambiguous-path': 'ambiguous-path',
} as const satisfies Record<string, ErrorClass>

/** An HTTP method as it may appear in the audit log; anything else is recorded as INVALID. */
export function plainMethod(method: unknown): string {
  return typeof method === 'string' && /^[A-Z]{1,10}$/.test(method) ? method : 'INVALID'
}

function resolve(pathOrUrl: string, home: string): URL | null {
  if (typeof pathOrUrl !== 'string') return null
  try {
    return new URL(pathOrUrl, home)
  } catch {
    return null
  }
}

/** Origin and path only: query strings and fragments can carry data. */
function describeTarget(target: URL | null): string {
  if (target === null) return '(unparseable)'
  return `${target.origin}${target.pathname}`.slice(0, MAX_TARGET_LENGTH)
}

interface RequestSnapshot {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly json?: unknown
}

/**
 * Reads each field of `init` exactly once into a fresh frozen object. Header names and values that
 * aren't strings are dropped. Returns null when init can't be read or its method isn't a string.
 */
function snapshotInit(init: FetchInit | undefined): RequestSnapshot | null {
  if (init === undefined) return Object.freeze({ method: 'GET', headers: Object.freeze({}) })
  try {
    if (init === null || typeof init !== 'object') return null
    const rawMethod: unknown = init.method
    const rawHeaders: unknown = init.headers
    const rawJson: unknown = init.json
    if (rawMethod !== undefined && typeof rawMethod !== 'string') return null
    const headers: Record<string, string> = {}
    if (rawHeaders !== undefined) {
      if (rawHeaders === null || typeof rawHeaders !== 'object') return null
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (typeof value !== 'string') continue
        Object.defineProperty(headers, name, { value, enumerable: true })
      }
    }
    const snapshot: RequestSnapshot = {
      method: (rawMethod ?? 'GET').toUpperCase(),
      headers: Object.freeze(headers),
      // A plain copy, so the driver serialises exactly what was there when we looked.
      ...(rawJson === undefined ? {} : { json: JSON.parse(JSON.stringify(rawJson)) as unknown }),
    }
    return Object.freeze(snapshot)
  } catch {
    return null
  }
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

/** page.fetch is for site APIs, so expect JSON unless the tool explicitly accepts something else. */
function expectsJson(headers: Readonly<Record<string, string>>): boolean {
  const accept = headerValue(headers, 'accept')
  return accept === undefined || /json/i.test(accept)
}
