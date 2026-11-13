import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineAdapter, tool } from '../src/adapter'
import {
  type AuthStep,
  hasLogin,
  homeUnreachable,
  type ManifestInput,
  manifestSchema,
  messagesSourcesIn,
  parseManifest,
  secretRefsIn,
  settingToolNames,
  toolHints,
} from '../src/manifest'
import { settingChoicesSchema, settingQuerySchema, settingValueSchema } from '../src/settings'

// A complete, valid manifest. Each test copies it with structuredClone and changes one thing.
const VALID: ManifestInput = {
  schemaVersion: 1,
  id: 'example-shop',
  name: 'Example Shop',
  version: '0.1.0',
  description: 'Search and cart for an example shop.',
  home: 'https://www.example.com/',
  navigation: ['https://www.example.com', 'https://login.example.com'],
  egress: ['www.example.com', '*.cdn.example.com'],
  secrets: {
    login: {
      description: 'Example Shop account',
      fields: ['username', 'password', 'otp'],
      origins: ['https://login.example.com'],
    },
  },
  session: {
    cookieDomains: ['www.example.com', '*.example.com'],
    probe: { kind: 'fetch', path: '/api/me', expectStatus: 200, jsonPath: 'loggedIn', equals: true },
  },
  auth: {
    steps: [
      { op: 'goto', url: 'https://login.example.com/' },
      { op: 'waitFor', condition: { visible: '#email' }, timeoutMs: 10_000 },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      { op: 'click', selector: 'button[type=submit]' },
      {
        op: 'when',
        condition: { visible: 'input[autocomplete=one-time-code]' },
        steps: [{ op: 'otp', selector: 'input[autocomplete=one-time-code]', source: { secret: 'login' } }],
        otherwise: [{ op: 'pause', ms: 500 }],
      },
      { op: 'assertLoggedIn' },
    ],
  },
  requests: [
    { method: 'GET', path: '/api/cart', purpose: 'read' },
    { method: 'POST', path: '/api/cart/update', purpose: 'write' },
  ],
  tools: [
    { name: 'get_cart', title: 'Get cart', description: 'Read the cart.', sideEffect: 'read' },
    { name: 'add_to_cart', title: 'Add to cart', description: 'Add an item.', sideEffect: 'write' },
  ],
}

function copy(): any {
  return structuredClone(VALID)
}

function issues(input: unknown): string[] {
  const result = manifestSchema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.message)
}

