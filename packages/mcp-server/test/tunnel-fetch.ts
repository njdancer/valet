// fetch over node:http, for the remote listener's tests: the Host header is the tunnel's public name
// while the connection goes to 127.0.0.1, as cloudflared's would.

import { request } from 'node:http'
import { Readable } from 'node:stream'

/**
 * fetch over node:http, so the Host header is the tunnel's public name while the connection goes to
 * 127.0.0.1. Node's own fetch always sends the URL's host.
 */
export function tunnelFetch(port: number, host: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const headers = new Headers(init?.headers)
    headers.set('host', host)
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body)
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: init?.method ?? 'GET',
          path: url.pathname + url.search,
          headers: Object.fromEntries(headers),
        },
        (res) => {
          const out = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') out.set(key, value)
            else if (Array.isArray(value)) for (const v of value) out.append(key, v)
          }
          const status = res.statusCode ?? 0
          const stream = status === 202 || status === 204 ? null : (Readable.toWeb(res) as ReadableStream)
          resolve(new Response(stream, { status, headers: out }))
        },
      )
      init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')))
      req.on('error', reject)
      req.end(body)
    })
  }) as typeof fetch
}
