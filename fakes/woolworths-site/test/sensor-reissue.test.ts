// An `_abck` the fake never issued (left in a persistent partition by an earlier run, say) gets a
// fresh one, as the real Akamai tends to, rather than Access Denied. The deny behaviour stays behind
// a switch.

import { afterEach, describe, expect, it } from 'vitest'
import { type FakeWoolworths, startFakeWoolworths } from '../src/server'
import { Client } from './support/client'

const sites: FakeWoolworths[] = []
afterEach(async () => {
  await Promise.all(sites.splice(0).map((site) => site.close()))
})

async function start(options: Parameters<typeof startFakeWoolworths>[0] = {}): Promise<FakeWoolworths> {
  const site = await startFakeWoolworths(options)
  sites.push(site)
  return site
}

const STALE = 'A'.repeat(48).concat('~0~-1~-1')

function staleClient(site: FakeWoolworths): Client {
  const client = new Client(site.origin)
  client.cookies.set('_abck', STALE)
  return client
}

describe('an _abck the site never issued', () => {
  it('gets a fresh, script-readable _abck and the API answers', async () => {
    const site = await start()
    const client = staleClient(site)
    const reply = await client.get('/apis/ui/Trolley')
    expect(reply.status).toBe(200)
    const sensor = reply.setCookies.find((line) => line.startsWith('_abck='))
    expect(sensor).toMatch(/^_abck=[0-9A-F]{48}~0~-1~-1; Path=\/; SameSite=Lax; Max-Age=31536000$/)
    expect(sensor).not.toContain('HttpOnly')
    expect(client.cookies.get('_abck')).not.toBe(STALE)
  })

  it('is then accepted as one the site issued', async () => {
    const site = await start()
    const client = staleClient(site)
    await client.get('/apis/ui/Trolley')
    const second = await client.get('/apis/ui/Trolley')
    expect(second.status).toBe(200)
    expect(second.setCookies.some((line) => line.startsWith('_abck='))).toBe(false)
  })

  it('is reissued on a page load too', async () => {
    const site = await start()
    const client = staleClient(site)
    const page = await client.get('/')
    expect(page.status).toBe(200)
    expect(page.setCookies.some((line) => line.startsWith('_abck='))).toBe(true)
  })

  it('leaves an API request with no _abck at all denied', async () => {
    const site = await start()
    const reply = await new Client(site.origin).get('/apis/ui/Trolley')
    expect(reply.status).toBe(403)
    expect(reply.setCookies).toEqual([])
  })

  it('does not let a blocked session out: the made-up cookie is denied, not reissued', async () => {
    const rateLimit = { maxRequests: 1, windowMs: 10_000, cooldownMs: 60_000 }
    const site = await start({ rateLimit, now: () => 0 })
    const client = new Client(site.origin)
    await client.visit('/')
    await client.get('/apis/ui/Trolley')
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
    client.cookies.set('_abck', STALE)
    const reply = await client.get('/apis/ui/Trolley')
    expect(reply.status).toBe(403)
    expect(reply.setCookies).toEqual([])
  })

  it('keeps a blocked session blocked when it drops its _abck, on a page or an API call', async () => {
    const rateLimit = { maxRequests: 1, windowMs: 10_000, cooldownMs: 60_000 }
    const site = await start({ rateLimit, now: () => 0 })
    const client = new Client(site.origin)
    await client.visit('/')
    await client.get('/apis/ui/Trolley')
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
    expect(client.cookies.has('wow-auth-token')).toBe(true)
    client.cookies.delete('_abck')
    const page = await client.get('/')
    expect(page.status).toBe(403)
    expect(page.setCookies).toEqual([])
    client.cookies.delete('_abck')
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
    // A made-up sensor after that is still not reissued.
    client.cookies.set('_abck', STALE)
    const forged = await client.get('/apis/ui/Trolley')
    expect(forged.status).toBe(403)
    expect(forged.setCookies).toEqual([])
  })

  it('counts the reissued sensor towards the rate limit', async () => {
    const rateLimit = { maxRequests: 2, windowMs: 10_000, cooldownMs: 60_000 }
    const site = await start({ rateLimit, now: () => 0 })
    const client = staleClient(site)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(200)
    expect((await client.get('/apis/ui/Trolley')).status).toBe(403)
  })

  it('is denied instead with unknownSensor: deny, and the switch works while running', async () => {
    const site = await start({ unknownSensor: 'deny' })
    expect((await staleClient(site).get('/apis/ui/Trolley')).status).toBe(403)
    site.setUnknownSensor('reissue')
    expect((await staleClient(site).get('/apis/ui/Trolley')).status).toBe(200)
    site.setUnknownSensor('deny')
    const denied = await staleClient(site).get('/apis/ui/Trolley')
    expect(denied.status).toBe(403)
    expect(denied.text).toContain('<H1>Access Denied</H1>')
  })

  it('refuses a mode it does not know', async () => {
    await expect(startFakeWoolworths({ unknownSensor: 'maybe' as 'deny' })).rejects.toThrow(/unknownSensor/)
    const site = await start()
    expect(() => site.setUnknownSensor('maybe' as 'deny')).toThrow(/unknownSensor/)
  })
})
