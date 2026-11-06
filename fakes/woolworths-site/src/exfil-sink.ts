// An attacker's server for adversarial egress tests. It records everything and says yes to
// everything, CORS preflights included, so that if a request is not blocked it visibly succeeds:
// a test asserting "nothing arrived" can't pass because the sink refused the request.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  closeServer,
  createServer,
  listen,
  originFor,
  type RecordedRequest,
  readBody,
  recordRequest,
  type TlsOptions,
} from './http'

export interface ExfilSinkOptions {
  readonly tls?: TlsOptions
  /** The hostname reported in `origin`, e.g. evil.test. The server listens on 127.0.0.1. */
  readonly hostname?: string
  readonly port?: number
  readonly now?: () => number
}

export interface ExfilSink {
  readonly origin: string
  readonly port: number
  /** Every request received, in arrival order. Live: it keeps growing. */
  readonly requests: readonly RecordedRequest[]
  close(): Promise<void>
}

export async function startExfilSink(options: ExfilSinkOptions = {}): Promise<ExfilSink> {
  const now = options.now ?? Date.now
  const requests: RecordedRequest[] = []

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request)
    requests.push(recordRequest(request, body.text, now()))
    const headers: Record<string, string> = {
      'access-control-allow-origin': request.headers.origin ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-private-network': 'true',
      'cache-control': 'no-store',
    }
    if (request.method === 'OPTIONS') {
      headers['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
      headers['access-control-allow-headers'] = request.headers['access-control-request-headers'] ?? '*'
      response.writeHead(204, headers).end()
      return
    }
    response.writeHead(200, { ...headers, 'content-type': 'text/plain' }).end('ok')
  }

  const server = createServer(options.tls)
  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    handle(request, response).catch(
      /* v8 ignore next 4 */ () => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      },
    )
  })
  // A WebSocket handshake never reaches the request handler. Record it, then refuse it: what matters
  // to a test is that it arrived at all. Node drops its own error handler from a socket it hands
  // over, so without ours a client resetting the connection would be an uncaught exception.
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    socket.on('error', () => {})
    requests.push(recordRequest(request, '', now()))
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () =>
      socket.destroy(),
    )
  })
  const port = await listen(server, options.port ?? 0)
  return {
    origin: originFor(options.tls, options.hostname ?? '127.0.0.1', port),
    port,
    requests,
    close: () => closeServer(server),
  }
}
