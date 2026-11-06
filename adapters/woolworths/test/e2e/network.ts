// The e2e harness's network: real HTTPS to the fake site's servers on 127.0.0.1, with test
// hostnames resolved by a fixed table and the test certificate as the only trusted CA. A hostname
// outside the table fails to resolve, so nothing here can reach a real site.

import type { IncomingHttpHeaders } from 'node:http'
import { request } from 'node:https'
import type { LookupFunction } from 'node:net'
import { hostAllowed } from '@siteadapter/core'

export interface HttpResponse {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

export class Network {
  /** Every request sent, as "METHOD https://host:port/path?query", in order. */
  readonly sent: string[] = []

  constructor(
    private readonly ca: string,
    private readonly hosts: readonly string[],
  ) {}

  send(method: string, url: string, headers: Record<string, string>, body?: string): Promise<HttpResponse> {
    const target = new URL(url)
    if (target.protocol !== 'https:') return Promise.reject(new Error(`refusing ${target.protocol}`))
    this.sent.push(`${method} ${target.href}`)
    const lookup: LookupFunction = (hostname, options, callback) => {
      if (!this.hosts.includes(hostname)) {
        const error = Object.assign(new Error(`harness does not resolve ${hostname}`), { code: 'ENOTFOUND' })
        callback(error, '', 4)
        return
      }
      if (options.all)
        (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address: '127.0.0.1', family: 4 },
        ])
      else callback(null, '127.0.0.1', 4)
    }
    return new Promise((resolve, reject) => {
      const req = request(
        {
          method,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          headers,
          ca: this.ca,
          servername: target.hostname,
          lookup,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.end(body)
    })
  }
}

export interface Cookie {
  readonly name: string
  readonly value: string
  /** Host-only, as every cookie the fake sets is. Ports don't separate cookies, as in a browser. */
  readonly host: string
  readonly httpOnly: boolean
}

/** One browser partition's cookies. */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>()

  /** Applies one Set-Cookie header received from `url`. */
  receive(url: string, header: string): void {
    const host = new URL(url).hostname
    const [pair = '', ...attributes] = header.split(';').map((part) => part.trim())
    const index = pair.indexOf('=')
    if (index <= 0) return
    const name = pair.slice(0, index)
    const lowered = attributes.map((attribute) => attribute.toLowerCase())
    if (lowered.includes('max-age=0')) {
      this.cookies.delete(`${host};${name}`)
      return
    }
    this.set({ name, value: pair.slice(index + 1), host, httpOnly: lowered.includes('httponly') })
  }

  set(cookie: Cookie): void {
    this.cookies.set(`${cookie.host};${cookie.name}`, cookie)
  }

  /** The Cookie header for a request to `url`. */
  header(url: string): string {
    const host = new URL(url).hostname
    return this.all()
      .filter((cookie) => cookie.host === host)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
  }

  has(host: string, name: string): boolean {
    return this.cookies.has(`${host};${name}`)
  }

  all(): Cookie[] {
    return [...this.cookies.values()]
  }

  /** Cookies whose host matches one of the manifest's cookie-domain patterns. */
  on(domains: readonly string[]): Cookie[] {
    return this.all().filter((cookie) => hostAllowed(cookie.host, domains))
  }
}
