// iCloud-shaped CalDAV and CardDAV (RFC 4791, RFC 6352), as much as the example adapters use:
// discovery from the well-known host to the account's partition host, calendars and the address
// book by PROPFIND, events by a calendar-query REPORT with a time range, contacts by an
// addressbook-query REPORT on the name, and a new event by PUT. Every request needs the account's
// app-specific password over Basic auth, as iCloud's does.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CALDAV_HOST,
  CALDAV_PARTITION,
  CARDDAV_HOST,
  CARDDAV_PARTITION,
  type Calendar,
  CONTACTS,
  type Contact,
  ICLOUD_APP_PASSWORD,
  ICLOUD_DSID,
  ICLOUD_USER,
} from './data'

const DAV_HEADERS = {
  'content-type': 'application/xml; charset=utf-8',
  dav: '1, 2, calendar-access, addressbook',
}

const xmlEscape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function multistatus(responses: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:ical="http://apple.com/ns/ical/">' +
    `${responses}</multistatus>`
  )
}

const response = (href: string, props: string) =>
  `<response><href>${xmlEscape(href)}</href><propstat><prop>${props}</prop><status>HTTP/1.1 200 OK</status></propstat></response>`

export function authorized(req: IncomingMessage): boolean {
  const expected = `Basic ${Buffer.from(`${ICLOUD_USER}:${ICLOUD_APP_PASSWORD}`).toString('base64')}`
  return req.headers.authorization === expected
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): true {
  res.writeHead(status, { ...DAV_HEADERS, ...headers })
  res.end(body)
  return true
}

export function icsOf(event: Calendar['events'][number]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fake iCloud//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:20261101T000000Z`,
    `DTSTART:${event.start}`,
    `DTEND:${event.end}`,
    // RFC 5545 escapes commas and folds long lines; the reader must undo both.
    `SUMMARY:${event.summary.replaceAll(',', '\\,')}`,
    ...(event.location === undefined ? [] : [fold(`LOCATION:${event.location.replaceAll(',', '\\,')}`)]),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

function fold(line: string): string {
  if (line.length <= 20) return line
  return `${line.slice(0, 20)}\r\n ${line.slice(20)}`
}

export function vcardOf(contact: Contact): string {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:${contact.uid}`,
    `FN:${contact.name}`,
    ...contact.emails.map((e, i) => `item${i + 1}.EMAIL;type=INTERNET${i === 0 ? ';type=pref' : ''}:${e}`),
    ...contact.phones.map((p) => `TEL;type=CELL:${p}`),
    ...(contact.org === undefined ? [] : [`ORG:${contact.org};`]),
    'END:VCARD',
    '',
  ].join('\r\n')
}

/** iCloud's UTC form, YYYYMMDDTHHMMSSZ, as a number that sorts. */
const stamp = (value: string) => Number(value.replace(/\D/g, '').slice(0, 14))

/** The CalDAV side, on caldav.icloud.com and the account's partition. */
export function caldav(
  req: IncomingMessage,
  res: ServerResponse,
  host: string,
  body: string,
  calendars: Calendar[],
): true {
  if (host !== CALDAV_HOST && host !== CALDAV_PARTITION) return send(res, 404, '')
  if (!authorized(req))
    return send(res, 401, '', {
      'www-authenticate': 'Basic realm="Apple iCloud"',
      'content-type': 'text/plain',
    })
  const path = new URL(req.url ?? '/', 'https://x').pathname
  const method = req.method ?? 'GET'
  const principal = `/${ICLOUD_DSID}/principal/`
  const home = `/${ICLOUD_DSID}/calendars/`
  if (method === 'PROPFIND' && (path === '/' || path === '/.well-known/caldav'))
    return send(
      res,
      207,
      multistatus(
        response('/', `<current-user-principal><href>${principal}</href></current-user-principal>`),
      ),
    )
  if (method === 'PROPFIND' && path === principal)
    return send(
      res,
      207,
      multistatus(
        response(
          principal,
          `<cal:calendar-home-set><href>https://${CALDAV_PARTITION}:443${home}</href></cal:calendar-home-set>`,
        ),
      ),
    )
  // The account's data lives only on its partition host.
  if (host !== CALDAV_PARTITION) return send(res, 404, '')
  if (method === 'PROPFIND' && path === home) {
    if (req.headers['depth'] !== '1') return send(res, 400, '')
    const rows = [
      response(home, '<resourcetype><collection/></resourcetype>'),
      ...calendars.map((c) =>
        response(
          `${home}${c.id}/`,
          `<resourcetype><collection/><cal:calendar/></resourcetype><displayname>${xmlEscape(c.name)}</displayname><ical:calendar-color>${c.color}FF</ical:calendar-color><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>`,
        ),
      ),
      // Not a calendar: a client must look at resourcetype, not take every child.
      response(`${home}inbox/`, '<resourcetype><collection/><cal:schedule-inbox/></resourcetype>'),
      response(
        `${home}tasks/`,
        '<resourcetype><collection/><cal:calendar/></resourcetype><displayname>Reminders</displayname><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>',
      ),
    ]
    return send(res, 207, multistatus(rows.join('')))
  }
  const match = /^\/[0-9]+\/calendars\/([a-z0-9-]+)\/(?:([A-Za-z0-9._-]+\.ics))?$/.exec(path)
  const calendar = match === null ? undefined : calendars.find((c) => c.id === match[1])
  if (match === null || calendar === undefined) return send(res, 404, '')
  if (method === 'REPORT' && match[2] === undefined) {
    const range = /time-range\s+start="(\d{8}T\d{6}Z)"\s+end="(\d{8}T\d{6}Z)"/.exec(body)
    if (range === null || !body.includes('calendar-query')) return send(res, 400, '')
    const [from, to] = [stamp(range[1] as string), stamp(range[2] as string)]
    const rows = calendar.events
      .filter((e) => stamp(e.end) > from && stamp(e.start) < to)
      .map((e) =>
        response(
          `${home}${calendar.id}/${e.uid}.ics`,
          `<getetag>"${e.uid}-1"</getetag><cal:calendar-data>${xmlEscape(icsOf(e))}</cal:calendar-data>`,
        ),
      )
    return send(res, 207, multistatus(rows.join('')))
  }
  if (method === 'PUT' && match[2] !== undefined) {
    const uid = match[2].slice(0, -'.ics'.length)
    if (req.headers['if-none-match'] !== '*') return send(res, 428, '')
    if (calendar.events.some((e) => e.uid === uid)) return send(res, 412, '')
    const field = (name: string) =>
      new RegExp(`^${name}[^:]*:(.*)$`, 'm').exec(body.replaceAll('\r\n ', ''))?.[1]
    const summary = field('SUMMARY')
    const start = field('DTSTART')
    const end = field('DTEND')
    if (
      !body.startsWith('BEGIN:VCALENDAR') ||
      summary === undefined ||
      start === undefined ||
      end === undefined
    )
      return send(res, 400, '')
    const location = field('LOCATION')
    calendar.events.push({
      uid,
      summary: summary.replaceAll('\\,', ','),
      start,
      end,
      ...(location === undefined ? {} : { location: location.replaceAll('\\,', ',') }),
    })
    return send(res, 201, '', { etag: `"${uid}-1"` })
  }
  return send(res, 405, '')
}

