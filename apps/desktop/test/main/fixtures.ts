// Shared test pieces for the main process: a small adapter, and fakes for the driver and its pages.
// Tests copy these and change one thing.

import {
  type AdapterDefinition,
  type AuthPage,
  type AuthPageOptions,
  defineAdapter,
  type ElementInfo,
  type FetchResult,
  type ManifestInput,
  parseManifest,
  SecretValue,
  type SessionDriver,
  type ToolPage,
} from '@valet/core'
import { z } from 'zod'
import type { DriverReporters } from '../../src/main/core/service'

export const SHOP: ManifestInput = {
  schemaVersion: 1,
  id: 'shop',
  name: 'Shop',
  version: '1.0.0',
  description: 'A test shop.',
  home: 'https://www.shop.test/',
  navigation: ['https://www.shop.test', 'https://login.shop.test'],
  egress: ['www.shop.test'],
  secrets: {
    login: {
      description: 'Shop account',
      fields: ['username', 'password'],
      origins: ['https://login.shop.test'],
    },
  },
  session: { cookieDomains: ['www.shop.test'], probe: { kind: 'cookie', name: 'sid' } },
  auth: {
    steps: [
      { op: 'goto', url: 'https://login.shop.test/login' },
      { op: 'fill', selector: '#user', value: { secret: 'login', field: 'username' } },
      { op: 'fill', selector: '#pass', value: { secret: 'login', field: 'password' } },
      {
        op: 'otp',
        selector: '#code',
        source: { messages: { sender: 'ShopBank', pattern: '(\\d{6})', maxAgeSeconds: 300 } },
      },
      { op: 'assertLoggedIn' },
    ],
  },
  requests: [
    { method: 'GET', path: '/api/items', purpose: 'read' },
    { method: 'POST', path: '/api/cart', purpose: 'write' },
  ],
  tools: [
    { name: 'echo', title: 'Echo', description: 'Returns its input.', sideEffect: 'read' },
    { name: 'add', title: 'Add', description: 'Asks, then adds.', sideEffect: 'write' },
  ],
  limits: { requestsPerRun: 5, minGapMs: 1000 },
}

export function shopDefinition(input: ManifestInput = SHOP): AdapterDefinition {
  return defineAdapter({
    manifest: parseManifest(input),
    tools: {
      echo: {
        input: z.object({ text: z.string() }),
        output: z.object({ text: z.string() }),
        run: async (_ctx, args: { text: string }) => ({ text: args.text }),
      },
      add: {
        input: z.object({ item: z.string() }),
        output: z.object({ added: z.boolean() }),
        run: async (ctx, args: { item: string }) => ({
          added: await ctx.confirm({
            requests: [{ method: 'POST', path: '/api/cart' }],
            note: `Add ${args.item}?`,
          }),
        }),
      },
    },
  })
}

/** The shop with a required store setting (D69): two more tools, which only the runtime runs. */
export const SHOP_WITH_STORE: ManifestInput = {
  ...SHOP,
  requests: [...(SHOP.requests ?? []), { method: 'POST', path: '/api/store', purpose: 'write' }],
  tools: [
    ...SHOP.tools,
    { name: 'find_stores', title: 'Find stores', description: 'Stores to choose from.', sideEffect: 'read' },
    { name: 'apply_store', title: 'Use store', description: 'Shops at the chosen store.', sideEffect: 'write' },
  ],
  settings: {
    store: {
      title: 'Store',
      description: 'The store the shop quotes prices for.',
      required: true,
      choices: { tool: 'find_stores', queryLabel: 'Postcode' },
      apply: { tool: 'apply_store' },
    },
  },
}

export const SHOP_STORES = [
  { value: '11', label: 'Shop Central', detail: '1 Main St' },
  { value: '12', label: 'Shop <b>North</b>' },
]

/** What the store shop's setting tools did, and what find_stores answers next. */
export interface StoreShopLog {
  readonly queries: string[]
  readonly applied: string[]
  /** Returned (or, when an Error, thrown) by find_stores. */
  answer: unknown
}

export function storeShopDefinition(log: StoreShopLog): AdapterDefinition {
  const shop = shopDefinition()
  return defineAdapter({
    manifest: parseManifest(SHOP_WITH_STORE),
    tools: {
      ...shop.tools,
      find_stores: {
        input: z.object({ query: z.string() }),
        output: z.unknown(),
        run: async (_ctx, args: { query: string }) => {
          log.queries.push(args.query)
          if (log.answer instanceof Error) throw log.answer
          return log.answer
        },
      },
      apply_store: {
        input: z.object({ value: z.string() }),
        output: z.unknown(),
        run: async (_ctx, args: { value: string }) => {
          log.applied.push(args.value)
        },
      },
    },
  })
}

