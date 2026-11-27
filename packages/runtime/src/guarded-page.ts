// The tool page as tool code sees it. Every fetch is checked against the manifest's request surface
// before it leaves, counted against the per-run ceiling, paced by the site's rate budget, and
// watched for bot-protection blocks. URLs are resolved against the manifest's home, never the
// page's current URL, so that navigating to another allowed host can't change where a relative
// fetch goes.
//
// Navigation is held to https on the egress hosts, unambiguous paths, and the GET declarations: a
// tool can't goto() a declared endpoint whose purpose outranks its own side effect, and a denied
// segment (checkout, payment, ...) needs an irreversible tool and an irreversible GET declaration,
// as core's decideRequest requires. Beyond that, navigation, like click(), is not checked against
// the request surface here: a read tool can still navigate to an undeclared page on an egress host
// that changes state when loaded.
//
// goto() is counted and paced like a fetch, and click() is paced (it may navigate or post a form)
// but not counted, since most clicks send nothing. A navigation reports no status, so the only
// block it can show us is Akamai's page, which we look for after each goto(). What a click loads,
// and what evaluate()d code or the page's own scripts send, is neither paced nor checked for blocks
// here; the driver holds those requests to the run policy, and nothing more.
//
// Tool code runs in this process and hands us its own objects, so every check runs against one
// snapshot of what it passed, and only that snapshot reaches the driver: a getter or Proxy can't
// show the check one thing and the request another.
//
// This guards the capability API, and fails fast with a precise error. Requests the page makes by
// itself, or that evaluate()d code makes with the page's own fetch, are held to the same run policy
// by the browser driver (SessionDriver.beginRun), which reports what it refuses to the tool host.

import {
  ambiguousPath,
  decideRequest,
  declarationOnHost,
  type ErrorClass,
  type FetchInit,
  type FetchResult,
  hostAllowed,
  type Purpose,
  pathMatches,
  type RequestDeclaration,
  type ToolPage,
  touchesDeniedSegment,
  ValetError,
} from '@valet/core'
import { CallGate, type CallGateOptions, headerValue, isRoutingOverride, SURFACE_CLASS } from './call-gate'
import { blockCause, isHtml, navigationBlocked } from './site-protection'

/**
 * One fetch tool code sent through the capability API and the answer it got, for the call's trace
 * (kept in memory, never written to disk). Nothing of the request's own is kept: the path is the
 * manifest's declaration, the host is a literal home or egress host or null, and no body, header,
 * query value or redirect target is read. A read answered from the session's cache sent nothing and
 * is not recorded.
 */
export interface SentRequest {
  readonly method: string
  /** The declaration's path as the manifest writes it, so no id or value from the request shows. */
  readonly path: string
  /** The host when the manifest names it literally (home or egress); null for a wildcard's match. */
  readonly host: string | null
  readonly purpose: Purpose
  /** The HTTP status; null when no answer came. */
  readonly status: number | null
  /** What the answer was, by its content type ('none' for no type); null when no answer came. */
  readonly contentType: 'json' | 'html' | 'other' | 'none' | null
  /** The browser followed a redirect to get the answer. */
  readonly redirected: boolean
  /** Why the request failed when no answer came back: the class of the error it threw. */
  readonly failed: ErrorClass | null
  /** When it was sent (epoch ms, after any pacing wait) and how long its answer took. */
  readonly at: number
  readonly durationMs: number
}

export interface GuardedPageOptions extends CallGateOptions {
  readonly inner: ToolPage
  /** Told of each fetch sent and how it ended. A throw is ignored. */
  readonly onRequest?: (request: SentRequest) => void
}

export class GuardedToolPage implements ToolPage {
  private readonly gate: CallGate

  constructor(private readonly options: GuardedPageOptions) {
    this.gate = new CallGate(options)
  }

  async goto(url: string): Promise<void> {
    const { state, manifest, sideEffect, inner, site } = this.options
    state.assertLive()
    const target = resolve(url, manifest.home)
    if (target === null || target.protocol !== 'https:' || !hostAllowed(target.hostname, manifest.egress)) {
      return this.gate.deny('egress', 'host-not-allowed', 'GET', target, url)
    }
    if (ambiguousPath(target.pathname)) {
      return this.gate.deny('request-surface', 'ambiguous-path', 'GET', target, url)
    }
    // The first GET declaration matching the path, as core's decideRequest picks it.
    const declared = manifest.requests.find(
      (d) =>
        d.method.toUpperCase() === 'GET' &&
        declarationOnHost(d, target.hostname) &&
        pathMatches(d.path, target.pathname),
    )
    if (
      touchesDeniedSegment(target.pathname) &&
      (sideEffect !== 'irreversible' || declared?.purpose !== 'irreversible')
    ) {
      return this.gate.deny('request-surface', 'denied-path', 'GET', target, url)
    }
    if (declared !== undefined && !this.gate.mayUse(declared)) {
      return this.gate.deny('request-surface', 'denied-path', 'GET', target, url)
    }
    const admitted = await this.gate.admit('GET', target, url)
    await state.track(inner.goto(target.href))
    const cause = await state.track(navigationBlocked(inner))
    if (cause !== null) this.gate.siteBlocked(cause)
    site.breaker.recordSuccess(admitted)
  }

