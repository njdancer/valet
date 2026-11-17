import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  BBC_HOST,
  CALDAV_HOST,
  CALDAV_PARTITION,
  CARDDAV_HOST,
  CARDDAV_PARTITION,
  type ExampleServices,
  GITHUB_HOST,
  HN_HOST,
  HUB_ADDRESS,
  HUB_PORT,
  HUB_TOKEN,
  ICLOUD_APP_PASSWORD,
  ICLOUD_USER,
  REDIS_PASSWORD,
  REDIS_PORT,
  REDIS_USER,
  startExampleServices,
} from '../src'

let services: ExampleServices

beforeAll(async () => {
  services = await startExampleServices()
})
afterAll(async () => {
  await services.close()
})

const basic = `Basic ${Buffer.from(`${ICLOUD_USER}:${ICLOUD_APP_PASSWORD}`).toString('base64')}`

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function call(
  host: string,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    servername?: string
    port?: number
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: options.port ?? services.route(host, 443).port,
        path,
        method: options.method ?? 'GET',
        headers: { host, ...options.headers },
        servername: options.servername ?? host,
        ca: services.cert,
        ...(options.port === undefined ? {} : { checkServerIdentity: () => undefined }),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body ?? '')
  })
}

describe('routing', () => {
  it('routes the hub, the cache and everything else', () => {
    expect(services.route(HUB_ADDRESS, HUB_PORT).port).toBe(services.hubPort)
    expect(services.route('cache.example.com', REDIS_PORT).port).toBe(services.redisPort)
    expect(services.route(HN_HOST, 443).port).toBe(services.httpsPort)
  })

  it('refuses a request whose TLS name is not its host', async () => {
    const reply = await call(HN_HOST, '/v0/topstories.json', { servername: BBC_HOST })
    expect(reply.status).toBe(421)
  })

  it('answers 404 for a host it does not serve', async () => {
    const reply = await call('cache.example.com', '/')
    expect(reply.status).toBe(404)
  })

  it('records what it saw', async () => {
    await call(HN_HOST, '/v0/beststories.json')
    const last = services.seen.at(-1)
    expect(last).toMatchObject({
      host: HN_HOST,
      method: 'GET',
      url: '/v0/beststories.json',
      servername: HN_HOST,
    })
  })
})

describe('Hacker News', () => {
  it('serves lists and items', async () => {
    expect(JSON.parse((await call(HN_HOST, '/v0/topstories.json')).body)).toEqual([
      41001, 41002, 41003, 41004,
    ])
    expect(JSON.parse((await call(HN_HOST, '/v0/item/41001.json')).body)).toMatchObject({
      title: expect.any(String),
    })
    expect((await call(HN_HOST, '/v0/item/9.json')).body).toBe('null')
  })

  it('refuses unknown paths and writes', async () => {
    expect((await call(HN_HOST, '/v0/nope.json')).status).toBe(404)
    expect((await call(HN_HOST, '/v0/item/41001.json', { method: 'POST' })).status).toBe(405)
  })
})

describe('feeds', () => {
  it('serves RSS and Atom', async () => {
    const rss = await call(BBC_HOST, '/news/rss.xml')
    expect(rss.headers['content-type']).toContain('rss')
    expect(rss.body).toContain('Storm closes coastal roads')
    const atom = await call(GITHUB_HOST, '/nodejs/node/releases.atom')
    expect(atom.body).toContain('<entry>')
    expect(atom.body).toContain('v24.11.1')
    expect(atom.body).toContain('&lt;p&gt;Security release.&lt;/p&gt;')
  })

  it('404s anything else', async () => {
    expect((await call(BBC_HOST, '/news/nope.xml')).status).toBe(404)
    expect((await call(GITHUB_HOST, '/someone/else/releases.atom')).status).toBe(404)
    expect((await call(GITHUB_HOST, '/nodejs/node')).status).toBe(404)
  })
})