export const SHOP_FILES = { 'src/index.ts': 'export default {}\n', 'package.json': '{}\n' }

/** An auth page whose cookie jar says whether the person is logged in. Records what happened. */
export class FakeAuthPage implements AuthPage {
  readonly gone: string[] = []
  handedTo: string[] = []
  closed = false
  cookies: string[] = []
  fetched: string[] = []
  fetchResult: FetchResult = { status: 200, contentType: 'application/json', body: { ok: true } }
  text: string[] = []
  /** What inspect() reports for every selector; null means not found. */
  element: ElementInfo | null = null
  typed: { text: string; secret: boolean }[] = []
  private url = 'about:blank'
  private releaseHand: (() => void) | null = null

  async goto(url: string): Promise<void> {
    this.gone.push(url)
    this.url = url
  }
  currentUrl(): string {
    return this.url
  }
  committedUrls(): readonly string[] {
    return this.gone
  }
  async inspect(): Promise<ElementInfo | null> {
    return this.element
  }
  async click(): Promise<void> {}
  async focus(): Promise<void> {}
  async type(text: string | SecretValue): Promise<void> {
    this.typed.push({ text: String(text), secret: text instanceof SecretValue })
  }
  async textPresent(text: string): Promise<boolean> {
    return this.text.some((t) => t.includes(text))
  }
  async fetch(url: string): Promise<FetchResult> {
    this.fetched.push(url)
    return this.fetchResult
  }
  async cookieNames(): Promise<readonly string[]> {
    return this.cookies
  }
  handToUser(reason: string): Promise<void> {
    this.handedTo.push(reason)
    return new Promise((resolve) => {
      this.releaseHand = resolve
    })
  }
  /** As if the person closed (hid) the shown window. */
  personClosed(): void {
    this.releaseHand?.()
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

/** A tool page that answers nothing: the shop's tools never call it. */
export const idleToolPage: ToolPage = {
  goto: async () => {},
  currentUrl: () => 'https://www.shop.test/',
  click: async () => {},
  fill: async () => {},
  extract: async () => null,
  evaluate: async () => null,
  fetch: async () => ({ status: 200, contentType: 'application/json', body: {} }),
}

export class FakeDriver implements SessionDriver {
  readonly pages: FakeAuthPage[] = []
  readonly handoffs: unknown[] = []
  sessionValues: string[] = []
  toolCookies: string[] = ['sid']
  runs = 0
  /** Runs and hand-offs in the order they happened. */
  readonly log: string[] = []
  closed = false
  nextPage: () => FakeAuthPage = () => new FakeAuthPage()
  /** What each openAuthPage() was given, in order. */
  readonly authOptions: (AuthPageOptions | undefined)[] = []
  /** The reporters the service gave createDriver. */
  reporters: DriverReporters | null = null

  async openAuthPage(options?: AuthPageOptions): Promise<AuthPage> {
    this.authOptions.push(options)
    const page = this.nextPage()
    this.pages.push(page)
    return page
  }
  async toolPage(): Promise<ToolPage> {
    return idleToolPage
  }
  async handoff(cookieDomains: readonly string[], storage: readonly unknown[]): Promise<void> {
    this.handoffs.push({ cookieDomains, storage })
    this.log.push('handoff')
  }
  async sessionSecrets(): Promise<readonly string[]> {
    return this.sessionValues
  }
  async cookieNames(): Promise<readonly string[]> {
    return this.toolCookies
  }
  beginRun(): void {
    this.runs++
    this.log.push('begin')
  }
  unlockIrreversible(): void {}
  endRun(): void {
    this.log.push('end')
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

/** Timers a test runs by hand. */
export class ManualTimers {
  private next = 1
  readonly pending = new Map<number, { run: () => void; ms: number }>()

  setTimeout = (run: () => void, ms: number): unknown => {
    const id = this.next++
    this.pending.set(id, { run, ms })
    return id
  }
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }
  /** Runs every pending timer. */
  fire(): void {
    for (const [id, timer] of [...this.pending]) {
      this.pending.delete(id)
      timer.run()
    }
  }
}