  currentUrl(): string {
    return this.options.inner.currentUrl()
  }

  /** Paced like a request, since a click may navigate or post a form; not counted. */
  async click(selector: string): Promise<void> {
    const { state, inner } = this.options
    state.assertLive()
    await this.gate.pace()
    await state.track(inner.click(selector))
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
    const { state, manifest, inner, site } = this.options
    state.assertLive()
    const target = resolve(pathOrUrl, manifest.home)
    const request = snapshotInit(init)
    const method = request === null ? 'INVALID' : request.method
    if (target === null) return this.gate.deny('request-surface', 'host-not-allowed', method, null, pathOrUrl)
    if (request === null)
      return this.gate.deny('request-surface', 'undeclared-request', method, target, pathOrUrl)
    if (Object.keys(request.headers).some(isRoutingOverride)) {
      return this.gate.deny('request-surface', 'undeclared-request', method, target, pathOrUrl)
    }
    const decision = decideRequest(method, target.href, manifest.egress, manifest.requests)
    if (!decision.allowed) {
      return this.gate.deny('request-surface', SURFACE_CLASS[decision.reason], method, target, pathOrUrl)
    }
    if (!this.gate.mayUse(decision.declaration)) {
      return this.gate.deny('request-surface', 'denied-path', method, target, pathOrUrl)
    }
    const admitted = await this.gate.admit(method, target, pathOrUrl)
    const sent = this.now()
    let result: FetchResult
    try {
      result = await state.track(inner.fetch(target.href, request))
    } catch (error) {
      this.report(method, target, decision.declaration, sent, null, error)
      throw error
    }
    this.report(method, target, decision.declaration, sent, result, null)
    const cause = blockCause(result)
    if (cause !== null) this.gate.siteBlocked(cause)
    site.breaker.recordSuccess(admitted)
    // HTML where an API answer was expected: an error page or a redirect to a login page. Not a
    // block, so the site's breaker (shared with other adapters) stays closed.
    if (expectsJson(request.headers) && isHtml(result)) {
      throw new ValetError('tool-run', 'unexpected-shape')
    }
    return result
  }

  private now(): number {
    return this.options.clock?.now() ?? Date.now()
  }

  private report(
    method: string,
    target: URL,
    declared: RequestDeclaration,
    sent: number,
    result: FetchResult | null,
    error: unknown,
  ): void {
    const { onRequest, manifest } = this.options
    if (onRequest === undefined) return
    try {
      onRequest({
        method,
        path: declared.path,
        host: namedHost(target.hostname, manifest.home, manifest.egress),
        purpose: declared.purpose,
        status: result === null ? null : result.status,
        contentType: result === null ? null : contentKind(result.contentType),
        redirected: result?.redirected === true,
        failed: result !== null ? null : error instanceof ValetError ? error.errorClass : 'internal',
        at: sent,
        durationMs: Math.max(0, this.now() - sent),
      })
    } catch {
      // The trace is for reading; a recorder's failure must not change the call.
    }
  }
}

/** The host when the manifest names it literally; a wildcard's match could carry anything. */
function namedHost(host: string, home: string, egress: readonly string[]): string | null {
  const lower = host.toLowerCase()
  let homeHost: string | null
  try {
    homeHost = new URL(home).hostname.toLowerCase()
  } catch {
    homeHost = null
  }
  if (lower === homeHost) return lower
  return egress.some((pattern) => pattern.toLowerCase() === lower) ? lower : null
}

function contentKind(type: string | null | undefined): SentRequest['contentType'] {
  if (typeof type !== 'string' || type.length === 0) return 'none'
  const lower = type.toLowerCase()
  if (lower.includes('json')) return 'json'
  if (lower.includes('html')) return 'html'
  return 'other'
}

function resolve(pathOrUrl: string, home: string): URL | null {
  if (typeof pathOrUrl !== 'string') return null
  try {
    return new URL(pathOrUrl, home)
  } catch {
    return null
  }
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

/** page.fetch is for site APIs, so expect JSON unless the tool explicitly accepts something else. */
function expectsJson(headers: Readonly<Record<string, string>>): boolean {
  const accept = headerValue(headers, 'accept')
  return accept === undefined || /json/i.test(accept)
}
