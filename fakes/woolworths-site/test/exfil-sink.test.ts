import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type ExfilSink, startExfilSink } from '../src/exfil-sink'
import { rawRequest } from './support/client'

describe('WebSocket attempts', () => {
  it('records an upgrade request, which never reaches the normal request handler', async () => {
    const sink = await start()
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: sink.port,
        path: '/socket?c=canary-ws',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('upgrade', () => reject(new Error('unexpected upgrade')))
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(501)
    expect(sink.requests).toHaveLength(1)
    expect(sink.requests[0]).toMatchObject({
      method: 'GET',
      path: '/socket',
      query: { c: 'canary-ws' },
      body: '',
    })
    expect(sink.requests[0]?.headers['upgrade']).toBe('websocket')
  })

  it('survives clients resetting upgrade connections, as a browser cancelling a WebSocket can', async () => {
    const sink = await start()
    const handshake = [
      'GET /socket?c=canary-reset HTTP/1.1',
      `Host: 127.0.0.1:${sink.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n')
    for (let i = 0; i < 20; i++) {
      const recorded = sink.requests.length
      const socket = connect(sink.port, '127.0.0.1')
      socket.on('error', () => {})
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      socket.write(handshake)
      // Reset as soon as the sink has the handshake, while it is still answering.
      while (sink.requests.length === recorded) await new Promise((resolve) => setImmediate(resolve))
      socket.resetAndDestroy()
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await fetch(`${sink.origin}/after`)).status).toBe(200)
    expect(sink.requests).toHaveLength(21)
    expect(sink.requests[0]?.target).toBe('/socket?c=canary-reset')
  })
})

const sinks: ExfilSink[] = []
afterEach(async () => {
  await Promise.all(sinks.splice(0).map((sink) => sink.close()))
})

async function start(options: Parameters<typeof startExfilSink>[0] = {}): Promise<ExfilSink> {
  const sink = await startExfilSink(options)
  sinks.push(sink)
  return sink
}

describe('startExfilSink', () => {
  it('reports 127.0.0.1 by default and the hostname it is given otherwise', async () => {
    const plain = await start()
    expect(plain.origin).toBe(`http://127.0.0.1:${plain.port}`)
    const named = await start({ hostname: 'evil.test' })
    expect(named.origin).toBe(`http://evil.test:${named.port}`)
  })

  it('records every request: method, host, path, query, headers and body', async () => {
    let now = 5
    const sink = await start({ now: () => now })
    await fetch(`${sink.origin}/collect?c=canary-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-stolen': 'canary-header' },
      body: 'canary-body',
    })
    now = 6
    await fetch(`${sink.origin}/pixel.gif`)
    expect(sink.requests).toHaveLength(2)
    expect(sink.requests[0]).toMatchObject({
      method: 'POST',
      host: '127.0.0.1',
      path: '/collect',
      query: { c: 'canary-cookie' },
      body: 'canary-body',
      at: 5,
    })
    expect(sink.requests[0]?.headers['x-stolen']).toBe('canary-header')
    expect(sink.requests[1]).toMatchObject({ method: 'GET', path: '/pixel.gif', at: 6 })
  })

  it('accepts whatever it is sent, so a leak is visible as a success rather than an error', async () => {
    const sink = await start()
    const reply = await fetch(`${sink.origin}/anything`, {
      method: 'PUT',
      headers: { origin: 'https://www.woolworths.test' },
      body: '{}',
    })
    expect(reply.status).toBe(200)
    expect(await reply.text()).toBe('ok')
    expect(reply.headers.get('access-control-allow-origin')).toBe('https://www.woolworths.test')
    expect(reply.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('answers CORS preflights with every method and requested header allowed', async () => {
    const sink = await start()
    const reply = await fetch(`${sink.origin}/collect`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://www.woolworths.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-stolen',
      },
    })
    expect(reply.status).toBe(204)
    expect(reply.headers.get('access-control-allow-headers')).toBe('content-type,x-stolen')
    expect(reply.headers.get('access-control-allow-methods')).toContain('POST')
    expect(reply.headers.get('access-control-allow-private-network')).toBe('true')
    expect(sink.requests[0]?.method).toBe('OPTIONS')
  })

  it('allows any origin and header when the request names none', async () => {
    const sink = await start()
    const reply = await fetch(`${sink.origin}/collect`, { method: 'OPTIONS' })
    expect(reply.headers.get('access-control-allow-origin')).toBe('*')
    expect(reply.headers.get('access-control-allow-headers')).toBe('*')
  })

  it('records only the first megabyte of a huge body', async () => {
    const sink = await start()
    await fetch(`${sink.origin}/big`, { method: 'POST', body: 'y'.repeat(1_200_000) })
    expect(sink.requests[0]?.body).toHaveLength(1_000_000)
  })
})

describe('nothing a leak could hide in is dropped from the record', () => {
  it('keeps a canary in a leading path segment that a URL parser would read as a host', async () => {
    const sink = await start()
    expect((await rawRequest(sink.port, 'GET', '//canary-host-segment/x')).status).toBe(200)
    expect(sink.requests[0]?.target).toBe('//canary-host-segment/x')
    expect(sink.requests[0]?.path).toBe('//canary-host-segment/x')
  })

  it('keeps a canary in the first of two repeated query parameters', async () => {
    const sink = await start()
    await rawRequest(sink.port, 'GET', '/x?leak=canary-first&leak=decoy')
    expect(sink.requests[0]?.query).toEqual({ leak: 'decoy' })
    expect(JSON.stringify(sink.requests[0])).toContain('canary-first')
  })

  it('keeps a canary in a duplicate of a header Node keeps only one of', async () => {
    const sink = await start()
    await rawRequest(sink.port, 'GET', '/x', {
      authorization: ['Bearer decoy', 'Bearer canary-second-auth'],
      referer: ['https://decoy.test/', 'https://evil.test/canary-second-referer'],
    })
    expect(sink.requests[0]?.headers['authorization']).toBe('Bearer decoy')
    const record = JSON.stringify(sink.requests[0])
    expect(record).toContain('canary-second-auth')
    expect(record).toContain('canary-second-referer')
  })

  it('keeps the target verbatim, dot segments and encoding included', async () => {
    const sink = await start()
    await rawRequest(sink.port, 'GET', '/a/../%63anary?q=%2e')
    expect(sink.requests[0]?.target).toBe('/a/../%63anary?q=%2e')
    expect(sink.requests[0]?.path).toBe('/%63anary')
  })
})
