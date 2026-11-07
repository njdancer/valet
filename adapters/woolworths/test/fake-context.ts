// A ToolContext whose page.fetch serves canned responses. Like the runtime, it checks every request
// against the manifest's request surface first, so a test fails if the adapter ever makes a call
// the real guard would cancel.

import { readFileSync } from 'node:fs'
import {
  type AdapterManifest,
  decideRequest,
  type EnsureResult,
  type FetchInit,
  type FetchResult,
  type ToolContext,
  type ToolPage,
  ValetError,
} from '@valet/core'
import { createManifest } from '../src/manifest'

export const FAKE_ORIGIN = 'https://www.woolworths.test'

/** A fresh copy of a fixture each call, so a test can change one thing without affecting others. */
export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

export interface RecordedFetch {
  readonly method: string
  readonly url: string
  readonly path: string
  readonly json: unknown
}

export type Responder = (request: RecordedFetch) => FetchResult

export function json(body: unknown, status = 200): FetchResult {
  return { status, contentType: 'application/json; charset=utf-8', body }
}

export class FakeToolContext implements ToolContext {
  /** Requests that passed the surface check, in order. */
  readonly fetches: RecordedFetch[] = []
  /** Requests the surface check refused. */
  readonly blocked: { method: string; url: string; reason: string }[] = []
  /** "ensure" and "METHOD /path" entries in call order. */
  readonly events: string[] = []
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  ensureResult: EnsureResult = { status: 'ok' }
  private readonly routes = new Map<string, Responder>()

  constructor(readonly manifest: AdapterManifest = createManifest({ origin: FAKE_ORIGIN })) {}

  /** Serves `METHOD /path` (path without query) with a fixed response or a responder. */
  on(method: string, path: string, response: FetchResult | Responder): this {
    this.routes.set(`${method} ${path}`, typeof response === 'function' ? response : () => response)
    return this
  }

  readonly session = {
    ensure: async (): Promise<EnsureResult> => {
      this.events.push('ensure')
      return this.ensureResult
    },
  }

  async confirm(): Promise<boolean> {
    throw new Error('confirm is not used by this adapter')
  }

  readonly page: ToolPage = {
    fetch: async (pathOrUrl: string, init?: FetchInit): Promise<FetchResult> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(pathOrUrl, this.manifest.home).toString()
      const decision = decideRequest(method, url, this.manifest.egress, this.manifest.requests)
      if (!decision.allowed) {
        this.blocked.push({ method, url, reason: decision.reason })
        throw new ValetError('request-surface', 'undeclared-request')
      }
      const path = new URL(url).pathname
      const request = { method, url, path, json: init?.json }
      this.fetches.push(request)
      this.events.push(`${method} ${path}`)
      const responder = this.routes.get(`${method} ${path}`)
      if (responder === undefined) throw new Error(`fake has no route for ${method} ${path}`)
      return responder(request)
    },
    goto: async () => unused('goto'),
    currentUrl: () => unused('currentUrl'),
    click: async () => unused('click'),
    fill: async () => unused('fill'),
    extract: async () => unused('extract'),
    evaluate: async () => unused('evaluate'),
  }
}

function unused(name: string): never {
  throw new Error(`page.${name} is not used by this adapter`)
}
