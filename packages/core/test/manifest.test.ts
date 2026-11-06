import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineAdapter, tool } from '../src/adapter'
import {
  type AuthStep,
  type ManifestInput,
  manifestSchema,
  parseManifest,
  secretRefsIn,
} from '../src/manifest'

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
    expect(manifest.limits.requestsPerRun).toBe(50)
    expect(manifest.session.storage).toEqual([])
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

  it('rejects duplicate tool names', () => {
    const input = copy()
    input.tools.push({ ...input.tools[0] })
    expect(issues(input)).toContain('duplicate tool get_cart')
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
        any: [{ urlMatches: '/account' }, { all: [{ textPresent: 'Hi' }, { not: { visible: '#x' } }] }],
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
      { op: 'otp', selector: '#m', source: { messages: { pattern: '\\d+', maxAgeSeconds: 60 } } },
    ]
    expect(secretRefsIn(steps)).toEqual([
      { secret: 'a', field: 'username' },
      { secret: 'b', field: 'password' },
      { secret: 'c', field: 'otp' },
    ])
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
