// One HTTP/1.1 exchange over a connection the broker dialled (dial.ts): the request goes out on that
// socket and nowhere else, the response comes back capped in size and time, and the connection is
// closed afterwards. No redirect is followed, no cookie is kept, and nothing is decompressed, so a
// compressed response is returned as the bytes it is and can't expand past the cap.

import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { ValetError } from '@valet/core'

/** 2 MB, so that a body still fits the tool channel once written as base64. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024
export const EXCHANGE_TIMEOUT_MS = 30_000
/** Response headers past this many bytes are refused, like an oversized body. */
export const MAX_RESPONSE_HEADER_BYTES = 64 * 1024

export interface Exchange {
  readonly method: string
  /** Where the request goes: its Host header and request target come from here. */
  readonly url: URL
  /** Lower-case names, already checked by the caller. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer | null
}

export interface ExchangeResult {
  readonly status: number
  /** Lower-case names; `set-cookie` never included; repeated headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
}

export interface ExchangeOptions {
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly signal?: AbortSignal
  /** Told each received chunk's size, headers included, as it arrives. */
  readonly onReceive?: (bytes: number) => void
}

/** The bytes a request puts on the wire, near enough to budget: request line, headers, body. */
export function requestSize(exchange: Exchange): number {
  let size = exchange.method.length + exchange.url.pathname.length + exchange.url.search.length + 12
  size += exchange.url.host.length + 8 // Host
  for (const [name, value] of Object.entries(exchange.headers)) size += name.length + value.length + 4
  // content-length and connection, which Node adds.
  return size + 48 + (exchange.body?.byteLength ?? 0)
}

const fail = (
  stage: 'egress' | 'tool-run',
  errorClass: 'unavailable' | 'unexpected-shape' | 'timed-out' | 'aborted',
) => new ValetError(stage, errorClass)

/** Sends `exchange` on `socket` and reads the whole response. The socket is destroyed when it ends. */
export function exchangeOn(
  socket: Socket,
  exchange: Exchange,
  options: ExchangeOptions = {},
): Promise<ExchangeResult> {
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: ValetError | null, result?: ExchangeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      req.destroy()
      socket.destroy()
      if (error === null) resolve(result as ExchangeResult)
      else reject(error)
    }
    const headers: Record<string, string> = {
      ...exchange.headers,
      host: exchange.url.host,
      connection: 'close',
    }
    if (exchange.body !== null) headers['content-length'] = String(exchange.body.byteLength)
    const req = httpRequest({
      method: exchange.method,
      path: `${exchange.url.pathname}${exchange.url.search}`,
      headers,
      setHost: false,
      // No agent at all, so the request can only use the socket createConnection hands it (with
      // `agent: false` Node would make an agent of its own and dial the URL's host itself).
      agent: undefined,
      createConnection: () => socket,
      maxHeaderSize: MAX_RESPONSE_HEADER_BYTES,
      // Whatever a server sends is passed back as data, never acted on.
      insecureHTTPParser: false,
    })
    const timer = setTimeout(
      () => finish(fail('tool-run', 'timed-out')),
      options.timeoutMs ?? EXCHANGE_TIMEOUT_MS,
    )
    const onAbort = () => finish(fail('tool-run', 'aborted'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    req.on('error', () => finish(fail('egress', 'unavailable')))
    req.on('response', (response: IncomingMessage) => {
      let headerBytes = 0
      for (const value of response.rawHeaders) headerBytes += value.length + 2
      options.onReceive?.(headerBytes + 16)
      const declared = Number(response.headers['content-length'])
      if (Number.isFinite(declared) && declared > maxBytes)
        return finish(fail('tool-run', 'unexpected-shape'))
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        options.onReceive?.(chunk.byteLength)
        if (size > maxBytes) return finish(fail('tool-run', 'unexpected-shape'))
        chunks.push(chunk)
      })
      response.on('error', () => finish(fail('egress', 'unavailable')))
      response.on('aborted', () => finish(fail('egress', 'unavailable')))
      response.on('end', () => {
        const out: Record<string, string> = {}
        for (const [name, value] of Object.entries(response.headers)) {
          if (name === 'set-cookie' || value === undefined) continue
          out[name] = Array.isArray(value) ? value.join(', ') : value
        }
        finish(null, { status: response.statusCode ?? 0, headers: out, body: Buffer.concat(chunks, size) })
      })
    })
    if (exchange.body !== null) req.end(exchange.body)
    else req.end()
  })
}