/** The CardDAV side, on contacts.icloud.com and the account's partition. */
export function carddav(req: IncomingMessage, res: ServerResponse, host: string, body: string): true {
  if (host !== CARDDAV_HOST && host !== CARDDAV_PARTITION) return send(res, 404, '')
  if (!authorized(req))
    return send(res, 401, '', {
      'www-authenticate': 'Basic realm="Apple iCloud"',
      'content-type': 'text/plain',
    })
  const path = new URL(req.url ?? '/', 'https://x').pathname
  const method = req.method ?? 'GET'
  const principal = `/${ICLOUD_DSID}/principal/`
  const home = `/${ICLOUD_DSID}/carddavhome/`
  if (method === 'PROPFIND' && (path === '/' || path === '/.well-known/carddav'))
    return send(
      res,
      207,
      multistatus(
        response('/', `<current-user-principal><href>${principal}</href></current-user-principal>`),
      ),
    )
  if (method === 'PROPFIND' && path === principal)
    return send(
      res,
      207,
      multistatus(
        response(
          principal,
          `<card:addressbook-home-set><href>https://${CARDDAV_PARTITION}:443${home}</href></card:addressbook-home-set>`,
        ),
      ),
    )
  if (host !== CARDDAV_PARTITION) return send(res, 404, '')
  if (method === 'PROPFIND' && path === home)
    return send(
      res,
      207,
      multistatus(
        response(home, '<resourcetype><collection/></resourcetype>') +
          response(
            `${home}card/`,
            '<resourcetype><collection/><card:addressbook/></resourcetype><displayname>Contacts</displayname>',
          ),
      ),
    )
  if (method === 'REPORT' && path === `${home}card/`) {
    if (!body.includes('addressbook-query')) return send(res, 400, '')
    const text = /<(?:[a-z]+:)?text-match[^>]*>([^<]*)</.exec(body)?.[1]?.trim().toLowerCase() ?? ''
    const rows = CONTACTS.filter((c) => text === '' || c.name.toLowerCase().includes(text)).map((c) =>
      response(
        `${home}card/${c.uid}.vcf`,
        `<getetag>"${c.uid}-1"</getetag><card:address-data>${xmlEscape(vcardOf(c))}</card:address-data>`,
      ),
    )
    return send(res, 207, multistatus(rows.join('')))
  }
  return send(res, 405, '')
}