describe('manifestSchema', () => {
  it('accepts the valid manifest and applies defaults', () => {
    const manifest = parseManifest(VALID)
    expect(manifest.limits).toEqual({
      requestsPerRun: 50,
      minGapMs: 2000,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    })
    expect(manifest.session.storage).toEqual([])
    expect(manifest.auth.frameOrigins).toEqual([])
    expect(manifest.session.probe).toMatchObject({ loggedOutStatuses: [401] })
  })

  it('says when home’s host is off egress, since every call opens home first', () => {
    const input = copy()
    input.egress = ['api.example.net']
    expect(homeUnreachable(input as never)).toBe(
      "egress must allow www.example.com, home's host: every call opens home first",
    )
    input.egress = ['*.example.com']
    expect(homeUnreachable(input as never)).toBeNull()
    expect(homeUnreachable(VALID as never)).toBeNull()
  })

  it('says egress takes bare hostnames when given an origin', () => {
    const input = copy()
    input.egress = ['www.example.com', 'https://api.example.net']
    expect(issues(input).join('\n')).toMatch(/bare hostname such as api\.example\.com/)
  })

  it('takes a request host on an egress host, bare and lower-case', () => {
    const input = copy()
    input.egress = ['www.example.com', 'api.example.net']
    input.requests.push({ method: 'GET', host: 'api.example.net', path: '/v0/item/:id', purpose: 'read' })
    expect(parseManifest(input).requests.at(-1)).toMatchObject({ host: 'api.example.net' })
    for (const host of [
      'https://api.example.net',
      'API.example.net',
      '*.example.net',
      'api.example.net/v0',
    ]) {
      const bad = copy()
      bad.egress = ['www.example.com', 'api.example.net']
      bad.requests.push({ method: 'GET', host, path: '/v0', purpose: 'read' })
      expect(issues(bad).length, host).toBeGreaterThan(0)
    }
    const off = copy()
    off.requests.push({ method: 'GET', host: 'api.example.net', path: '/v0', purpose: 'read' })
    expect(issues(off)).toContain('GET api.example.net/v0: host api.example.net is not on an egress host')
  })

  it('returns an issue, not a TypeError, for a secret named after an Object.prototype property', () => {
    const input = copy()
    input.auth.steps[2].value = { secret: 'constructor', field: 'username' }
    expect(issues(input)).toContain('auth step uses undeclared secret constructor')
  })

  it('reserves the messages secret name for Messages OTP grants', () => {
    const input = copy()
    input.secrets.messages = { description: 'x', fields: ['otp'], origins: ['https://login.example.com'] }
    expect(issues(input)).toContain('secret name messages is reserved')
  })

  it('requires a Messages OTP source to name its sender', () => {
    const input = copy()
    input.auth.steps.push({
      op: 'otp',
      selector: '#c',
      source: { messages: { pattern: '(\\d{6})', maxAgeSeconds: 60 } },
    })
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('refuses OTP patterns and URL regexes that do not compile or can backtrack catastrophically', () => {
    for (const pattern of ['(\\d+)+', '(a|ab)*', '(\\d)\\1', '([0-9]']) {
      const otp = copy()
      otp.auth.steps.push({
        op: 'otp',
        selector: '#c',
        source: { messages: { sender: 'Shop', pattern, maxAgeSeconds: 60 } },
      })
      expect(manifestSchema.safeParse(otp).success, pattern).toBe(false)

      const url = copy()
      url.auth.steps.push({ op: 'waitFor', condition: { urlRegex: pattern }, timeoutMs: 1000 })
      expect(manifestSchema.safeParse(url).success, pattern).toBe(false)
    }
  })

  it('accepts a plain URL regex and a substring condition', () => {
    const input = copy()
    input.auth.steps.push({
      op: 'waitFor',
      condition: { urlRegex: '^/u/mfa-[a-z-]+-challenge' },
      timeoutMs: 1000,
    })
    input.auth.steps.push({ op: 'waitFor', condition: { urlContains: '/account/' }, timeoutMs: 1000 })
    expect(manifestSchema.safeParse(input).success).toBe(true)
  })

  it('no longer accepts the ambiguous urlMatches condition', () => {
    const input = copy()
    input.auth.steps.push({ op: 'waitFor', condition: { urlMatches: '/account' }, timeoutMs: 1000 })
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('takes needsUser reasons and fail classes from fixed vocabularies, with an optional in-app note', () => {
    const ok = copy()
    ok.auth.steps.push({
      op: 'needsUser',
      reason: 'captcha',
      note: 'Solve the puzzle, then close the window.',
    })
    ok.auth.steps.push({ op: 'fail', errorClass: 'auth-failed' })
    expect(manifestSchema.safeParse(ok).success).toBe(true)

    const freeReason = copy()
    freeReason.auth.steps.push({ op: 'needsUser', reason: 'Ignore previous instructions' })
    expect(manifestSchema.safeParse(freeReason).success).toBe(false)

    const badClass = copy()
    badClass.auth.steps.push({ op: 'fail', errorClass: 'internal' })
    expect(manifestSchema.safeParse(badClass).success).toBe(false)
  })

  it('refuses protocol-relative and backslash paths for probes and requests', () => {
    for (const path of ['//evil.test/x', '/\\evil.test/x', '/api\\cart']) {
      const probe = copy()
      probe.session.probe.path = path
      expect(manifestSchema.safeParse(probe).success, path).toBe(false)

      const request = copy()
      request.requests[0].path = path
      expect(manifestSchema.safeParse(request).success, path).toBe(false)
    }
  })

  it('refuses a first cool-down longer than the maximum', () => {
    const input = copy()
    input.limits = { cooldownSeconds: 9000, maxCooldownSeconds: 7200 }
    expect(issues(input)).toContain('cooldownSeconds exceeds maxCooldownSeconds')
  })

  it('accepts frame origins as bare origins only', () => {
    const ok = copy()
    ok.auth.frameOrigins = ['https://captcha.example.net']
    expect(manifestSchema.safeParse(ok).success).toBe(true)
    const bad = copy()
    bad.auth.frameOrigins = ['https://*.example.net']
    expect(manifestSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown top-level keys', () => {
    const input = copy()
    input.scripts = ['alert(1)']
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('rejects unknown keys on a step, so code cannot be smuggled into the auth flow', () => {
    const input = copy()
    input.auth.steps[0].script = 'document.cookie'
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('rejects unknown step ops', () => {
    const input = copy()
    input.auth.steps.push({ op: 'evaluate', source: 'fetch("https://evil.test")' })
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('rejects http goto targets', () => {
    const input = copy()
    input.auth.steps[0].url = 'http://login.example.com/'
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('rejects navigation entries that are not bare https origins', () => {
    const input = copy()
    input.navigation.push('https://www.example.com/login')
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('rejects egress entries that are not host patterns', () => {
    const input = copy()
    input.egress.push('https://evil.test')
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('rejects an auth flow that uses an undeclared secret', () => {
    const input = copy()
    input.auth.steps[2].value = { secret: 'other', field: 'username' }
    expect(issues(input)).toContain('auth step uses undeclared secret other')
  })

  it('rejects an auth flow that uses a field the secret does not request', () => {
    const input = copy()
    input.secrets.login.fields = ['username', 'password']
    expect(issues(input)).toContain('secret login does not request field otp')
  })

  it('rejects a secret origin outside navigation', () => {
    const input = copy()
    input.secrets.login.origins = ['https://elsewhere.example.com']
    expect(issues(input)).toContain('secret login origin https://elsewhere.example.com is not in navigation')
  })

  it('takes an optional https cart page on a navigation origin', () => {
    expect(parseManifest(copy()).cartUrl).toBeUndefined()
    const input = copy()
    input.cartUrl = 'https://www.example.com/cart'
    expect(parseManifest(input).cartUrl).toBe('https://www.example.com/cart')
    input.cartUrl = 'https://elsewhere.example.com/cart'
    expect(issues(input)).toContain(
      'cartUrl https://elsewhere.example.com/cart is not on a navigation origin',
    )
    input.cartUrl = 'http://www.example.com/cart'
    expect(issues(input)).not.toEqual([])
  })

  it('rejects duplicate tool names', () => {
    const input = copy()
    input.tools.push({ ...input.tools[0] })
    expect(issues(input)).toContain('duplicate tool get_cart')
  })

  it('lets only a write tool declare destructive and idempotent (C9)', () => {
    const write = copy()
    write.tools[1] = { ...write.tools[1], destructive: false, idempotent: true }
    expect(issues(write)).toEqual([])
    for (const sideEffect of ['read', 'irreversible']) {
      for (const key of ['destructive', 'idempotent']) {
        const input = copy()
        input.tools[0] = { ...input.tools[0], sideEffect, [key]: false }
        expect(issues(input)).toEqual([`only a write tool may set ${key}`])
      }
    }
    const typo = copy()
    typo.tools[1] = { ...typo.tools[1], destructive: 'no' }
    expect(issues(typo)).not.toEqual([])
  })

  it('lets only an irreversible tool name requests to unlock, and only declared irreversible ones (C15)', () => {
    const place = { method: 'POST', path: '/api/checkout/place' }
    const withPlace = () => {
      const input = copy()
      input.requests = [...(input.requests ?? []), { ...place, purpose: 'irreversible' }]
      return input
    }
    const ok = withPlace()
    ok.tools[0] = { ...ok.tools[0], sideEffect: 'irreversible', unlocks: [place] }
    expect(issues(ok)).toEqual([])
    expect(parseManifest(ok).tools[0]?.unlocks).toEqual([place])

    for (const sideEffect of ['read', 'write']) {
      const input = withPlace()
      input.tools[0] = { ...input.tools[0], sideEffect, unlocks: [place] }
      expect(issues(input)).toEqual(['only an irreversible tool may set unlocks'])
    }

    // Not declared at all, declared under another method, declared but not irreversible, and a
    // pattern wider than the declaration.
    const wrong = [
      { method: 'POST', path: '/api/payees/add' },
      { method: 'GET', path: '/api/checkout/place' },
      { method: ok.requests[0].method, path: ok.requests[0].path },
      { method: 'POST', path: '/api/checkout/*' },
    ]
    for (const unlock of wrong) {
      const input = withPlace()
      input.tools[0] = { ...input.tools[0], sideEffect: 'irreversible', unlocks: [unlock] }
      expect(issues(input)).toEqual([
        `tool ${input.tools[0].name} unlocks ${unlock.method} ${unlock.path}, which is not a declared irreversible request`,
      ])
    }

    const empty = withPlace()
    empty.tools[0] = { ...empty.tools[0], sideEffect: 'irreversible', unlocks: [] }
    expect(issues(empty)).not.toEqual([])
  })

  it('lets only a read be cached, and only a write fill the cache, never an irreversible request (D28)', () => {
    const read = { method: 'GET', path: '/api/basket', purpose: 'read', cacheSeconds: 120 }
    const write = { method: 'POST', path: '/api/basket/set', purpose: 'write', refreshes: '/api/basket' }
    const withRequests = (...requests: unknown[]) => {
      const input = copy()
      input.requests = requests
      return input
    }
    const ok = parseManifest(withRequests(read, write))
    expect(ok.requests).toEqual([read, write])
    // Neither field appears unless a manifest sets it.
    expect(Object.keys(parseManifest(VALID).requests[0] ?? {})).toEqual(['method', 'path', 'purpose'])

    for (const purpose of ['write', 'irreversible']) {
      expect(issues(withRequests({ ...read, purpose }))).toEqual([
        'GET /api/basket: only a read request may set cacheSeconds',
      ])
    }
    for (const purpose of ['read', 'irreversible']) {
      expect(issues(withRequests(read, { ...write, purpose }))).toEqual([
        'POST /api/basket/set: only a write request may set refreshes',
      ])
    }
    const badTarget =
      'POST /api/basket/set: refreshes must name a declared GET read on the same host, with cacheSeconds and no ":param" or "*"'
    // Not declared; declared without cacheSeconds; a POST; a pattern; an irreversible GET.
    expect(issues(withRequests(write))).toEqual([badTarget])
    expect(issues(withRequests({ method: 'GET', path: '/api/basket', purpose: 'read' }, write))).toEqual([
      badTarget,
    ])
    expect(issues(withRequests({ ...read, method: 'POST' }, write))).toEqual([badTarget])
    expect(issues(withRequests({ ...read, path: '/api/:id' }, { ...write, refreshes: '/api/:id' }))).toEqual([
      badTarget,
    ])
    expect(issues(withRequests({ ...read, purpose: 'irreversible' }, write))).toEqual([
      'GET /api/basket: only a read request may set cacheSeconds',
      badTarget,
    ])
    for (const cacheSeconds of [0, 3601, 1.5]) {
      expect(issues(withRequests({ ...read, cacheSeconds }))).not.toEqual([])
    }
  })

  it('bounds how long a fetch probe may be trusted, and gives a cookie probe no such field', () => {
    const trusting = copy()
    trusting.session.probe = { ...trusting.session.probe, trustSeconds: 60 }
    expect(parseManifest(trusting).session.probe).toMatchObject({ trustSeconds: 60 })
    expect(parseManifest(VALID).session.probe).not.toHaveProperty('trustSeconds')
    for (const trustSeconds of [-1, 301, 0.5]) {
      const input = copy()
      input.session.probe = { ...input.session.probe, trustSeconds }
      expect(issues(input)).not.toEqual([])
    }
    const cookie = copy()
    cookie.session.probe = { kind: 'cookie', name: 'sid', trustSeconds: 60 }
    expect(issues(cookie)).not.toEqual([])
  })

  it('takes an hourly request cap from 10 to 3600, and has none unless one is set', () => {
    expect(parseManifest(VALID).limits).not.toHaveProperty('requestsPerHour')
    const capped = copy()
    capped.limits = { requestsPerHour: 100 }
    expect(parseManifest(capped).limits.requestsPerHour).toBe(100)
    for (const requestsPerHour of [9, 3601, 60.5]) {
      const input = copy()
      input.limits = { requestsPerHour }
      expect(issues(input)).not.toEqual([])
    }
  })

  it('takes a per-minute cap from 1 to 240 and a jitter from 0 to 100 percent, both unset by default', () => {
    const limits = parseManifest(VALID).limits
    expect(limits).not.toHaveProperty('requestsPerMinute')
    expect(limits).not.toHaveProperty('gapJitterPercent')
    const set = copy()
    set.limits = { requestsPerMinute: 4, gapJitterPercent: 50 }
    expect(parseManifest(set).limits).toMatchObject({ requestsPerMinute: 4, gapJitterPercent: 50 })
    for (const bad of [
      { requestsPerMinute: 0 },
      { requestsPerMinute: 241 },
      { gapJitterPercent: -1 },
      { gapJitterPercent: 101 },
      { gapJitterPercent: 12.5 },
    ]) {
      const input = copy()
      input.limits = bad
      expect(issues(input)).not.toEqual([])
    }
  })

  it('bounds retry counts and pause lengths', () => {
    const tooManyRetries = copy()
    tooManyRetries.auth.steps.push({ op: 'retry', times: 50, steps: [{ op: 'pause', ms: 1 }] })
    expect(manifestSchema.safeParse(tooManyRetries).success).toBe(false)

    const longPause = copy()
    longPause.auth.steps.push({ op: 'pause', ms: 600_000 })
    expect(manifestSchema.safeParse(longPause).success).toBe(false)
  })

  it('accepts nested conditions', () => {
    const input = copy()
    input.auth.steps.push({
      op: 'waitFor',
      condition: {
        any: [{ urlContains: '/account' }, { all: [{ textPresent: 'Hi' }, { not: { visible: '#x' } }] }],
      },
      timeoutMs: 1000,
    })
    expect(manifestSchema.safeParse(input).success).toBe(true)
  })

  it('accepts a Messages OTP source with bounded age', () => {
    const input = copy()
    input.auth.steps.push({
      op: 'otp',
      selector: '#code',
      source: { messages: { sender: 'Example', pattern: '\\b(\\d{6})\\b', maxAgeSeconds: 120 } },
    })
    expect(manifestSchema.safeParse(input).success).toBe(true)
    input.auth.steps.at(-1).source.messages.maxAgeSeconds = 86_400
    expect(manifestSchema.safeParse(input).success).toBe(false)
  })

  it('accepts a cookie probe', () => {
    const input = copy()
    input.session.probe = { kind: 'cookie', name: 'session' }
    expect(manifestSchema.safeParse(input).success).toBe(true)
  })
})

describe('toolHints', () => {
  it('fills in the safe defaults: a write is destructive and not idempotent unless it says', () => {
    expect(toolHints({ sideEffect: 'write' })).toEqual({ destructive: true, idempotent: false })
    expect(toolHints({ sideEffect: 'write', destructive: false, idempotent: true })).toEqual({
      destructive: false,
      idempotent: true,
    })
  })

  it('fixes reads and irreversible tools whatever they claim', () => {
    expect(toolHints({ sideEffect: 'read', destructive: true })).toEqual({
      destructive: false,
      idempotent: true,
    })
    expect(toolHints({ sideEffect: 'irreversible', destructive: false, idempotent: true })).toEqual({
      destructive: true,
      idempotent: false,
    })
  })
})

describe('secretRefsIn', () => {
  it('finds refs in fills, otp steps and nested when/retry blocks', () => {
    const steps: AuthStep[] = [
      { op: 'fill', selector: '#u', value: { secret: 'a', field: 'username' } },
      { op: 'fill', selector: '#n', value: { literal: 'not a secret' } },
      {
        op: 'retry',
        times: 2,
        steps: [
          {
            op: 'when',
            condition: { visible: '#p' },
            steps: [{ op: 'fill', selector: '#p', value: { secret: 'b', field: 'password' } }],
            otherwise: [{ op: 'otp', selector: '#o', source: { secret: 'c' } }],
          },
        ],
      },
      {
        op: 'otp',
        selector: '#m',
        source: { messages: { sender: 'Example', pattern: '\\d+', maxAgeSeconds: 60 } },
      },
    ]
    expect(secretRefsIn(steps)).toEqual([
      { secret: 'a', field: 'username' },
      { secret: 'b', field: 'password' },
      { secret: 'c', field: 'otp' },
    ])
  })
})

describe('messagesSourcesIn', () => {
  it('finds Messages OTP sources in nested steps', () => {
    const source = { sender: 'Shop', pattern: '(\\d{6})', maxAgeSeconds: 120 }
    const steps: AuthStep[] = [
      { op: 'otp', selector: '#a', source: { secret: 'login' } },
      {
        op: 'when',
        condition: { visible: '#b' },
        steps: [{ op: 'otp', selector: '#b', source: { messages: source } }],
      },
    ]
    expect(messagesSourcesIn(steps)).toEqual([source])
  })
})

describe('defineAdapter', () => {
  const manifest = parseManifest(VALID)
  const getCart = tool({
    input: z.object({}),
    output: z.object({ items: z.array(z.string()) }),
    run: async () => ({ items: [] }),
  })

  it('accepts an adapter that implements exactly its declared tools', () => {
    const adapter = defineAdapter({ manifest, tools: { get_cart: getCart, add_to_cart: getCart } })
    expect(Object.keys(adapter.tools)).toEqual(['get_cart', 'add_to_cart'])
  })

  it('rejects a declared tool with no implementation', () => {
    expect(() => defineAdapter({ manifest, tools: { get_cart: getCart } })).toThrow(
      'tool add_to_cart is declared but not implemented',
    )
  })

  it('rejects an implementation with no declaration', () => {
    expect(() =>
      defineAdapter({ manifest, tools: { get_cart: getCart, add_to_cart: getCart, checkout: getCart } }),
    ).toThrow('tool checkout is implemented but not declared')
  })
})

describe('settings (D69)', () => {
  const store = {
    title: 'Store',
    description: 'The store whose prices the tools quote.',
    required: true,
    choices: { tool: 'find_stores', queryLabel: 'Postcode' },
    apply: { tool: 'apply_store' },
  }
  const withSettings = (change: (m: ManifestInput) => void = () => {}): ManifestInput => {
    const m = structuredClone(VALID)
    m.tools = [
      ...m.tools,
      { name: 'find_stores', title: 'Find stores', description: 'Stores', sideEffect: 'read' },
      { name: 'apply_store', title: 'Use store', description: 'Sets the store', sideEffect: 'write' },
    ]
    m.settings = { store: structuredClone(store) }
    change(m)
    return m
  }
  const messages = (input: ManifestInput): string[] => {
    const parsed = manifestSchema.safeParse(input)
    return parsed.success ? [] : parsed.error.issues.map((i) => i.message)
  }

  it('defaults to none', () => {
    expect(parseManifest(VALID).settings).toEqual({})
    expect(settingToolNames(parseManifest(VALID)).size).toBe(0)
  })

  it('accepts a setting whose tools are declared, and names them', () => {
    const manifest = parseManifest(withSettings())
    expect(manifest.settings['store']?.required).toBe(true)
    expect([...settingToolNames(manifest)]).toEqual(['find_stores', 'apply_store'])
  })

  it('is not required unless it says so, and needs no apply tool', () => {
    const manifest = parseManifest(
      withSettings((m) => {
        m.settings = { store: { title: 'Store', description: 'Store', choices: store.choices } }
      }),
    )
    expect(manifest.settings['store']).toMatchObject({ required: false })
    expect([...settingToolNames(manifest)]).toEqual(['find_stores'])
  })

  it('rejects a tool that is not declared', () => {
    expect(
      messages(
        withSettings((m) => {
          m.tools = m.tools.filter((t) => t.name !== 'apply_store')
        }),
      ),
    ).toContain('setting store names undeclared tool apply_store')
  })

  it('rejects a choices tool that writes, and an apply tool that is irreversible', () => {
    expect(
      messages(
        withSettings((m) => {
          m.tools = m.tools.map((t) => (t.name === 'find_stores' ? { ...t, sideEffect: 'write' } : t))
        }),
      ),
    ).toContain("setting store's choices tool find_stores may not be write")
    expect(
      messages(
        withSettings((m) => {
          m.tools = m.tools.map((t) => (t.name === 'apply_store' ? { ...t, sideEffect: 'irreversible' } : t))
        }),
      ),
    ).toContain("setting store's apply tool apply_store may not be irreversible")
  })

  it('rejects one tool serving two jobs', () => {
    expect(
      messages(
        withSettings((m) => {
          m.settings = { store: { ...store, apply: { tool: 'find_stores' } } }
        }),
      ),
    ).toContain('tool find_stores serves more than one setting')
  })

  it('rejects a manifest that leaves no tool for clients', () => {
    expect(
      messages(
        withSettings((m) => {
          m.tools = m.tools.filter((t) => t.name === 'find_stores' || t.name === 'apply_store')
        }),
      ),
    ).toContain('every tool serves a setting: none is left for clients')
  })

  it('rejects unknown keys and more than eight settings', () => {
    expect(
      manifestSchema.safeParse(
        withSettings((m) => {
          m.settings = { store: { ...store, html: '<b>' } as never }
        }),
      ).success,
    ).toBe(false)
    expect(
      messages(
        withSettings((m) => {
          m.settings = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, store]))
        }),
      ),
    ).toContain('at most 8 settings')
  })

  it('fixes the shapes a setting’s tools exchange with the runtime', () => {
    expect(settingQuerySchema.safeParse({ query: '2000' }).success).toBe(true)
    expect(settingQuerySchema.safeParse({ query: 'x'.repeat(101) }).success).toBe(false)
    expect(settingValueSchema.safeParse({ value: '' }).success).toBe(false)
    expect(
      settingChoicesSchema.safeParse({ choices: [{ value: '1', label: 'A', detail: 'B' }] }).success,
    ).toBe(true)
    expect(settingChoicesSchema.safeParse({ choices: [{ value: '1', label: '' }] }).success).toBe(false)
  })
})

describe('an adapter with no login', () => {
  const noLogin = (): ManifestInput => {
    const { secrets: _s, session: _session, auth: _a, ...rest } = structuredClone(VALID)
    return { ...rest, navigation: ['https://www.example.com'] }
  }

  it('leaves out secrets, session and auth, and parses to an explicit no-login session', () => {
    const manifest = parseManifest(noLogin())
    expect(manifest.secrets).toEqual({})
    expect(manifest.session).toEqual({ cookieDomains: [], storage: [], probe: { kind: 'none' } })
    expect(manifest.auth).toEqual({ steps: [], frameOrigins: [] })
    expect(hasLogin(manifest)).toBe(false)
    expect(hasLogin(parseManifest(VALID))).toBe(true)
  })

  it('refuses any login part beside a none probe', () => {
    const parts: Partial<ManifestInput>[] = [
      { secrets: structuredClone(VALID.secrets) },
      { auth: { steps: [{ op: 'assertLoggedIn' }] } },
      { session: { cookieDomains: ['www.example.com'], probe: { kind: 'none' } } },
      {
        session: {
          cookieDomains: [],
          storage: [{ origin: 'https://www.example.com', keys: ['t'] }],
          probe: { kind: 'none' },
        },
      },
      { auth: { steps: [], frameOrigins: ['https://captcha.example.com'] } },
    ]
    for (const part of parts) expect(manifestSchema.safeParse({ ...noLogin(), ...part }).success).toBe(false)
  })

  it('refuses a login with no steps or no cookie domain', () => {
    expect(manifestSchema.safeParse({ ...structuredClone(VALID), auth: { steps: [] } }).success).toBe(false)
    const session = { ...structuredClone(VALID.session), cookieDomains: [] }
    expect(manifestSchema.safeParse({ ...structuredClone(VALID), session }).success).toBe(false)
  })
})
