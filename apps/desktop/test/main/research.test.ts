// The scratch browsers' app side (src/main/core/drafts/research.ts): the rules each browser gets,
// pacing, limits, and what the network log hands an agent. The browser itself is tested in
// packages/browser-electron/test/scratch.test.ts.

import { Socket } from 'node:net'
import { parseManifest } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import {
  draftDomains,
  fixtureFits,
  RESEARCH_LIMITS,
  type ResearchDeps,
  ResearchRefusal,
  type ScratchHandle,
  ScratchSessions,
  scrubBody,
  scrubUrl,
} from '../../src/main/core/drafts/research'
import { publicOnlyDial } from '../../src/main/electron/public-dial'
import { SHOP } from './fixtures'

const MANIFEST = parseManifest({
  ...SHOP,
  id: 'quotes',
  home: 'https://finance.example.com/',
  navigation: ['https://finance.example.com'],
  egress: ['query1.finance.example.com'],
  secrets: {},
  session: { cookieDomains: [], probe: { kind: 'none' } },
  auth: { steps: [] },
})

type Rules = Parameters<ResearchDeps['open']>[1]

function handle(): ScratchHandle & { closedNow: boolean } {
  const listeners: (() => void)[] = []
  const h = {
    closedNow: false,
    navigate: async () => ({ url: 'https://finance.example.com/', title: 't', nodes: [], cut: false }),
    click: async () => ({ url: '', title: '', nodes: [], cut: false }),
    type: async () => ({ url: '', title: '', nodes: [], cut: false }),
    snapshot: async () => ({ url: '', title: '', nodes: [], cut: false }),
    query: async () => ({ count: 0, matches: [] }),
    entries: () => [],
    body: async () => null,
    document: async () => '<html></html>',
    isClosed: () => h.closedNow,
    onClosed: (listener: () => void) => void listeners.push(listener),
    close: () => {
      h.closedNow = true
      for (const l of listeners.splice(0)) l()
    },
  }
  return h
}

