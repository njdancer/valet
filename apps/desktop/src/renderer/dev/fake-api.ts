// An in-memory ValetApi with realistic Woolworths data, for `vite` dev in a plain browser and
// for tests. It behaves like the main process where the renderer could get it wrong (a grant for
// origins the manifest didn't request is refused; approving a stale hash is refused), so tests that
// pass against it hold against the real thing. Nothing here is a real secret: there are none to have.
//
// Times are minutes before `now`, so the data reads the same whenever it is loaded. The worked
// example is Sat 7 Nov 2026, 9:48 pm in Sydney, as in docs/mockups.

import type { AuditEvent, AuditRecord, ProviderKind, RequestDeclaration } from '@valet/core'
import type {
  AdapterDetail,
  AdapterSummary,
  AppEvent,
  AppStatus,
  AttentionItem,
  AuditCategory,
  AuditQuery,
  AuthStepEntry,
  ChainStatus,
  ClientInfo,
  ClientSnippet,
  ConfirmationItem,
  EndpointStatus,
  GrantInfo,
  GrantRequest,
  PendingReview,
  PreviewPart,
  ProbeInfo,
  ProviderStatus,
  RunStats,
  RunSummary,
  RunTrace,
  Settings,
  SetupStatus,
  SiteHealth,
  TraceStep,
  UpdateStatus,
  ValetApi,
  VaultItem,
} from '../../shared/api'

export interface FakeOptions {
  /** Epoch ms the data is relative to. Defaults to the moment the fake is created. */
  readonly now?: number
  /**
   * A first launch: Woolworths installed and waiting for its first review, no grants, no clients,
   * no 1Password provider set up, and setup not finished. Otherwise the app has been in use for days.
   */
  readonly firstRun?: boolean
}

/** Test and dev hooks that the real API doesn't have. */
export interface FakeControls {
  emit(event: AppEvent): void
  /** Makes the next verify() report the chain broken at `seq`. */
  breakChainAt(seq: number): void
  /** Replaces one pending review, e.g. to test a review that only removes things. */
  setPendingReview(review: PendingReview): void
  /** Makes every call to `method` (e.g. "grants.make") reject. */
  failNext(method: string): void
  /** Appends a record to the audit log, as the runtime would, and emits audit-appended. */
  appendAudit(event: AuditEvent): AuditRecord
  /** What the next settings.chooseOpPath() dialog picks; null is a cancelled dialog. */
  chooseOpPathResult(path: string | null): void
  /** Makes a 1Password provider available or not, as setting it up outside the app would. */
  setProviderAvailable(kind: ProviderKind, available: boolean): void
  /** Records a client's first call, as the endpoint would. */
  clientSeen(clientId: string): void
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[]
}

export type FakeApi = ValetApi & { readonly fake: FakeControls }

export const WOOLWORTHS_HASH = '9f3c1a7e52d4a4c123b1612dd272d1371c17149d439536b3216fdaeec8d9e0f1'
export const WOOLWORTHS_NEXT_HASH = '4b7e2d91c0a8f3e65d21b7a9c48e0f13a6d5b2c97e4f1a08d3c6b9e2f5a7a83c'
export const COLES_HASH = 'd02e77b1a5c34e8f9b6d1c2a7e0f5b3d8c4a9e6f1b2d7c3a8e5f0b9d6c1a4c90'

const WOW_WWW = 'https://www.woolworths.com.au'
const WOW_AUTH = 'https://auth.woolworths.com.au'

