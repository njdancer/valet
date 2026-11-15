// The hub's parts that run in Node as well as workerd: its front door and its pages.

import { describe, expect, it } from 'vitest'
import { hubFront } from '../src/hub/front'
import { hubPage } from '../src/hub/pages'

const open = { limit: async () => ({ success: true }) }
const shut = { limit: async () => ({ success: false }) }
const broken = {
  limit: async (): Promise<{ success: boolean }> => {
    throw new Error('down')
  },
}

function door(limits: { forward: typeof open; signIn: typeof open }) {
  const seen: Request[] = []
  return {
    seen,
    door: {
      hub: () => ({
        fetch: async (request: Request) => {
          seen.push(request)
          return new Response('ok')
        },
      }),
      limits,
    },
  }
}

describe('the hub front door', () => {
  it('passes GET and POST to the hub within limits', async () => {
    const { seen, door: d } = door({ forward: open, signIn: open })
    expect((await hubFront(new Request('https://hub.test/'), d)).status).toBe(200)
    expect(
      (await hubFront(new Request('https://hub.test/api/sign-in/options', { method: 'POST' }), d)).status,
    ).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it('refuses other methods, long queries, large bodies, and anything over a limit', async () => {
    const { seen, door: d } = door({ forward: open, signIn: shut })
    expect((await hubFront(new Request('https://hub.test/', { method: 'PUT' }), d)).status).toBe(405)
    expect((await hubFront(new Request(`https://hub.test/?${'a'.repeat(3000)}`), d)).status).toBe(414)
    const big = new Request('https://hub.test/api/nodes/link', {
      method: 'POST',
      headers: { 'content-length': String(100_000) },
      body: 'x',
    })
    expect((await hubFront(big, d)).status).toBe(413)
    // Sign-in has its own, tighter limit.
    expect(
      (await hubFront(new Request('https://hub.test/api/sign-in/verify', { method: 'POST' }), d)).status,
    ).toBe(429)
    expect(seen).toHaveLength(0)
    const all = door({ forward: shut, signIn: open })
    expect((await hubFront(new Request('https://hub.test/'), all.door)).status).toBe(429)
    // A limiter that fails shuts.
    const down = door({ forward: broken, signIn: open })
    expect((await hubFront(new Request('https://hub.test/'), down.door)).status).toBe(429)
  })
})

describe('the hub pages', () => {
  it('runs only its own script, by nonce, and frames nothing', async () => {
    const response = hubPage('sign-in', 200)
    const csp = response.headers.get('content-security-policy') ?? ''
    const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)?.[1]
    expect(nonce).toBeDefined()
    const html = await response.text()
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(response.headers.get('cache-control')).toBe('no-store')
    // A fresh nonce each time.
    expect(hubPage('sign-in', 200).headers.get('content-security-policy')).not.toBe(csp)
  })

  it('serves every page, and never writes data into HTML with innerHTML', async () => {
    for (const name of ['home', 'sign-in', 'sign-up', 'link', 'security', 'not-found'] as const) {
      const html = await hubPage(name, name === 'not-found' ? 404 : 200).text()
      expect(html).toContain(`data-page="${name}"`)
      expect(html).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/)
    }
  })
})