function sessions(overrides: Partial<ResearchDeps> = {}) {
  let now = Date.parse('2026-11-12T00:00:00Z')
  const opened: { draftId: string; rules: Rules; handle: ReturnType<typeof handle> }[] = []
  const notices: string[] = []
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  const s = new ScratchSessions({
    open: async (draftId, rules) => {
      const h = handle()
      opened.push({ draftId, rules, handle: h })
      return h
    },
    signedIn: async () =>
      new Map([
        ['shop', ['shop.test']],
        ['quotes', ['example.com']],
      ]),
    secretIn: async (text) => text.includes('hunter2'),
    blocked: () => undefined,
    notify: (text) => void notices.push(text),
    now: () => now,
    timers: {
      setTimeout: (run, ms) => {
        const t = { run, ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimeout: (t) => {
        ;(t as { cleared: boolean }).cleared = true
      },
    },
    ...overrides,
  })
  return {
    s,
    opened,
    notices,
    timers,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('scratch browser rules', () => {
  it('open pages only under the draft’s domains, and never a signed-in site but the draft’s own', async () => {
    const { s, opened, notices } = await sessions()
    await s.browser('dr-aaaaaaaaaa', 'local:c1', 'Claude Code', 'quotes', MANIFEST)
    const rules = opened[0]?.rules as Rules
    expect(rules.mayNavigate(new URL('https://finance.example.com/q'))).toBe(true)
    expect(rules.mayNavigate(new URL('https://example.com/'))).toBe(true)
    expect(rules.mayNavigate(new URL('https://other.test/'))).toBe(false)
    expect(rules.mayRequest(new URL('https://cdn.akamai.test/x.js'))).toBe(true)
    expect(rules.mayRequest(new URL('https://www.shop.test/'))).toBe(false)
    // The draft's own adapter is signed in: allowed, and the person is told.
    expect(rules.mayRequest(new URL('https://finance.example.com/'))).toBe(true)
    expect(notices).toEqual(['Claude Code is looking at example.com in a signed-out browser.'])
    expect(await rules.mayType('AAPL')).toBe(true)
    expect(await rules.mayType('hunter2')).toBe(false)
  })

  it('paces page loads per domain: a gap between them, and a cap an hour', async () => {
    const { s, opened, advance } = await sessions()
    await s.browser('dr-aaaaaaaaaa', 'local:c1', 'Claude Code', 'quotes', MANIFEST)
    const rules = opened[0]?.rules as Rules
    await rules.pace('finance.example.com')
    await expect(rules.pace('query1.finance.example.com')).rejects.toThrow(/Wait 3 seconds/)
    for (let i = 1; i < RESEARCH_LIMITS.navigationsPerDomainPerHour; i++) {
      advance(RESEARCH_LIMITS.minGapMs)
      await rules.pace('finance.example.com')
    }
    advance(RESEARCH_LIMITS.minGapMs)
    await expect(rules.pace('finance.example.com')).rejects.toThrow(/as often as it allows in an hour/)
    // Another site has its own budget.
    await rules.pace('other.test')
  })

  it('keeps one browser per agent and three in all, and closes an idle one', async () => {
    const { s, opened, timers } = await sessions()
    await s.browser('dr-aaaaaaaaaa', 'local:c1', 'A', 'quotes', MANIFEST)
    // The same draft's browser is the same one.
    await s.browser('dr-aaaaaaaaaa', 'local:c1', 'A', 'quotes', MANIFEST)
    expect(opened).toHaveLength(1)
    await expect(s.browser('dr-bbbbbbbbbb', 'local:c1', 'A', 'quotes', MANIFEST)).rejects.toThrow(
      ResearchRefusal,
    )
    await s.browser('dr-cccccccccc', 'local:c2', 'B', 'quotes', MANIFEST)
    await s.browser('dr-dddddddddd', 'local:c3', 'C', 'quotes', MANIFEST)
    await expect(s.browser('dr-eeeeeeeeee', 'local:c4', 'D', 'quotes', MANIFEST)).rejects.toThrow(/as many/)
    const idle = timers.filter((t) => !t.cleared && t.ms === RESEARCH_LIMITS.idleMs)[0]
    idle?.run()
    expect(opened[0]?.handle.isClosed()).toBe(true)
    expect(() => s.current('dr-aaaaaaaaaa')).toThrow(/valet_browser_open/)
    s.closeAll()
    expect(opened.every((o) => o.handle.isClosed())).toBe(true)
  })

  it('needs a manifest it can read', async () => {
    const { s } = await sessions()
    await expect(s.browser('dr-aaaaaaaaaa', 'local:c1', 'A', 'quotes', null)).rejects.toThrow(/manifest/)
  })

  it('takes the domains from home, navigation and egress', () => {
    expect(draftDomains(MANIFEST)).toEqual(['example.com'])
  })
})

describe('what the network log hands an agent', () => {
  it('URLs without ids in paths or query values', () => {
    expect(scrubUrl('https://api.example.com/v1/user/12345678/orders?symbols=AAPL&n=5')).toBe(
      'https://api.example.com/v1/user/:param/orders?symbols=<text:4>&n=<number:1>',
    )
    expect(scrubUrl('https://x.test/s/0f3a9b2c4d5e6f708192a3b4c5d6e7f8/q')).toBe('https://x.test/s/:param/q')
    expect(scrubUrl('https://x.test/quote/AAPL')).toBe('https://x.test/quote/AAPL')
    expect(scrubUrl('not a url')).toBe('(invalid)')
  })

  it('JSON with long strings and arrays cut, secret-looking keys hidden; pages refused', () => {
    const body = JSON.stringify({
      quote: { symbol: 'AAPL', price: 1.5, note: 'x'.repeat(200) },
      list: Array.from({ length: 50 }, (_, i) => i),
      csrfToken: 'abc',
      session: { id: 'zzz' },
    })
    const out = scrubBody(body, 'application/json')
    expect('value' in out && out.truncated).toBe(true)
    const value = (out as { value: Record<string, unknown> }).value
    expect((value['quote'] as Record<string, unknown>)['note']).toHaveLength(RESEARCH_LIMITS.stringChars)
    expect(value['list']).toHaveLength(RESEARCH_LIMITS.arrayItems)
    expect(value['csrfToken']).toBe('[hidden]')
    expect(value['session']).toBe('[hidden]')
    expect(scrubBody('<html></html>', 'text/html')).toMatchObject({
      refused: expect.stringMatching(/snapshot/),
    })
    expect(scrubBody('plain', 'text/plain')).toEqual({ value: 'plain', truncated: false })
  })

  it('fixtures by type and place', () => {
    expect(fixtureFits('fixtures/quote.json', 'application/json', false)).toBeNull()
    expect(fixtureFits('fixtures/quote.html', 'application/json', false)).toMatch(/JSON response/)
    expect(fixtureFits('fixtures/page.html', null, true)).toBeNull()
    expect(fixtureFits('src/x.json', 'application/json', false)).toMatch(/under fixtures/)
    expect(fixtureFits('fixtures/a.json', 'image/png', false)).toMatch(/Only JSON/)
  })
})

describe('the scratch browser’s dial', () => {
  it('refuses a name that resolves to a private address, and connects to the checked one otherwise', async () => {
    const refused = publicOnlyDial((_host, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]))(
      'lan.test',
      443,
    )
    refused.on('error', () => undefined)
    await new Promise<void>((resolve) => refused.once('close', () => resolve()))
    expect(refused.destroyed).toBe(true)
    const mixed = publicOnlyDial((_host, cb) =>
      cb(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    )('both.test', 443)
    mixed.on('error', () => undefined)
    await new Promise<void>((resolve) => mixed.once('close', () => resolve()))
    expect(mixed.destroyed).toBe(true)
    // A public answer is dialled by the address that was checked, never the name again.
    const connect = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
      return this
    })
    publicOnlyDial((_host, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]))('public.test', 443)
    expect(connect).toHaveBeenCalledWith({ host: '93.184.216.34', port: 443 })
    connect.mockRestore()
  })
})