const WOOLWORTHS_REQUESTS: RequestDeclaration[] = [
  { method: 'POST', path: '/apis/ui/Search/products', purpose: 'read' },
  { method: 'GET', path: '/apis/ui/product/detail/:stockcode', purpose: 'read' },
  { method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' },
  { method: 'POST', path: '/api/v3/ui/trolley/update', purpose: 'write' },
]

const WOOLWORTHS_PROBE: ProbeInfo = {
  kind: 'fetch',
  path: '/api/ui/v2/bootstrap',
  expectStatus: 200,
  loggedOutStatuses: [401],
  jsonPath: 'IsLoggedIn',
  equals: true,
}

/** The 0.3.0 login, as the runtime renders it from the manifest (fills are in secretFills). */
const WOOLWORTHS_AUTH_STEPS: AuthStepEntry[] = [
  { op: 'goto', detail: 'goto https://auth.woolworths.com.au/u/login' },
  { op: 'when', detail: 'when not visible input[name=username]' },
  { op: 'needsUser', detail: 'needsUser site-changed' },
  { op: 'click', detail: 'click button[type=submit]' },
  { op: 'when', detail: 'when visible input[autocomplete="one-time-code"]' },
  { op: 'otp', detail: 'otp input[autocomplete="one-time-code"] ← secret login' },
  { op: 'assertLoggedIn', detail: 'assertLoggedIn' },
]

const WOOLWORTHS_LIMITS = {
  requestsPerRun: 6,
  minGapMs: 10_000,
  cooldownSeconds: 1800,
  maxCooldownSeconds: 21_600,
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createFakeApi(options: FakeOptions = {}): FakeApi {
  const now = options.now ?? Date.now()
  const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
  const inMinutes = (minutes: number): string => new Date(now + minutes * 60_000).toISOString()

  const listeners = new Set<(event: AppEvent) => void>()
  const calls: { method: string; args: readonly unknown[] }[] = []
  const failing = new Set<string>()
  let brokenAt: number | null = null

  const emit = (event: AppEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }

  /** Records the call and throws if a test asked this method to fail. */
  const enter = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args })
    if (failing.delete(method)) throw new Error(`fake ${method} failed`)
  }

  // ---------- State ----------

  let grants: GrantInfo[] = [
    {
      adapterId: 'woolworths',
      adapterHash: WOOLWORTHS_HASH,
      secret: 'login',
      provider: 'onepassword-service-account',
      itemId: 'op-item-7c2a',
      itemTitle: 'Woolworths',
      origins: [WOW_AUTH],
      grantedAt: ago(5 * 24 * 60 + 106),
      lastUsedAt: ago(1),
    },
    {
      adapterId: 'coles',
      adapterHash: COLES_HASH,
      secret: 'login',
      provider: 'onepassword-cli',
      itemId: 'op-item-3d18',
      itemTitle: 'Coles',
      origins: ['https://www.coles.com.au'],
      grantedAt: ago(9 * 24 * 60),
      lastUsedAt: ago(128),
    },
  ]

  const vault: VaultItem[] = [
    { id: 'op-item-7c2a', title: 'Woolworths' },
    { id: 'op-item-91fe', title: 'Woolworths Rewards' },
    { id: 'op-item-0b44', title: 'Woolworths (old)' },
    { id: 'op-item-3d18', title: 'Coles' },
  ]

  const woolworthsBase: AdapterDetail = {
    id: 'woolworths',
    name: 'Woolworths',
    site: 'woolworths.com.au',
    version: '0.3.0',
    hash: WOOLWORTHS_HASH,
    approval: 'approved',
    pendingUpdate: { version: '0.4.0', hash: WOOLWORTHS_NEXT_HASH },
    toolCounts: { read: 3, write: 3, irreversible: 0 },
    secrets: [{ name: 'login', granted: true }],
    messagesSources: [],
    session: { state: 'needs-user', checkedAt: ago(1), needsUser: 'captcha', since: ago(1) },
    calls7d: 128,
    description: 'Search Woolworths (Australia) products and manage the online shopping cart.',
    home: `${WOW_WWW}/`,
    approvedAt: ago(5 * 24 * 60 + 107),
    partitions: { auth: 'persist:auth:woolworths', tool: 'persist:tool:woolworths' },
    navigation: [WOW_WWW, WOW_AUTH],
    frameOrigins: [],
    egress: ['www.woolworths.com.au', 'cdn0.woolworths.media', 'acs.woolworths.com.au'],
    cookieDomains: ['woolworths.com.au', 'www.woolworths.com.au'],
    storage: [],
    probe: WOOLWORTHS_PROBE,
    requests: WOOLWORTHS_REQUESTS,
    limits: WOOLWORTHS_LIMITS,
    tools: [
      {
        name: 'search_products',
        title: 'Search products',
        description: 'Search the Woolworths range by keyword: prices, cup prices, specials and availability.',
        sideEffect: 'read',
        calls7d: 54,
      },
      {
        name: 'product_details',
        title: 'Product details',
        description: 'Full details for one product by stockcode: ingredients, allergens and nutrition.',
        sideEffect: 'read',
        calls7d: 19,
      },
      {
        name: 'get_cart',
        title: 'Get cart',
        description: 'The items in the cart, with quantities, line totals, subtotal and savings.',
        sideEffect: 'read',
        calls7d: 27,
      },
      {
        name: 'add_to_cart',
        title: 'Add to cart',
        description: 'Adds a quantity of a product to the cart, on top of any already there.',
        sideEffect: 'write',
        calls7d: 14,
      },
      {
        name: 'update_cart_line',
        title: 'Update cart line',
        description: 'Sets the exact quantity of a product in the cart.',
        sideEffect: 'write',
        calls7d: 11,
      },
      {
        name: 'remove_from_cart',
        title: 'Remove from cart',
        description: 'Removes a product from the cart entirely. Asks you first.',
        sideEffect: 'write',
        calls7d: 3,
      },
    ],
    secretRequests: [
      {
        name: 'login',
        description: 'Woolworths account sign-in (Auth0 Universal Login)',
        fields: ['username', 'password'],
        origins: [WOW_AUTH],
        grant: null,
      },
    ],
    messages: [],
    handedOver: { cookies: 14, storageKeys: 0 },
  }

  const colesBase: AdapterDetail = {
    id: 'coles',
    name: 'Coles',
    site: 'coles.com.au',
    version: '0.1.2',
    hash: COLES_HASH,
    approval: 'approved',
    pendingUpdate: null,
    toolCounts: { read: 3, write: 1, irreversible: 0 },
    secrets: [{ name: 'login', granted: true }],
    messagesSources: [{ sender: '+61 400 000 111', granted: false }],
    session: { state: 'logged-in', checkedAt: ago(128), needsUser: null, since: ago(300) },
    calls7d: 41,
    description: 'Search Coles products and read or change the trolley.',
    home: 'https://www.coles.com.au/',
    approvedAt: ago(9 * 24 * 60 + 2),
    partitions: { auth: 'persist:auth:coles', tool: 'persist:tool:coles' },
    navigation: ['https://www.coles.com.au'],
    frameOrigins: [],
    egress: ['www.coles.com.au'],
    cookieDomains: ['coles.com.au'],
    storage: [],
    probe: { kind: 'cookie', name: 'coles-session' },
    requests: [
      { method: 'GET', path: '/api/products/search', purpose: 'read' },
      { method: 'GET', path: '/api/products/:id', purpose: 'read' },
      { method: 'GET', path: '/api/trolley', purpose: 'read' },
      { method: 'POST', path: '/api/trolley/items', purpose: 'write' },
    ],
    limits: { requestsPerRun: 6, minGapMs: 10_000, cooldownSeconds: 600, maxCooldownSeconds: 7200 },
    tools: [
      {
        name: 'search_products',
        title: 'Search',
        description: 'Search Coles products.',
        sideEffect: 'read',
        calls7d: 20,
      },
      { name: 'get_product', title: 'Product', description: 'One product.', sideEffect: 'read', calls7d: 6 },
      { name: 'get_trolley', title: 'Trolley', description: 'The trolley.', sideEffect: 'read', calls7d: 12 },
      {
        name: 'update_trolley',
        title: 'Update',
        description: 'Change a line.',
        sideEffect: 'write',
        calls7d: 3,
      },
    ],
    secretRequests: [
      {
        name: 'login',
        description: 'Coles account sign-in',
        fields: ['username', 'password'],
        origins: ['https://www.coles.com.au'],
        grant: null,
      },
    ],
    messages: [
      {
        sender: '+61 400 000 111',
        maxAgeSeconds: 300,
        requestedOrigins: ['https://www.coles.com.au'],
        grant: null,
      },
    ],
    handedOver: { cookies: 9, storageKeys: 0 },
  }

  const adapters = new Map<string, AdapterDetail>([
    ['woolworths', woolworthsBase],
    ['coles', colesBase],
  ])

  let reviews: PendingReview[] = [
    {
      adapterId: 'woolworths',
      name: 'Woolworths',
      site: 'woolworths.com.au',
      from: { version: '0.3.0', hash: WOOLWORTHS_HASH },
      to: { version: '0.4.0', hash: WOOLWORTHS_NEXT_HASH },
      submittedAt: ago(28),
      source: 'authoring-agent',
      diff: {
        navigation: { added: [], removed: [], unchanged: [WOW_WWW, WOW_AUTH] },
        frameOrigins: { added: [], removed: [], unchanged: [] },
        egress: {
          added: ['api.woolworthsrewards.com.au'],
          removed: [],
          unchanged: ['www.woolworths.com.au', 'cdn0.woolworths.media', 'acs.woolworths.com.au'],
        },
        cookieDomains: { added: [], removed: [], unchanged: ['woolworths.com.au', 'www.woolworths.com.au'] },
        storage: { added: [], removed: [], unchanged: [] },
        requests: {
          added: [{ method: 'GET', path: '/api/v1/rewards/balance', purpose: 'read' }],
          removed: [],
          unchanged: WOOLWORTHS_REQUESTS,
        },
        tools: {
          added: [{ name: 'get_rewards_balance', title: 'Everyday Rewards balance', sideEffect: 'read' }],
          removed: [],
          unchanged: woolworthsBase.tools.map(({ name, title, sideEffect }) => ({ name, title, sideEffect })),
        },
        secrets: {
          added: [],
          removed: [],
          unchanged: [
            {
              name: 'login',
              description: 'Woolworths account sign-in (Auth0 Universal Login)',
              fields: ['username', 'password'],
              origins: [WOW_AUTH],
            },
          ],
        },
        secretFills: {
          added: [],
          removed: [],
          unchanged: [
            { selector: 'input[name=username]', secret: 'login', field: 'username' },
            { selector: 'input#password', secret: 'login', field: 'password' },
          ],
        },
        authSteps: { added: [], removed: [], unchanged: WOOLWORTHS_AUTH_STEPS },
        messagesSources: { added: [], removed: [], unchanged: [] },
        limits: { before: WOOLWORTHS_LIMITS, after: WOOLWORTHS_LIMITS },
        probe: { before: WOOLWORTHS_PROBE, after: WOOLWORTHS_PROBE },
      },
      manifestDiff: [
        { kind: 'hunk', oldLine: null, newLine: null, text: '@@ "version" @@' },
        { kind: 'del', oldLine: 5, newLine: null, text: '  "version": "0.3.0",' },
        { kind: 'add', oldLine: null, newLine: 5, text: '  "version": "0.4.0",' },
        { kind: 'hunk', oldLine: null, newLine: null, text: '@@ "egress" @@' },
        { kind: 'same', oldLine: 14, newLine: 14, text: '    "acs.woolworths.com.au",' },
        { kind: 'add', oldLine: null, newLine: 15, text: '    "api.woolworthsrewards.com.au"' },
        { kind: 'hunk', oldLine: null, newLine: null, text: '@@ "requests" @@' },
        {
          kind: 'add',
          oldLine: null,
          newLine: 61,
          text: '  { "method": "GET", "path": "/api/v1/rewards/balance",',
        },
        { kind: 'add', oldLine: null, newLine: 62, text: '    "purpose": "read" },' },
        { kind: 'hunk', oldLine: null, newLine: null, text: '@@ "tools" @@' },
        { kind: 'add', oldLine: null, newLine: 98, text: '  { "name": "get_rewards_balance",' },
        { kind: 'add', oldLine: null, newLine: 99, text: '    "title": "Everyday Rewards balance",' },
        { kind: 'add', oldLine: null, newLine: 100, text: '    "sideEffect": "read", … }' },
      ],
      files: [
        { path: 'src/tools/rewards.ts', status: 'added', added: 64, removed: 0 },
        { path: 'src/manifest.ts', status: 'modified', added: 12, removed: 1 },
        { path: 'test/rewards.test.ts', status: 'added', added: 88, removed: 0 },
      ],
    },
  ]

  const breakers: SiteHealth[] = [
    {
      host: 'www.coles.com.au',
      adapterIds: ['coles'],
      breaker: 'open',
      retryAt: new Date(now + 3 * 60_000 + 58_000).toISOString(),
      cause: 'blocked-by-site',
      lastOpenedAt: ago(4),
      nextCooldownSeconds: 1200,
    },
    {
      host: 'www.woolworths.com.au',
      adapterIds: ['woolworths'],
      breaker: 'closed',
      retryAt: null,
      cause: null,
      lastOpenedAt: ago(350),
      nextCooldownSeconds: 1800,
    },
  ]

  let runs: RunSummary[] = [
    run('c_9a71d0', 'woolworths', 'Woolworths', 'get_cart', 'read', 'claude-code', 1, 6104, 'needsUser', {
      needsUser: 'captcha',
    }),
    run('c_1c55e2', 'coles', 'Coles', 'get_trolley', 'read', 'claude-ai', 4, 812, 'blocked', {
      stage: 'tool-run',
      errorClass: 'blocked-by-site',
    }),
    run('c_8f2e1b', 'woolworths', 'Woolworths', 'update_cart_line', 'write', 'claude-code', 17, 5194, 'ok', {
      blockedRequests: 2,
    }),
    run('c_7b0c44', 'woolworths', 'Woolworths', 'search_products', 'read', 'claude-code', 18, 1420, 'ok'),
    run('c_5e1f20', 'woolworths', 'Woolworths', 'add_to_cart', 'write', 'claude-code', 36, 2210, 'ok'),
    run('c_2a8f10', 'woolworths', 'Woolworths', 'get_cart', 'read', 'claude-ai', 350, 902, 'blocked', {
      stage: 'tool-run',
      errorClass: 'blocked-by-site',
    }),
    run(
      'c_3d19e7',
      'woolworths',
      'Woolworths',
      'remove_from_cart',
      'write',
      'claude-code',
      2 * 24 * 60 + 208,
      120_400,
      'declined',
      {
        stage: 'confirm',
        errorClass: 'declined',
      },
    ),
  ]

  let attention: AttentionItem[] = [
    {
      kind: 'needs-user',
      id: 'nu_woolworths',
      adapterId: 'woolworths',
      adapterName: 'Woolworths',
      reason: 'captcha',
      note: 'Auth0 showed a challenge after the password page.',
      startedBy: 'call',
      tool: 'get_cart',
      client: 'claude-code',
      callId: 'c_9a71d0',
      at: ago(1),
      filled: [
        { secret: 'login', field: 'username' },
        { secret: 'login', field: 'password' },
      ],
      filledOrigin: WOW_AUTH,
      navigation: [WOW_WWW, WOW_AUTH],
      windowOpen: true,
      closesAt: inMinutes(4),
    },
    {
      kind: 'confirmation',
      id: 'cf_a40f3c',
      adapterId: 'woolworths',
      adapterName: 'Woolworths',
      adapterVersion: '0.3.0',
      adapterHash: WOOLWORTHS_HASH,
      approvedAt: woolworthsBase.approvedAt,
      tool: 'remove_from_cart',
      toolTitle: 'Remove from cart',
      sideEffect: 'write',
      trigger: 'tool-request',
      client: 'claude-code',
      clientTransport: 'stdio',
      callId: 'c_a40f3c',
      requestedAt: ago(0.15),
      expiresAt: new Date(now + 112_000).toISOString(),
      requestCeiling: 6,
      unlocks: [],
      requests: [{ method: 'POST', path: '/api/v3/ui/trolley/update', purpose: 'write' }],
      input: [{ kind: 'text', text: '{ "stockcode": 133211 }' }],
      adapterNote: 'Remove Cavendish Bananas (2 × $0.79) from the trolley?',
    },
    {
      kind: 'review',
      id: 'rv_woolworths',
      adapterId: 'woolworths',
      adapterName: 'Woolworths',
      version: '0.4.0',
      addsPermissions: true,
    },
  ]

  let clients: ClientInfo[] = [
    {
      id: 'c_c7d2a1b2c3d4e5f6',
      name: 'Claude Code',
      addedAt: ago(10 * 24 * 60),
      accessResetAt: null,
      reportedName: 'claude-code',
      transport: 'stdio',
      lastSeen: ago(1),
      calls7d: 141,
      revokedAt: null,
    },
    {
      id: 'c_41e9a1b2c3d4e5f6',
      name: 'Claude Desktop',
      addedAt: ago(8 * 24 * 60),
      accessResetAt: ago(2 * 24 * 60),
      reportedName: 'claude-ai',
      transport: 'stdio',
      lastSeen: ago(4),
      calls7d: 28,
      revokedAt: null,
    },
    {
      id: 'c_0b5aa1b2c3d4e5f6',
      name: 'Cursor',
      addedAt: ago(20 * 24 * 60),
      accessResetAt: null,
      reportedName: 'cursor',
      transport: 'http',
      lastSeen: ago(5 * 24 * 60),
      calls7d: 0,
      revokedAt: ago(4 * 24 * 60),
    },
  ]

  let endpoint: EndpointStatus = {
    listening: true,
    url: 'http://127.0.0.1:47821/mcp',
    connectedClients: 2,
  }

  let settings: Settings = {
    updateChannel: 'stable',
    autoInstallUpdates: true,
    launchAtLogin: true,
    opPath: null,
    messagesOtpEnabled: false,
    onePasswordAccount: null,
  }

  const updates: UpdateStatus = {
    current: '0.1.0',
    state: 'up-to-date',
    available: null,
    checkedAt: ago(96),
    signed: true,
    disabledReason: null,
  }

  let app: AppStatus = { paused: false, version: '0.1.0', demo: false }
  let chosenOpPath: string | null = '/opt/homebrew/bin/op'
  let setup: SetupStatus = { completedAt: ago(10 * 24 * 60) }
  const providerAvailable = new Map<ProviderKind, boolean>([
    ['onepassword-service-account', true],
    ['onepassword-cli', true],
  ])

  if (options.firstRun === true) {
    // The bundled adapter as a first launch finds it: installed, never approved, its whole manifest
    // under review. Nothing else exists yet.
    adapters.delete('coles')
    const firstHash = WOOLWORTHS_NEXT_HASH
    adapters.set('woolworths', {
      ...woolworthsBase,
      approval: 'unapproved',
      approvedAt: null,
      calls7d: 0,
      tools: woolworthsBase.tools.map((t) => ({ ...t, calls7d: 0 })),
      session: { state: 'unknown', checkedAt: null, needsUser: null, since: null },
    })
    const all = <T>(added: readonly T[]) => ({ added: [...added], removed: [], unchanged: [] })
    const login = woolworthsBase.secretRequests[0]
    reviews = [
      {
        adapterId: 'woolworths',
        name: 'Woolworths',
        site: 'woolworths.com.au',
        from: null,
        to: { version: woolworthsBase.version, hash: firstHash },
        submittedAt: ago(1),
        source: 'import',
        diff: {
          navigation: all(woolworthsBase.navigation),
          frameOrigins: all([]),
          egress: all(woolworthsBase.egress),
          cookieDomains: all(woolworthsBase.cookieDomains),
          storage: all([]),
          requests: all(WOOLWORTHS_REQUESTS),
          tools: all(
            woolworthsBase.tools.map(({ name, title, sideEffect }) => ({ name, title, sideEffect })),
          ),
          secrets: all(
            login === undefined
              ? []
              : [
                  {
                    name: login.name,
                    description: login.description,
                    fields: login.fields,
                    origins: login.origins,
                  },
                ],
          ),
          secretFills: all([
            { selector: 'input[name=username]', secret: 'login', field: 'username' as const },
            { selector: 'input#password', secret: 'login', field: 'password' as const },
          ]),
          authSteps: all(WOOLWORTHS_AUTH_STEPS),
          messagesSources: all([]),
          limits: null,
          probe: null,
        },
        manifestDiff: [],
        files: [],
      },
    ]
    attention = [
      {
        kind: 'review',
        id: 'rv_woolworths',
        adapterId: 'woolworths',
        adapterName: 'Woolworths',
        version: woolworthsBase.version,
        addsPermissions: true,
      },
    ]
    grants = []
    clients = []
    runs = []
    setup = { completedAt: null }
    providerAvailable.set('onepassword-service-account', false)
    providerAvailable.set('onepassword-cli', false)
  }

  const audit: AuditRecord[] = buildAudit(ago)
  /** The last verification, as the main process keeps it: launch verified the chain as it was then. */
  let lastVerified: ChainStatus = chainStatus()

  // ---------- Derived views ----------

  const grantFor = (adapterId: string, hash: string, secret: string): GrantInfo | null =>
    grants.find((g) => g.adapterId === adapterId && g.adapterHash === hash && g.secret === secret) ?? null

  const detailOf = (base: AdapterDetail): AdapterDetail => {
    const secretRequests = base.secretRequests.map((s) => ({
      ...s,
      grant: grantFor(base.id, base.hash, s.name),
    }))
    // One messages grant per adapter hash, as core keeps them: it belongs to the sender it names only.
    const messagesGrant = grantFor(base.id, base.hash, 'messages')
    const messages = base.messages.map((m) => ({
      ...m,
      grant: messagesGrant !== null && messagesGrant.itemId === m.sender ? messagesGrant : null,
    }))
    return {
      ...base,
      secretRequests,
      messages,
      secrets: secretRequests.map((s) => ({ name: s.name, granted: s.grant !== null })),
      messagesSources: messages.map((m) => ({ sender: m.sender, granted: m.grant !== null })),
      pendingUpdate: reviews.find((r) => r.adapterId === base.id)?.to ?? null,
    }
  }

  const summaryOf = (detail: AdapterDetail): AdapterSummary => ({
    id: detail.id,
    name: detail.name,
    site: detail.site,
    version: detail.version,
    hash: detail.hash,
    approval: detail.approval,
    pendingUpdate: detail.pendingUpdate,
    toolCounts: detail.toolCounts,
    secrets: detail.secrets,
    messagesSources: detail.messagesSources,
    session: detail.session,
    calls7d: detail.calls7d,
  })

  // ---------- The API ----------

  const api: FakeApi = {
    adapters: {
      async list() {
        enter('adapters.list')
        return clone([...adapters.values()].map((a) => summaryOf(detailOf(a))))
      },
      async get(adapterId) {
        enter('adapters.get', adapterId)
        const base = adapters.get(adapterId)
        return base === undefined ? null : clone(detailOf(base))
      },
    },
    approvals: {
      async pending() {
        enter('approvals.pending')
        return clone(reviews)
      },
      async approve(adapterId, hash) {
        enter('approvals.approve', adapterId, hash)
        const review = reviews.find((r) => r.adapterId === adapterId)
        if (review === undefined || review.to.hash !== hash) throw new Error('stale review')
        const base = adapters.get(adapterId)
        if (base !== undefined) {
          adapters.set(adapterId, {
            ...base,
            version: review.to.version,
            hash: review.to.hash,
            approval: 'approved',
            approvedAt: new Date(now).toISOString(),
            egress: [...review.diff.egress.unchanged, ...review.diff.egress.added],
          })
        }
        reviews = reviews.filter((r) => r !== review)
        attention = attention.filter((a) => !(a.kind === 'review' && a.adapterId === adapterId))
        emit({ type: 'approvals-changed' })
        emit({ type: 'adapters-changed' })
        emit({ type: 'attention-changed' })
      },
      async reject(adapterId, hash) {
        enter('approvals.reject', adapterId, hash)
        const review = reviews.find((r) => r.adapterId === adapterId)
        if (review === undefined || review.to.hash !== hash) throw new Error('stale review')
        reviews = reviews.filter((r) => r !== review)
        attention = attention.filter((a) => !(a.kind === 'review' && a.adapterId === adapterId))
        emit({ type: 'approvals-changed' })
        emit({ type: 'adapters-changed' })
        emit({ type: 'attention-changed' })
      },
    },
    grants: {
      async list() {
        enter('grants.list')
        return clone(grants)
      },
      async providers() {
        enter('grants.providers')
        const count = (kind: ProviderKind) => grants.filter((g) => g.provider === kind).length
        const list: ProviderStatus[] = [
          {
            kind: 'onepassword-service-account',
            available: providerAvailable.get('onepassword-service-account') === true,
            unavailableReason:
              providerAvailable.get('onepassword-service-account') === true ? null : 'not-configured',
            grantCount: count('onepassword-service-account'),
          },
          {
            kind: 'onepassword-cli',
            available: providerAvailable.get('onepassword-cli') === true,
            unavailableReason: providerAvailable.get('onepassword-cli') === true ? null : 'not-installed',
            grantCount: count('onepassword-cli'),
          },
          {
            kind: 'messages',
            available: settings.messagesOtpEnabled,
            unavailableReason: settings.messagesOtpEnabled ? null : 'disabled',
            grantCount: count('messages'),
          },
          {
            // As the main process has it: ready once the person names their 1Password account (D6).
            kind: 'keychain-copy',
            available: settings.onePasswordAccount !== null,
            unavailableReason: settings.onePasswordAccount !== null ? null : 'not-configured',
            grantCount: count('keychain-copy'),
          },
        ]
        return list
      },
      async vaultItems(provider) {
        enter('grants.vaultItems', provider)
        return provider === 'messages' ? [] : clone(vault)
      },
      async make(request: GrantRequest) {
        enter('grants.make', request)
        const base = adapters.get(request.adapterId)
        if (base === undefined || base.hash !== request.adapterHash)
          throw new Error('unknown adapter or hash')
        const requested =
          request.provider === 'messages'
            ? base.messages.find((m) => m.sender === request.itemRef)?.requestedOrigins
            : base.secretRequests.find((s) => s.name === request.secret)?.origins
        if (requested === undefined) throw new Error('not requested')
        if (request.origins.length === 0 || request.origins.some((o) => !requested.includes(o))) {
          throw new Error('origins not requested')
        }
        const title =
          request.provider === 'messages'
            ? request.itemRef
            : vault.find((v) => v.id === request.itemRef)?.title
        if (title === undefined) throw new Error('no such item')
        grants = [
          ...grants.filter(
            (g) =>
              !(
                g.adapterId === request.adapterId &&
                g.adapterHash === request.adapterHash &&
                g.secret === request.secret
              ),
          ),
          {
            adapterId: request.adapterId,
            adapterHash: request.adapterHash,
            secret: request.secret,
            provider: request.provider,
            itemId: request.itemRef,
            itemTitle: title,
            origins: [...request.origins],
            grantedAt: new Date(now).toISOString(),
            lastUsedAt: null,
          },
        ]
        emit({ type: 'grants-changed' })
        emit({ type: 'adapters-changed' })
      },
      async resync(adapterId, secret) {
        enter('grants.resync', adapterId, secret)
        emit({ type: 'grants-changed' })
      },
      async revoke(adapterId, secret) {
        enter('grants.revoke', adapterId, secret)
        grants = grants.filter((g) => !(g.adapterId === adapterId && g.secret === secret))
        emit({ type: 'grants-changed' })
        emit({ type: 'adapters-changed' })
      },
    },
    runs: {
      async list(query = {}) {
        enter('runs.list', query)
        const matching = runs.filter((r) => query.adapterId === undefined || r.adapterId === query.adapterId)
        return clone(matching.slice(0, query.limit ?? 100))
      },
      async trace(callId) {
        enter('runs.trace', callId)
        const summary = runs.find((r) => r.callId === callId)
        return summary === undefined ? null : clone(traceOf(summary, adapters))
      },
      async statsToday() {
        enter('runs.statsToday')
        const stats: RunStats = {
          toolCalls: 37,
          logins: 3,
          loginsFailed: 0,
          blockedRequests: 12,
          hourly: {
            toolCalls: [1, 2, 0, 3, 2, 4, 1, 6, 7],
            logins: [0, 0, 1, 0, 0, 1, 0, 0, 1],
            blockedRequests: [1, 2, 0, 3, 1, 2, 0, 2, 1],
          },
        }
        return stats
      },
    },
    audit: {
      async page(query: AuditQuery) {
        enter('audit.page', query)
        const matching = audit
          .filter((r) => matchesAudit(r, query))
          .sort((a, b) => b.seq - a.seq)
          .filter((r) => query.beforeSeq === undefined || r.seq < query.beforeSeq)
        const limit = query.limit ?? 50
        const records = matching.slice(0, limit)
        const last = records[records.length - 1]
        return clone({
          records,
          total: 4813,
          nextBeforeSeq: matching.length > limit && last !== undefined ? last.seq : null,
        })
      },
      async verify() {
        enter('audit.verify')
        lastVerified = chainStatus()
        emit({ type: 'audit-verified' })
        return clone(lastVerified)
      },
      async chainStatus() {
        enter('audit.chainStatus')
        return clone(lastVerified)
      },
      async exportJsonl() {
        enter('audit.exportJsonl')
      },
    },
    endpoint: {
      async status() {
        enter('endpoint.status')
        return clone(endpoint)
      },
      async setListening(listening) {
        enter('endpoint.setListening', listening)
        endpoint = {
          ...endpoint,
          listening,
          url: listening ? 'http://127.0.0.1:47821/mcp' : null,
          connectedClients: listening ? 2 : 0,
        }
        emit({ type: 'endpoint-changed' })
      },
      async copyUrl() {
        enter('endpoint.copyUrl')
      },
    },
    clients: {
      async list() {
        enter('clients.list')
        return clone(clients)
      },
      async add(name) {
        enter('clients.add', name)
        const client: ClientInfo = {
          id: `c_${(clients.length + 1).toString(16).padStart(16, '0')}`,
          name: name.trim().slice(0, 60),
          addedAt: new Date(now).toISOString(),
          accessResetAt: null,
          reportedName: null,
          transport: null,
          lastSeen: null,
          calls7d: 0,
          revokedAt: null,
        }
        clients = [...clients, client]
        emit({ type: 'clients-changed' })
        return clone(client)
      },
      async resetAccess(clientId) {
        enter('clients.resetAccess', clientId)
        clients = clients.map((c) =>
          c.id === clientId ? { ...c, accessResetAt: new Date(now).toISOString() } : c,
        )
        emit({ type: 'clients-changed' })
      },
      async snippets(clientId) {
        enter('clients.snippets', clientId)
        const bridge = '/Applications/Valet.app/Contents/MacOS/valet-bridge'
        const config = `~/Library/Application Support/valet/client-configs/${clientId}.json`
        const list: ClientSnippet[] = [
          { client: 'claude-code', text: `claude mcp add valet -- \\\n  ${bridge} \\\n  '${config}'` },
          {
            client: 'claude-desktop',
            text: `{ "mcpServers": { "valet": { "command":\n  "${bridge}",\n  "args": ["${config}"]\n} } }`,
          },
        ]
        return list
      },
      async copyConfig(clientId, kind) {
        enter('clients.copyConfig', clientId, kind)
      },
      async revoke(clientId) {
        enter('clients.revoke', clientId)
        clients = clients.map((c) =>
          c.id === clientId ? { ...c, revokedAt: new Date(now).toISOString() } : c,
        )
        emit({ type: 'clients-changed' })
      },
    },
    attention: {
      async list() {
        enter('attention.list')
        return clone(attention)
      },
    },
    async answerConfirmation(confirmationId, approved) {
      enter('answerConfirmation', confirmationId, approved)
      const item = attention.find(
        (a): a is ConfirmationItem => a.kind === 'confirmation' && a.id === confirmationId,
      )
      if (item === undefined) throw new Error('no such confirmation')
      attention = attention.filter((a) => a !== item)
      runs = [
        run(
          item.callId,
          item.adapterId,
          item.adapterName,
          item.tool,
          item.sideEffect,
          item.client,
          0,
          2400,
          approved ? 'ok' : 'declined',
        ),
        ...runs,
      ]
      emit({ type: 'attention-changed' })
      emit({ type: 'runs-changed' })
    },
    async openLoginWindow(adapterId) {
      enter('openLoginWindow', adapterId)
    },
    async finishLogin(adapterId) {
      enter('finishLogin', adapterId)
      attention = attention.filter((a) => !(a.kind === 'needs-user' && a.adapterId === adapterId))
      const base = adapters.get(adapterId)
      if (base !== undefined) {
        adapters.set(adapterId, {
          ...base,
          session: {
            state: 'logged-in',
            checkedAt: new Date(now).toISOString(),
            needsUser: null,
            since: null,
          },
        })
      }
      emit({ type: 'attention-changed' })
      emit({ type: 'adapters-changed' })
    },
    async closeLoginWindow(adapterId) {
      enter('closeLoginWindow', adapterId)
      attention = attention.map((a) =>
        a.kind === 'needs-user' && a.adapterId === adapterId ? { ...a, windowOpen: false } : a,
      )
      emit({ type: 'attention-changed' })
    },
    settings: {
      async get() {
        enter('settings.get')
        return clone(settings)
      },
      async set(patch) {
        enter('settings.set', patch)
        // As the main process does: keys outside SettingsPatch are dropped, opPath above all.
        const { updateChannel, autoInstallUpdates, launchAtLogin, messagesOtpEnabled, onePasswordAccount } =
          patch
        const known = {
          updateChannel,
          autoInstallUpdates,
          launchAtLogin,
          messagesOtpEnabled,
          onePasswordAccount,
        }
        settings = {
          ...settings,
          ...Object.fromEntries(Object.entries(known).filter(([, v]) => v !== undefined)),
        }
        emit({ type: 'settings-changed' })
        return clone(settings)
      },
      async chooseOpPath() {
        enter('settings.chooseOpPath')
        if (chosenOpPath !== null) {
          settings = { ...settings, opPath: chosenOpPath }
          emit({ type: 'settings-changed' })
        }
        return clone(settings)
      },
      async clearOpPath() {
        enter('settings.clearOpPath')
        settings = { ...settings, opPath: null }
        emit({ type: 'settings-changed' })
        return clone(settings)
      },
    },
    updates: {
      async status() {
        enter('updates.status')
        return clone(updates)
      },
      async check() {
        enter('updates.check')
      },
    },
    health: {
      async sites() {
        enter('health.sites')
        return clone(breakers)
      },
    },
    setup: {
      async status() {
        enter('setup.status')
        return clone(setup)
      },
      async finish() {
        enter('setup.finish')
        if (setup.completedAt === null) setup = { completedAt: new Date(now).toISOString() }
        emit({ type: 'app-changed' })
        return clone(setup)
      },
    },
    app: {
      async status() {
        enter('app.status')
        return clone(app)
      },
      async setPaused(paused) {
        enter('app.setPaused', paused)
        app = { ...app, paused }
        emit({ type: 'app-changed' })
      },
      async openControlPanel(route) {
        enter('app.openControlPanel', route)
      },
      async copyText(text) {
        enter('app.copyText', text)
      },
      async quit() {
        enter('app.quit')
      },
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    fake: {
      emit,
      breakChainAt(seq) {
        brokenAt = seq
      },
      setPendingReview(review) {
        reviews = [...reviews.filter((r) => r.adapterId !== review.adapterId), review]
        emit({ type: 'approvals-changed' })
      },
      failNext(method) {
        failing.add(method)
      },
      appendAudit(event) {
        const head = audit.reduce((a, b) => (b.seq > a.seq ? b : a))
        const seq = head.seq + 1
        const record: AuditRecord = {
          seq,
          at: new Date(now).toISOString(),
          event,
          prev: head.hash,
          hash: fakeHash(`${seq}:${head.hash}`),
        }
        audit.push(record)
        emit({ type: 'audit-appended', seq })
        return clone(record)
      },
      chooseOpPathResult(path) {
        chosenOpPath = path
      },
      setProviderAvailable(kind, available) {
        providerAvailable.set(kind, available)
        emit({ type: 'grants-changed' })
      },
      clientSeen(clientId) {
        clients = clients.map((c) =>
          c.id === clientId ? { ...c, lastSeen: new Date(now).toISOString() } : c,
        )
        emit({ type: 'clients-changed' })
      },
      calls,
    },
  }

  function chainStatus(): ChainStatus {
    const verifiedAt = new Date(now).toISOString()
    if (brokenAt !== null) return { state: 'broken', records: 4813, firstBadSeq: brokenAt, verifiedAt }
    const head = audit.reduce((a, b) => (b.seq > a.seq ? b : a))
    // Verification covers what was written when it ran; records appended since stay unchecked.
    return { state: 'intact', records: 4813, headSeq: head.seq, headHash: head.hash, verifiedAt }
  }

  function run(
    callId: string,
    adapterId: string,
    adapterName: string,
    tool: string,
    sideEffect: RunSummary['sideEffect'],
    client: string,
    minutesAgo: number,
    durationMs: number,
    outcome: RunSummary['outcome'],
    extra: Partial<Pick<RunSummary, 'needsUser' | 'stage' | 'errorClass' | 'blockedRequests'>> = {},
  ): RunSummary {
    return {
      callId,
      adapterId,
      adapterName,
      tool,
      sideEffect,
      client,
      startedAt: ago(minutesAgo),
      durationMs,
      outcome,
      needsUser: extra.needsUser ?? null,
      stage: extra.stage ?? null,
      errorClass: extra.errorClass ?? null,
      blockedRequests: extra.blockedRequests ?? 0,
    }
  }

  return api
}

