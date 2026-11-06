// A static update feed on 127.0.0.1, port 0: serves what the test puts in it, records every request
// (path and headers), and can be told to answer a path with an HTTP error instead.

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  readonly method: string
  /** Without the query string electron-updater adds to defeat caches. */
  readonly path: string
  readonly headers: IncomingHttpHeaders
}

export class FakeFeedServer {
  readonly files = new Map<string, Buffer>()
  readonly failures = new Map<string, number>()
  readonly requests: RecordedRequest[] = []
  private server: Server | null = null

  get url(): string {
    const address = this.server?.address() as AddressInfo | null | undefined
    if (address == null) throw new Error('not listening')
    return `http://127.0.0.1:${address.port}/`
  }

  requested(path: string): number {
    return this.requests.filter((r) => r.path === path).length
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://feed.invalid').pathname
      this.requests.push({ method: request.method ?? '', path, headers: request.headers })
      const failure = this.failures.get(path)
      if (failure !== undefined) {
        response.writeHead(failure).end()
        return
      }
      const body = this.files.get(path)
      if (body === undefined) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, { 'content-length': body.length }).end(body)
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
