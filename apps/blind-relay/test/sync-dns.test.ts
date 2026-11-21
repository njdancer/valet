// The deploy workflow's DNS step: the relay's names follow its dedicated Fly addresses, DNS only,
// and nothing else in the zone is touched.

import { describe, expect, it } from 'vitest'
import { flyAddresses, syncDns } from '../scripts/sync-dns.mjs'

interface Row {
  id: string
  type: string
  name: string
  content: string
  proxied: boolean
}

function fakeZone(rows: Row[]) {
  let n = 100
  const calls: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const path = url.pathname.replace('/client/v4', '')
    calls.push(`${method} ${path}`)
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
    if (new Headers(init?.headers).get('authorization') !== 'Bearer t')
      return Response.json({ success: false, errors: [{ message: 'bad token' }] }, { status: 401 })
    if (path === '/zones')
      return ok(url.searchParams.get('name') === 'dncr.me' ? [{ id: 'z1', name: 'dncr.me' }] : [])
    if (path === '/zones/z1/dns_records' && method === 'GET')
      return ok(rows.filter((r) => r.name === url.searchParams.get('name')))
    if (path === '/zones/z1/dns_records' && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      rows.push({
        id: String(++n),
        type: body.type,
        name: body.name,
        content: body.content,
        proxied: body.proxied,
      })
      return ok({})
    }
    if (path.startsWith('/zones/z1/dns_records/') && method === 'DELETE') {
      const id = path.split('/').at(-1)
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      )
      return ok({})
    }
    return Response.json({ success: false, errors: [{ message: 'no route' }] }, { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, rows, calls }
}

const NAMES = ['relay.valet.dncr.me', '*.valet.dncr.me']

describe('syncing the relay’s DNS', () => {
  it('keeps only dedicated public addresses from flyctl', () => {
    expect(
      flyAddresses([
        { Address: '2a09:8280:1::1', Type: 'v6' },
        { Address: '66.241.124.9', Type: 'shared_v4' },
        { Address: 'fdaa:0:1::3', Type: 'private_v6' },
        { Address: '137.66.1.2', Type: 'v4' },
        { Address: 'nonsense', Type: 'v4' },
      ]),
    ).toEqual({ A: ['137.66.1.2'], AAAA: ['2a09:8280:1::1'] })
    expect(flyAddresses(null)).toEqual({ A: [], AAAA: [] })
  })

  it('adds the records, DNS only, then does nothing when they already match', async () => {
    const zone = fakeZone([
      { id: '1', type: 'A', name: 'valet.dncr.me', content: '104.16.0.1', proxied: true },
      { id: '2', type: 'TXT', name: 'relay.valet.dncr.me', content: 'keep me', proxied: false },
    ])
    const wanted = { A: [], AAAA: ['2a09:8280:1::1'] }
    const changes = await syncDns({ token: 't', zone: 'dncr.me', names: NAMES, wanted, fetch: zone.fetch })
    expect(changes).toEqual([
      'added AAAA relay.valet.dncr.me 2a09:8280:1::1',
      'added AAAA *.valet.dncr.me 2a09:8280:1::1',
    ])
    expect(zone.rows.filter((r) => r.type === 'AAAA').every((r) => r.proxied === false)).toBe(true)
    // The hub's own name and other records are untouched.
    expect(zone.rows.find((r) => r.id === '1')?.content).toBe('104.16.0.1')
    expect(zone.rows.find((r) => r.id === '2')).toBeDefined()
    expect(await syncDns({ token: 't', zone: 'dncr.me', names: NAMES, wanted, fetch: zone.fetch })).toEqual(
      [],
    )
  })

  it('replaces an old or proxied address, and adds IPv4 once there is one', async () => {
    const zone = fakeZone([
      { id: '1', type: 'AAAA', name: '*.valet.dncr.me', content: '2a09:dead::1', proxied: false },
      { id: '2', type: 'AAAA', name: 'relay.valet.dncr.me', content: '2a09:8280:1::1', proxied: true },
    ])
    const wanted = { A: ['137.66.1.2'], AAAA: ['2a09:8280:1::1'] }
    const changes = await syncDns({ token: 't', zone: 'dncr.me', names: NAMES, wanted, fetch: zone.fetch })
    expect(changes).toContain('removed AAAA *.valet.dncr.me 2a09:dead::1')
    expect(changes).toContain('removed AAAA relay.valet.dncr.me 2a09:8280:1::1')
    expect(changes).toContain('added A *.valet.dncr.me 137.66.1.2')
    expect(zone.rows.map((r) => `${r.type} ${r.name} ${r.content} ${r.proxied}`).sort()).toEqual([
      'A *.valet.dncr.me 137.66.1.2 false',
      'A relay.valet.dncr.me 137.66.1.2 false',
      'AAAA *.valet.dncr.me 2a09:8280:1::1 false',
      'AAAA relay.valet.dncr.me 2a09:8280:1::1 false',
    ])
  })

  it('refuses a CNAME, a name outside the zone, a zone it can’t see and a bad token', async () => {
    const zone = fakeZone([
      { id: '1', type: 'CNAME', name: 'relay.valet.dncr.me', content: 'x.example', proxied: true },
    ])
    const wanted = { A: [], AAAA: ['2a09:8280:1::1'] }
    await expect(
      syncDns({ token: 't', zone: 'dncr.me', names: NAMES, wanted, fetch: zone.fetch }),
    ).rejects.toThrow(/CNAME/)
    await expect(
      syncDns({ token: 't', zone: 'dncr.me', names: ['evil.example'], wanted, fetch: zone.fetch }),
    ).rejects.toThrow(/isn't in/)
    await expect(
      syncDns({ token: 't', zone: 'other.me', names: NAMES, wanted, fetch: zone.fetch }),
    ).rejects.toThrow(/can't see/)
    await expect(
      syncDns({ token: 'x', zone: 'dncr.me', names: NAMES, wanted, fetch: zone.fetch }),
    ).rejects.toThrow(/401/)
    expect(zone.rows).toHaveLength(1)
  })
})