const CATEGORY_TYPES: Readonly<Record<AuditCategory, readonly AuditEvent['type'][]>> = {
  'tool-calls': ['tool-called', 'tool-finished'],
  logins: ['login-started', 'login-finished'],
  'secret-use': ['secret-used'],
  blocked: ['request-blocked', 'breaker-opened', 'breaker-closed'],
  confirmations: ['confirmation'],
  'approvals-grants': [
    'adapter-approved',
    'adapter-rejected',
    'grant-made',
    'grant-revoked',
    'grant-copied',
    'update-downloaded',
    'update-installed',
    'remote-state',
    'remote-tool',
  ],
}

function matchesAudit(record: AuditRecord, query: AuditQuery): boolean {
  const event = record.event
  if (query.category !== undefined && !CATEGORY_TYPES[query.category].includes(event.type)) return false
  if (query.adapterId !== undefined && 'adapterId' in event && event.adapterId !== query.adapterId)
    return false
  if (query.client !== undefined && !('client' in event && event.client === query.client)) return false
  if (query.clientId !== undefined && !('clientId' in event && event.clientId === query.clientId))
    return false
  if (query.search !== undefined && query.search.length > 0) {
    const needle = query.search.toLowerCase()
    if (!JSON.stringify(event).toLowerCase().includes(needle)) return false
  }
  return true
}