describe('CalDAV', () => {
  const propfind = (host: string, path: string, depth = '0') =>
    call(host, path, { method: 'PROPFIND', headers: { authorization: basic, depth } })

  it('needs the app-specific password', async () => {
    const reply = await call(CALDAV_HOST, '/', { method: 'PROPFIND' })
    expect(reply.status).toBe(401)
    expect(reply.headers['www-authenticate']).toContain('Basic')
  })

  it('discovers the principal and the home on the partition', async () => {
    const root = await propfind(CALDAV_HOST, '/.well-known/caldav')
    expect(root.status).toBe(207)
    expect(root.body).toContain('/1234567890/principal/')
    const principal = await propfind(CALDAV_HOST, '/1234567890/principal/')
    expect(principal.body).toContain(`https://${CALDAV_PARTITION}:443/1234567890/calendars/`)
  })

  it('keeps the account on its partition', async () => {
    expect((await propfind(CALDAV_HOST, '/1234567890/calendars/', '1')).status).toBe(404)
    expect((await propfind(CALDAV_PARTITION, '/1234567890/calendars/', '0')).status).toBe(400)
    const home = await propfind(CALDAV_PARTITION, '/1234567890/calendars/', '1')
    expect(home.status).toBe(207)
    expect(home.body).toContain('<displayname>Home</displayname>')
    expect(home.body).toContain('schedule-inbox')
  })

  it('reports events in a time range', async () => {
    const report = (body: string) =>
      call(CALDAV_PARTITION, '/1234567890/calendars/home/', {
        method: 'REPORT',
        headers: { authorization: basic, depth: '1' },
        body,
      })
    const ok = await report(
      '<c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="20261116T000000Z" end="20261123T000000Z"/></c:calendar-query>',
    )
    expect(ok.status).toBe(207)
    expect(ok.body).toContain('ev-dentist.ics')
    expect(ok.body).toContain('ev-dinner.ics')
    expect(ok.body).not.toContain('ev-old')
    expect(ok.body).toContain('Dinner\\, with friends')
    expect((await report('<calendar-query/>')).status).toBe(400)
  })

  it('creates an event once', async () => {
    const put = (path: string, body: string, headers: Record<string, string> = { 'if-none-match': '*' }) =>
      call(CALDAV_PARTITION, path, {
        method: 'PUT',
        headers: { authorization: basic, 'content-type': 'text/calendar', ...headers },
        body,
      })
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:new-1',
      'DTSTART:20261121T010000Z',
      'DTEND:20261121T020000Z',
      'SUMMARY:Lunch\\, then a walk',
      'LOCATION:The very long name of a ',
      ' park',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    expect((await put('/1234567890/calendars/home/new-1.ics', ics, {})).status).toBe(428)
    const created = await put('/1234567890/calendars/home/new-1.ics', ics)
    expect(created.status).toBe(201)
    expect(created.headers['etag']).toBe('"new-1-1"')
    expect(services.calendars[0]?.events.at(-1)).toEqual({
      uid: 'new-1',
      summary: 'Lunch, then a walk',
      start: '20261121T010000Z',
      end: '20261121T020000Z',
      location: 'The very long name of a park',
    })
    expect((await put('/1234567890/calendars/home/new-1.ics', ics)).status).toBe(412)
    expect(
      (await put('/1234567890/calendars/home/new-2.ics', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR')).status,
    ).toBe(400)
    const noLocation = ics.replace(/LOCATION.*\r\n park\r\n/, '').replace('new-1', 'new-3')
    expect((await put('/1234567890/calendars/work/new-3.ics', noLocation)).status).toBe(201)
    expect(services.calendars[1]?.events.at(-1)).not.toHaveProperty('location')
  })

  it('refuses other paths and methods', async () => {
    expect((await propfind(CALDAV_PARTITION, '/1234567890/calendars/nope/')).status).toBe(404)
    expect(
      (await call(CALDAV_PARTITION, '/1234567890/calendars/home/', { headers: { authorization: basic } }))
        .status,
    ).toBe(405)
  })
})

describe('CardDAV', () => {
  it('discovers the address book and searches it by name', async () => {
    const auth = { authorization: basic }
    expect((await call(CARDDAV_HOST, '/', { method: 'PROPFIND' })).status).toBe(401)
    const root = await call(CARDDAV_HOST, '/.well-known/carddav', { method: 'PROPFIND', headers: auth })
    expect(root.body).toContain('/1234567890/principal/')
    const principal = await call(CARDDAV_HOST, '/1234567890/principal/', {
      method: 'PROPFIND',
      headers: auth,
    })
    expect(principal.body).toContain(`https://${CARDDAV_PARTITION}:443/1234567890/carddavhome/`)
    expect(
      (await call(CARDDAV_HOST, '/1234567890/carddavhome/', { method: 'PROPFIND', headers: auth })).status,
    ).toBe(404)
    const home = await call(CARDDAV_PARTITION, '/1234567890/carddavhome/', {
      method: 'PROPFIND',
      headers: auth,
    })
    expect(home.body).toContain('card:addressbook')
    const search = (body: string) =>
      call(CARDDAV_PARTITION, '/1234567890/carddavhome/card/', { method: 'REPORT', headers: auth, body })
    const sam = await search(
      '<c:addressbook-query xmlns:c="urn:ietf:params:xml:ns:carddav"><c:filter><c:prop-filter name="FN"><c:text-match>sam</c:text-match></c:prop-filter></c:filter></c:addressbook-query>',
    )
    expect(sam.body).toContain('c-sam.vcf')
    expect(sam.body).toContain('c-sami.vcf')
    expect(sam.body).not.toContain('c-jo')
    expect(sam.body).toContain('item1.EMAIL;type=INTERNET;type=pref:sam@example.org')
    expect(sam.body).toContain('ORG:Example Pty Ltd;')
    const everyone = await search('<c:addressbook-query xmlns:c="urn:ietf:params:xml:ns:carddav"/>')
    expect(everyone.body).toContain('c-jo.vcf')
    expect((await search('<x/>')).status).toBe(400)
    expect((await call(CARDDAV_PARTITION, '/elsewhere', { headers: auth })).status).toBe(405)
  })
})

describe('the hub', () => {
  const open = (
    headers: Record<string, string> = { authorization: `Bearer ${HUB_TOKEN}` },
    path = '/api/websocket',
  ) =>
    new WebSocket(`wss://127.0.0.1:${services.hubPort}${path}`, {
      headers,
      // The hub's certificate is pinned, not named, so this client doesn't check its name.
      rejectUnauthorized: false,
    })

  const messages = (ws: WebSocket) => {
    const queue: unknown[] = []
    const waiting: ((value: unknown) => void)[] = []
    ws.on('message', (data) => {
      const value = JSON.parse(String(data))
      const next = waiting.shift()
      if (next) next(value)
      else queue.push(value)
    })
    return () =>
      new Promise<unknown>((resolve) => {
        if (queue.length > 0) resolve(queue.shift())
        else waiting.push(resolve)
      })
  }

  const refused = (ws: WebSocket) =>
    new Promise<number>((resolve) =>
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    )

  it('needs the token on the upgrade', async () => {
    expect(await refused(open({}))).toBe(401)
    expect(await refused(open(undefined, '/elsewhere'))).toBe(404)
  })

  it('serves states over REST with the same token', async () => {
    const at = { port: services.hubPort }
    expect((await call(HUB_ADDRESS, '/api/states', at)).status).toBe(401)
    const auth = { ...at, headers: { authorization: `Bearer ${HUB_TOKEN}` } }
    const states = await call(HUB_ADDRESS, '/api/states', auth)
    expect(JSON.parse(states.body)).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity_id: 'light.porch' })]),
    )
    expect((await call(HUB_ADDRESS, '/api/services/light/turn_on', { ...auth, method: 'POST' })).status).toBe(
      404,
    )
  })

  it('lists states and changes them', async () => {
    const ws = open()
    const next = messages(ws)
    expect(await next()).toMatchObject({ type: 'auth_ok' })
    ws.send(JSON.stringify({ id: 1, type: 'get_states' }))
    expect(await next()).toMatchObject({ id: 1, success: true, result: expect.arrayContaining([]) })
    ws.send(
      JSON.stringify({
        id: 2,
        type: 'call_service',
        domain: 'light',
        service: 'toggle',
        target: { entity_id: 'light.kitchen' },
      }),
    )
    expect(await next()).toMatchObject({ type: 'event' })
    expect(await next()).toMatchObject({ id: 2, success: true })
    expect(services.entities.find((e) => e.entity_id === 'light.kitchen')?.state).toBe('on')
    ws.send(
      JSON.stringify({
        id: 3,
        type: 'call_service',
        domain: 'lock',
        service: 'unlock',
        target: { entity_id: 'lock.front_door' },
      }),
    )
    await next()
    expect(await next()).toMatchObject({ id: 3, success: true })
    ws.send(
      JSON.stringify({
        id: 4,
        type: 'call_service',
        domain: 'lock',
        service: 'toggle',
        target: { entity_id: 'lock.front_door' },
      }),
    )
    expect(await next()).toMatchObject({ id: 4, success: false, error: { code: 'invalid_format' } })
    ws.send(
      JSON.stringify({
        id: 5,
        type: 'call_service',
        domain: 'light',
        service: 'turn_on',
        target: { entity_id: 'lock.front_door' },
      }),
    )
    expect(await next()).toMatchObject({ id: 5, success: false, error: { code: 'not_found' } })
    ws.send(
      JSON.stringify({
        id: 6,
        type: 'call_service',
        domain: 'sensor',
        service: 'x',
        target: { entity_id: 'sensor.living_room_temperature' },
      }),
    )
    expect(await next()).toMatchObject({ id: 6, success: false, error: { code: 'invalid_format' } })
    ws.send(JSON.stringify({ id: 7, type: 'subscribe_everything' }))
    expect(await next()).toMatchObject({ id: 7, error: { code: 'unknown_command' } })
    expect(services.hubMessages).toHaveLength(7)
    ws.close()
  })

  it('closes on garbage', async () => {
    for (const text of ['not json', '{"type":"get_states"}']) {
      const ws = open()
      const code = await new Promise<number>((resolve) => {
        ws.on('message', () => ws.send(text))
        ws.on('close', (c) => resolve(c))
      })
      expect(code).toBe(1003)
    }
  })
})

