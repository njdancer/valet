// The tool page as tool code sees it. Every fetch is checked against the manifest's request surface
// before it leaves, counted against the per-run ceiling, paced by the site's rate budget, and
// watched for bot-protection blocks. Navigation is held to the egress hosts. URLs are resolved
// against the manifest's home, never the page's current URL, so that navigating to another allowed
// host can't change where a relative fetch goes.
//
// This guards the capability API only. Requests the page makes by itself, or that evaluate()d code
// makes with the page's own fetch, are the browser driver's job (webRequest egress filtering).

import {
  type AdapterManifest,
  type AuditEvent,
  decideRequest,
  type ErrorClass,
  type FetchInit,
  type FetchResult,
  hostAllowed,
  type Purpose,
  SiteAdapterError,
  type Stage,
  type ToolPage,
  touchesDeniedSegment,
} from '@siteadapter/core'
import type { CallState } from './call-state'
import { redactString } from './redaction'
import { blockedBySite, looksBlocked, type SiteGuards } from './site-protection'

const PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

/** Headers some servers honour to turn one method into another, which would bypass method matching. */
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override']

const MAX_TARGET_LENGTH = 300

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
      return this.deny('egress', 'host-not-allowed', 'GET', target)
    }
    if (deniedPath(target.pathname) && sideEffect !== 'irreversible') {
      return this.deny('request-surface', 'denied-path', 'GET', target)
    }
    await this.admit('GET', target)
    await inner.goto(target.href)
  }

  currentUrl(): string {
    return this.options.inner.currentUrl()
  }

  async click(selector: string): Promise<void> {
    this.options.state.assertLive()
    await this.options.inner.click(selector)
  }

  async fill(selector: string, text: string): Promise<void> {
    this.options.state.assertLive()
    await this.options.inner.fill(selector, text)
  }

  async extract(
    selector: string,
    options?: { readonly attribute?: string; readonly all?: boolean },
  ): Promise<unknown> {
    this.options.state.assertLive()
    return this.options.inner.extract(selector, options)
  }

  async evaluate(source: string, args?: unknown): Promise<unknown> {
    this.options.state.assertLive()
    return this.options.inner.evaluate(source, args)
  }

  async fetch(pathOrUrl: string, init?: FetchInit): Promise<FetchResult> {
    const { state, manifest, sideEffect, inner, site } = this.options
    state.assertLive()
    const method = typeof init?.method === 'string' ? init.method.toUpperCase() : 'GET'
    const target = resolve(pathOrUrl, manifest.home)
    if (target === null) return this.deny('request-surface', 'host-not-allowed', method, null)
    if (init?.method !== undefined && typeof init.method !== 'string') {
      return this.deny('request-surface', 'undeclared-request', method, target)
    }
    if (hasMethodOverride(init?.headers)) {
      return this.deny('request-surface', 'undeclared-request', method, target)
    }
    const decision = decideRequest(method, target.href, manifest.egress, manifest.requests)
    if (!decision.allowed) {
      const errorClass: ErrorClass =
        decision.reason === 'undeclared'
          ? 'undeclared-request'
          : decision.reason === 'denied-path'
            ? 'denied-path'
            : 'host-not-allowed'
      return this.deny('request-surface', errorClass, method, target)
    }
    const purpose = decision.declaration.purpose
    if (deniedPath(target.pathname) && purpose !== 'irreversible') {
      return this.deny('request-surface', 'denied-path', method, target)
    }
    if (PURPOSE_RANK[purpose] > PURPOSE_RANK[sideEffect]) {
      return this.deny('request-surface', 'denied-path', method, target)
    }
    await this.admit(method, target)
    const result = await inner.fetch(target.href, { ...init, method })
    if (looksBlocked(result, expectsJson(init?.headers))) {
      state.blocked = true
      site.breaker.trip()
      throw blockedBySite()
    }
    site.breaker.recordSuccess()
    return result
  }

  /** Counts the request against the ceiling and waits for the site's rate budget. */
  private async admit(method: string, target: URL): Promise<void> {
    const { state, manifest, site } = this.options
    state.requests++
    if (state.requests > manifest.limits.requestsPerRun) {
      return this.deny('request-surface', 'request-ceiling', method, target)
    }
    if (site.breaker.isOpen()) {
      state.blocked = true
      throw blockedBySite()
    }
    await site.budget.acquire(state.signal)
    state.assertLive()
    // The breaker can open while we wait our turn.
    if (site.breaker.isOpen()) {
      state.blocked = true
      throw blockedBySite()
    }
  }

  private async deny(
    stage: Stage,
    errorClass: ErrorClass,
    method: string,
    target: URL | null,
  ): Promise<never> {
    const { state, adapterId, audit } = this.options
    const error = new SiteAdapterError(stage, errorClass)
    state.violation ??= error
    await audit({
      type: 'request-blocked',
      adapterId,
      method: /^[A-Z]{1,10}$/.test(method) ? method : 'INVALID',
      target: redactString(describeTarget(target), state.sensitive()),
      reason: errorClass,
      callId: state.callId,
    })
    throw error
  }
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

/**
 * The core deny list matches raw segments. Servers decode percent-escapes and often drop
 * ";matrix" parameters before routing, so "check%6Fut" or "checkout;x=1" must count as checkout.
 */
export function deniedPath(pathname: string): boolean {
  if (touchesDeniedSegment(pathname)) return true
  const normalised = pathname
    .split('/')
    .map((segment) => {
      const bare = segment.split(';')[0] ?? ''
      try {
        return decodeURIComponent(bare)
      } catch {
        return bare
      }
    })
    .join('/')
  return touchesDeniedSegment(normalised)
}

function headerValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}

function hasMethodOverride(headers: Readonly<Record<string, string>> | undefined): boolean {
  return METHOD_OVERRIDE_HEADERS.some((name) => headerValue(headers, name) !== undefined)
}

/** page.fetch is for site APIs, so expect JSON unless the tool explicitly accepts something else. */
function expectsJson(headers: Readonly<Record<string, string>> | undefined): boolean {
  const accept = headerValue(headers, 'accept')
  return accept === undefined || /json/i.test(accept)
}