/** A plausible chain: each record's prev is the record before's hash. Not real sha256. */
function buildAudit(ago: (minutes: number) => string): AuditRecord[] {
  const events: [number, number, AuditEvent][] = [
    [
      4431,
      5 * 24 * 60 + 107,
      {
        type: 'adapter-approved',
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_HASH,
        version: '0.3.0',
        previousHash: null,
      },
    ],
    [
      4433,
      5 * 24 * 60 + 106,
      {
        type: 'grant-made',
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_HASH,
        secret: 'login',
        provider: 'onepassword-service-account',
        origins: [WOW_AUTH],
      },
    ],
    [
      4612,
      2 * 24 * 60 + 208,
      {
        type: 'confirmation',
        adapterId: 'woolworths',
        tool: 'remove_from_cart',
        client: 'claude-code',
        callId: 'c_3d19e7',
        answer: 'declined',
      },
    ],
    [
      4790,
      350,
      {
        type: 'breaker-opened',
        host: 'www.woolworths.com.au',
        cause: 'blocked-by-site',
        retryAt: ago(320),
        callId: 'c_2a8f10',
      },
    ],
    [4795, 320, { type: 'breaker-closed', host: 'www.woolworths.com.au' }],
    [
      4798,
      17,
      {
        type: 'tool-called',
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_HASH,
        tool: 'update_cart_line',
        client: 'claude-code',
        callId: 'c_8f2e1b',
      },
    ],
    [
      4799,
      16.95,
      {
        type: 'request-blocked',
        adapterId: 'woolworths',
        method: 'POST',
        target: 'https://www.woolworths.com.au/apis/ui/Trolley/Recommendations',
        reason: 'undeclared',
        initiator: 'tool',
        partition: 'tool',
        callId: 'c_8f2e1b',
      },
    ],
    [
      4800,
      16.9,
      {
        type: 'request-blocked',
        adapterId: 'woolworths',
        method: 'POST',
        target: 'https://collect.tealiumiq.com/event',
        reason: 'host-not-allowed',
        initiator: 'page',
        partition: 'tool',
        callId: 'c_8f2e1b',
      },
    ],
    [
      4801,
      16.88,
      { type: 'tool-finished', adapterId: 'woolworths', callId: 'c_8f2e1b', outcome: 'ok', durationMs: 5194 },
    ],
    [
      4805,
      4,
      {
        type: 'breaker-opened',
        host: 'www.coles.com.au',
        cause: 'blocked-by-site',
        retryAt: ago(-4),
        callId: 'c_1c55e2',
      },
    ],
    [
      4808,
      1.1,
      {
        type: 'tool-called',
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_HASH,
        tool: 'get_cart',
        client: 'claude-code',
        callId: 'c_9a71d0',
      },
    ],
    [4809, 1.08, { type: 'login-started', adapterId: 'woolworths', callId: 'c_9a71d0' }],
    [
      4810,
      1.06,
      {
        type: 'secret-used',
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_HASH,
        secret: 'login',
        field: 'username',
        origin: WOW_AUTH,
        callId: 'c_9a71d0',
      },
    ],
    [
      4811,
      1.04,
      {
        type: 'secret-used',
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_HASH,
        secret: 'login',
        field: 'password',
        origin: WOW_AUTH,
        callId: 'c_9a71d0',
      },
    ],
    [
      4812,
      1.0,
      { type: 'login-finished', adapterId: 'woolworths', outcome: 'needsUser', needsUser: 'captcha' },
    ],
    [
      4813,
      1.0,
      {
        type: 'tool-finished',
        adapterId: 'woolworths',
        callId: 'c_9a71d0',
        outcome: 'needsUser',
        needsUser: 'captcha',
        durationMs: 6104,
      },
    ],
  ]
  let prev = '2a904d8dbc74254770f58904dba41ecccc3fc1626e53a13043b026c48bbfc14e'
  return events.map(([seq, minutesAgo, event]) => {
    const hash = fakeHash(`${seq}:${prev}`)
    const record: AuditRecord = { seq, at: ago(minutesAgo), event, prev, hash }
    prev = hash
    return record
  })
}