describe('the cache', () => {
  const resp = (...words: string[]) =>
    `*${words.length}\r\n${words.map((w) => `$${Buffer.byteLength(w)}\r\n${w}\r\n`).join('')}`

  function session(servername = 'cache.example.com') {
    const socket = tlsConnect({ host: '127.0.0.1', port: services.redisPort, servername, ca: services.cert })
    let text = ''
    socket.on('data', (c: Buffer) => {
      text += c.toString('utf8')
    })
    const ended = new Promise<void>((resolve) => socket.on('close', () => resolve()))
    return {
      async send(raw: string, until: string) {
        const start = text.length
        socket.write(raw)
        while (!text.slice(start).includes(until)) await new Promise((r) => setTimeout(r, 5))
        return text.slice(start)
      },
      end: () => socket.end(),
      ended,
    }
  }

  it('reads keys after AUTH and writes nothing', async () => {
    const s = session()
    expect(await s.send(resp('PING'), '\r\n')).toContain('-NOAUTH')
    expect(await s.send(resp('AUTH', REDIS_USER, 'wrong'), '\r\n')).toContain('-WRONGPASS')
    expect(await s.send(resp('AUTH', REDIS_USER, REDIS_PASSWORD), '\r\n')).toBe('+OK\r\n')
    expect(await s.send(resp('AUTH', REDIS_PASSWORD), '\r\n')).toBe('+OK\r\n')
    expect(await s.send(resp('PING'), '\r\n')).toBe('+PONG\r\n')
    expect(await s.send(resp('GET', 'weather:sydney'), '}\r\n')).toBe('$26\r\n{"tempC":24,"sky":"sunny"}\r\n')
    expect(await s.send(resp('GET', 'nope'), '\r\n')).toBe('$-1\r\n')
    expect(await s.send(resp('GET', 'secret:admin'), '\r\n')).toContain('-NOPERM')
    const scan = await s.send(resp('SCAN', '0', 'MATCH', 'weather:*', 'COUNT', '100'), 'hobart\r\n')
    expect(scan).toContain('weather:sydney')
    expect(scan).not.toContain('queue')
    const all = await s.send(resp('SCAN', '0'), 'depth\r\n')
    expect(all).not.toContain('secret')
    expect(await s.send(resp('SET', 'a', 'b'), '\r\n')).toContain('-NOPERM')
    expect(await s.send(resp('EVAL', 'x', '0'), '\r\n')).toContain("-ERR unknown command 'EVAL'")
    // Two commands in one write, and one split across writes.
    expect(await s.send(resp('PING') + resp('PING'), 'PONG\r\n+PONG\r\n')).toBe('+PONG\r\n+PONG\r\n')
    const split = resp('GET', 'queue:depth')
    s.send(split.slice(0, 7), '')
    expect(await s.send(split.slice(7), '42\r\n')).toBe('$2\r\n42\r\n')
    s.end()
    await s.ended
    expect(services.redisServernames).toContain('cache.example.com')
    expect(services.redisCommands).toContainEqual(['AUTH', REDIS_USER, '***'])
    expect(services.redisCommands).toContainEqual(['AUTH', '***'])
    expect(JSON.stringify(services.redisCommands)).not.toContain(REDIS_PASSWORD)
  })

  it('drops a client that does not speak RESP', async () => {
    for (const raw of ['GET x\r\n', '*0\r\n', '*1\r\n:3\r\n', '*1\r\n$x\r\n']) {
      const s = session()
      expect(await s.send(raw, '\r\n')).toBe('-ERR Protocol error\r\n')
      await s.ended
    }
  })
})
