// A stand-in Cloudflare API for "My Cloudflare account": zones, tunnels with their configuration
// and token, and DNS records, behind a bearer token. As a fetch function for unit tests, or served
// over HTTP for the app in an e2e run.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const ACCOUNT = 'a'.repeat(32)
export const ZONE = 'b'.repeat(32)
export const TOKEN = 'good-token'

export interface FakeCloudflare {
  readonly fetch: typeof fetch
  readonly tunnels: Map<string, { name: string; config: unknown; deleted: boolean }>
  readonly records: Map<string, { name: string; type: string; content: string; proxied: boolean }>
  readonly calls: string[]
  dnsWrite: boolean
  /** The same Cloudflare over HTTP, for the app in an e2e run: its API base URL. */
  serve(): Promise<{ readonly url: string; close(): Promise<void> }>
}

export function fakeCloudflare(zoneName = 'example.com'): FakeCloudflare {
  let n = 0
  const id32 = () => (++n).toString(16).padStart(32, '0')
  const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`
  const state: FakeCloudflare = {
    tunnels: new Map(),
    records: new Map(),
    calls: [],
    dnsWrite: true,
    serve: async () => {
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8')
        const answer = await state.fetch(`http://127.0.0.1${req.url}`, {
          method: req.method ?? 'GET',
          headers:
            req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization },
          ...(body === undefined ? {} : { body }),
        })
        res.writeHead(answer.status, { 'content-type': 'application/json' })
        res.end(await answer.text())
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      const { port } = server.address() as AddressInfo
      return {
        url: `http://127.0.0.1:${port}/client/v4`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      const path = url.pathname.replace(/^\/client\/v4/, '')
      state.calls.push(`${method} ${path}`)
      const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result })
      const fail = (status: number, code: number, message: string) =>
        Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status })
      // Not Cloudflare's API: what its edge knows of a tunnel, for the stand-in cloudflared to serve.
      if (method === 'GET' && path === '/__edge/config') {
        const token = url.searchParams.get('token')
        const found = [...state.tunnels].find(([id, t]) => !t.deleted && `tunnel-token-for-${id}` === token)
        return found === undefined ? fail(404, 0, 'no tunnel') : ok(found[1].config)
      }
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`)
        return fail(401, 10001, 'Unable to authenticate request')
      const body = init?.body === undefined ? null : JSON.parse(String(init.body))
      if (method === 'GET' && path === '/zones') {
        const name = url.searchParams.get('name')
        return ok(name === zoneName ? [{ id: ZONE, name, account: { id: ACCOUNT } }] : [])
      }
      const tunnelBase = `/accounts/${ACCOUNT}/cfd_tunnel`
      if (path === tunnelBase && method === 'GET') {
        const name = url.searchParams.get('name')
        return ok(
          [...state.tunnels]
            .filter(([, t]) => !t.deleted && t.name === name)
            .map(([id, t]) => ({ id, name: t.name })),
        )
      }
      if (path === tunnelBase && method === 'POST') {
        const id = uuid()
        state.tunnels.set(id, { name: body.name, config: null, deleted: false })
        return ok({ id, name: body.name })
      }
      const tunnel = path.match(/^\/accounts\/[0-9a-f]{32}\/cfd_tunnel\/([0-9a-f-]+)(\/.*)?$/)
      if (tunnel !== null) {
        const entry = state.tunnels.get(tunnel[1] as string)
        if (entry === undefined) return fail(404, 1003, 'not found')
        const rest = tunnel[2] ?? ''
        if (rest === '/configurations' && method === 'PUT') {
          entry.config = body.config
          return ok({})
        }
        if (rest === '/token' && method === 'GET') return ok(`tunnel-token-for-${tunnel[1]}`)
        if (rest === '/connections' && method === 'DELETE') return ok(null)
        if (rest === '' && method === 'DELETE') {
          entry.deleted = true
          return ok({})
        }
      }
      const dnsBase = `/zones/${ZONE}/dns_records`
      if (path === dnsBase && method === 'GET') {
        const name = url.searchParams.get('name')
        return ok([...state.records].filter(([, r]) => r.name === name).map(([id, r]) => ({ id, ...r })))
      }
      if (path === dnsBase && method === 'POST') {
        if (!state.dnsWrite) return fail(403, 10000, 'Authentication error')
        const id = id32()
        state.records.set(id, {
          name: body.name,
          type: body.type,
          content: body.content,
          proxied: body.proxied,
        })
        return ok({ id, ...body })
      }
      if (path.startsWith(`${dnsBase}/`) && method === 'DELETE') {
        state.records.delete(path.slice(dnsBase.length + 1))
        return ok({})
      }
      return fail(404, 7003, `no route for ${method} ${path}`)
    }) as typeof fetch,
  }
  return state
}