/** A deterministic 64-hex string. Display only; the real chain uses sha256 in the main process. */
function fakeHash(input: string): string {
  let out = ''
  let state = 2166136261
  for (let round = 0; out.length < 64; round++) {
    for (const char of `${input}#${round}`) {
      state ^= char.charCodeAt(0)
      state = Math.imul(state, 16777619) >>> 0
    }
    out += state.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

function step(atMs: number, durationMs: number | null, stage: TraceStep['stage'], rest: object): TraceStep {
  return { atMs, durationMs, stage, ...rest } as TraceStep
}

const text = (t: string): PreviewPart => ({ kind: 'text', text: t })

/** The full trace for the worked example, a short generic one for every other run. */
function traceOf(summary: RunSummary, adapters: ReadonlyMap<string, AdapterDetail>): RunTrace {
  const adapter = adapters.get(summary.adapterId)
  const version = adapter?.version ?? '0.0.0'
  const hash = adapter?.hash ?? ''
  if (summary.callId === 'c_8f2e1b') {
    return {
      summary,
      adapterVersion: '0.3.0',
      adapterHash: WOOLWORTHS_HASH,
      secretsUsed: [
        { secret: 'login', field: 'username' },
        { secret: 'login', field: 'password' },
      ],
      requests: { sent: 4, probes: 2, blocked: 2 },
      steps: [
        step(0, null, 'tool-input', { type: 'called', client: 'claude-code', sideEffect: 'write' }),
        step(4, 212, 'probe', {
          type: 'probe',
          partition: 'tool',
          path: '/api/ui/v2/bootstrap',
          status: 200,
          loggedIn: false,
          afterHandoff: false,
        }),
        step(220, 2940, 'login', { type: 'login-started' }),
        step(221, 1100, 'navigate', {
          type: 'auth-step',
          op: 'goto',
          detail: 'goto(https://www.woolworths.com.au/auth/login)',
          skipped: false,
        }),
        step(1322, 180, 'auth-step', {
          type: 'auth-step',
          op: 'waitFor',
          detail: 'waitFor(visible input[name=username])',
          skipped: false,
        }),
        step(1502, 640, 'secret-fill', {
          type: 'secret-fill',
          selector: 'input[name=username]',
          secret: 'login',
          field: 'username',
          origin: WOW_AUTH,
          checks: ['frame-origin', 'input-type', 'paced-keystrokes'],
        }),
        step(2143, 520, 'secret-fill', {
          type: 'secret-fill',
          selector: 'input#password',
          secret: 'login',
          field: 'password',
          origin: WOW_AUTH,
          checks: ['frame-origin', 'input-type', 'form-action'],
        }),
        step(2664, 30, 'auth-step', {
          type: 'auth-step',
          op: 'when',
          detail: 'when(textPresent "Remember this device")',
          skipped: true,
        }),
        step(2694, 464, 'auth-step', {
          type: 'auth-step',
          op: 'waitFor',
          detail: 'waitFor(urlContains "/shop")',
          skipped: false,
        }),
        step(3162, 9, 'session-handoff', {
          type: 'handoff',
          cookies: 14,
          storageKeys: 0,
          cookieDomains: ['woolworths.com.au', 'www.woolworths.com.au'],
        }),
        step(3171, 402, 'probe', {
          type: 'probe',
          partition: 'tool',
          path: '/api/ui/v2/bootstrap',
          status: 200,
          loggedIn: true,
          afterHandoff: true,
        }),
        step(3573, 1620, 'tool-run', { type: 'tool-code' }),
        step(3704, 412, 'request-surface', {
          type: 'request',
          method: 'GET',
          target: '/apis/ui/Trolley',
          initiator: 'tool',
          decision: 'allowed',
          purpose: 'read',
          status: 200,
          blockedReason: null,
        }),
        step(4122, 0, 'request-surface', {
          type: 'request',
          method: 'POST',
          target: '/apis/ui/Trolley/Recommendations',
          initiator: 'tool',
          decision: 'blocked',
          purpose: null,
          status: null,
          blockedReason: 'undeclared',
        }),
        step(4133, 0, 'egress', {
          type: 'request',
          method: 'POST',
          target: 'collect.tealiumiq.com/…',
          initiator: 'page',
          decision: 'blocked',
          purpose: null,
          status: null,
          blockedReason: 'host-not-allowed',
        }),
        step(4522, 566, 'request-surface', {
          type: 'request',
          method: 'POST',
          target: '/api/v3/ui/trolley/update',
          initiator: 'tool',
          decision: 'allowed',
          purpose: 'write',
          status: 200,
          blockedReason: null,
        }),
        step(5194, null, 'tool-output', { type: 'output', redactions: 2, bytes: 412 }),
      ],
      input: [text('{ "stockcode": 133211, "quantity": 2 }')],
      output: [
        text(
          '{\n  "items": [\n    { "name": "Cavendish Bananas", "qty": 2 },\n    { "name": "Full Cream Milk 3L", "qty": 1 },\n    { "name": "Helga\'s Wholemeal", "qty": 1 }\n  ],\n  "subtotal": 179.42,\n  "email": ',
        ),
        { kind: 'redacted', label: 'secret', ref: 'login.username' },
        text(',\n  "trackingId": '),
        { kind: 'redacted', label: 'session-cookie', ref: null },
        text('\n}'),
      ],
      outputBytes: 412,
    }
  }

  const steps: TraceStep[] = [
    step(0, null, 'tool-input', { type: 'called', client: summary.client, sideEffect: summary.sideEffect }),
  ]
  const duration = summary.durationMs ?? 0
  if (summary.outcome === 'blocked') {
    steps.push(
      step(3, duration - 3, 'tool-run', { type: 'tool-code' }),
      step(duration, null, 'tool-run', { type: 'failed', errorClass: 'blocked-by-site' }),
    )
  } else if (summary.outcome === 'needsUser') {
    steps.push(
      step(4, 220, 'probe', {
        type: 'probe',
        partition: 'tool',
        path: '/api/ui/v2/bootstrap',
        status: 200,
        loggedIn: false,
        afterHandoff: false,
      }),
      step(230, duration - 230, 'login', { type: 'login-started' }),
      step(duration, null, 'login', { type: 'needs-user', reason: summary.needsUser ?? 'other' }),
    )
  } else if (summary.outcome === 'declined') {
    steps.push(step(5, duration - 5, 'confirm', { type: 'confirmation', answer: 'declined' }))
  } else {
    steps.push(
      step(4, 180, 'probe', {
        type: 'probe',
        partition: 'tool',
        path: '/api/ui/v2/bootstrap',
        status: 200,
        loggedIn: true,
        afterHandoff: false,
      }),
      step(190, duration - 200, 'tool-run', { type: 'tool-code' }),
      step(duration, null, 'tool-output', { type: 'output', redactions: 0, bytes: 1830 }),
    )
  }
  return {
    summary,
    adapterVersion: version,
    adapterHash: hash,
    secretsUsed: [],
    requests: { sent: summary.outcome === 'ok' ? 2 : 0, probes: 1, blocked: summary.blockedRequests },
    steps,
    input: [text('{ "query": "bananas" }')],
    output: summary.outcome === 'ok' ? [text('{ "results": 24 }')] : null,
    outputBytes: summary.outcome === 'ok' ? 1830 : null,
  }
}
