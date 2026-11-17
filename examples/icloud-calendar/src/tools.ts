// The example CalDAV adapter (docs/adapter-kinds.md#h-example-adapters): iCloud calendars, over
// http with WebDAV's own methods. Every request names the kept credential "icloud", so Valet adds
// the Basic header for the hosts the manifest names, and tool code never holds the password.
//
// iCloud discovery goes in two steps: caldav.icloud.com names the account's principal, and the
// principal names its calendar home, which is on the account's own server (pNN-caldav.icloud.com).
// The manifest can only name exact hosts, so it names one; an account on another server gets that
// server's name from list_calendars, to add to egress, the credential's hosts and the requests.

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { DAV, dav, hrefIn, responses, splitHref, textIn } from './dav'
import { readEvents, writeEvent } from './ics'

const ENTRY = 'https://caldav.icloud.com'
/** The servers this version's manifest declares; keep in step with its egress. */
const SERVERS = ['p01-caldav.icloud.com']
const CALDAV = 'urn:ietf:params:xml:ns:caldav'
const APPLE = 'http://apple.com/ns/ical/'
const CREDENTIAL = 'icloud'
const ID = /^[A-Za-z0-9-]{1,64}$/
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const DAY_MS = 86_400_000

interface Home {
  /** The account's server, as discovery named it. */
  readonly server: string
  /** The calendar home's URL, or null when the server isn't one this version may reach. */
  readonly url: string | null
}

/** Discovery: the principal, then its calendar home. Two requests. */
async function home(ctx: ToolContext): Promise<Home> {
  const root = await dav(
    ctx,
    `${ENTRY}/`,
    'PROPFIND',
    '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
    '0',
    CREDENTIAL,
  )
  const principal = hrefIn(responses(root)[0]?.prop ?? null, 'current-user-principal', DAV)
  if (principal === null || !/^\/[0-9]{1,20}\/principal\/$/.test(principal))
    throw new ValetError('tool-run', 'unexpected-shape')
  const found = await dav(
    ctx,
    `${ENTRY}${principal}`,
    'PROPFIND',
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>',
    '0',
    CREDENTIAL,
  )
  const href = hrefIn(responses(found)[0]?.prop ?? null, 'calendar-home-set', CALDAV)
  const at = href === null ? null : splitHref(href, 'caldav.icloud.com')
  if (at === null || !/^\/[0-9]{1,20}\/calendars\/$/.test(at.path))
    throw new ValetError('tool-run', 'unexpected-shape')
  return { server: at.host, url: SERVERS.includes(at.host) ? `https://${at.host}${at.path}` : null }
}

/** The home, or a refusal naming nothing secret when the account's server isn't declared. */
async function reachableHome(ctx: ToolContext): Promise<string> {
  const h = await home(ctx)
  // list_calendars says which server to add; the other tools can only refuse.
  if (h.url === null) throw new ValetError('tool-run', 'host-not-allowed')
  return h.url
}

interface CalendarInfo {
  id: string
  name: string
  color: string | null
}

async function calendars(ctx: ToolContext, homeUrl: string): Promise<CalendarInfo[]> {
  const listed = await dav(
    ctx,
    homeUrl,
    'PROPFIND',
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">' +
      '<d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/></d:prop></d:propfind>',
    '1',
    CREDENTIAL,
  )
  const homePath = homeUrl.replace(/^https:\/\/[^/]+/, '')
  const out: CalendarInfo[] = []
  for (const r of responses(listed)) {
    const type =
      r.prop === null
        ? null
        : r.prop.children.find((c) => typeof c !== 'string' && c.local === 'resourcetype')
    const isCalendar =
      type !== undefined &&
      type !== null &&
      typeof type !== 'string' &&
      type.children.some((c) => typeof c !== 'string' && c.local === 'calendar' && c.ns === CALDAV)
    if (!isCalendar || r.prop === null) continue
    // A calendar may hold tasks only (Reminders): leave out any that says it holds no events.
    const set = r.prop.children.find(
      (c) => typeof c !== 'string' && c.local === 'supported-calendar-component-set',
    )
    if (set !== undefined && typeof set !== 'string') {
      const names = set.children.flatMap((c) => (typeof c === 'string' ? [] : [c.attributes['name'] ?? '']))
      if (names.length > 0 && !names.includes('VEVENT')) continue
    }
    const path = splitHref(r.href, '')?.path ?? ''
    const id = path.startsWith(homePath) ? path.slice(homePath.length).replace(/\/$/, '') : ''
    if (!ID.test(id)) continue
    const color = textIn(r.prop, 'calendar-color', APPLE)
    out.push({
      id,
      name: (textIn(r.prop, 'displayname', DAV) ?? id).slice(0, 100),
      color: color !== null && /^#[0-9A-Fa-f]{6}/.test(color) ? color.slice(0, 7).toUpperCase() : null,
    })
  }
  return out
}

/** A stable id for an event from what it is, so adding it twice finds the first. FNV-1a, 64-bit, over UTF-16 code units. */
export function eventUid(fields: readonly string[]): string {
  let hash = 0xcbf29ce484222325n
  const text = fields.join('\u0000')
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `valet-${hash.toString(16).padStart(16, '0')}`
}

const event = z.object({
  calendar: z.string(),
  title: z.string(),
  /** ISO 8601: UTC with Z, local time with timeZone, or a date for an all-day event. */
  start: z.string(),
  end: z.string().nullable(),
  allDay: z.boolean(),
  timeZone: z.string().nullable(),
  location: z.string().nullable(),
})

export const tools = {
  list_calendars: tool({
    input: z.object({}),
    output: z.object({
      server: z.string(),
      /** False when the account is on a server this version's manifest doesn't name: add it. */
      reachable: z.boolean(),
      calendars: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().nullable() })),
    }),
    async run(ctx) {
      const h = await home(ctx)
      return {
        server: h.server,
        reachable: h.url !== null,
        calendars: h.url === null ? [] : await calendars(ctx, h.url),
      }
    },
  }),

  list_events: tool({
    input: z.object({
      from: z.string().regex(UTC),
      to: z.string().regex(UTC),
      /** One calendar's id, from list_calendars; all of them when left out. */
      calendar: z.string().regex(ID).optional(),
    }),
    output: z.object({ events: z.array(event) }),
    async run(ctx, input) {
      const from = Date.parse(input.from)
      const to = Date.parse(input.to)
      if (!(to > from) || to - from > 62 * DAY_MS) throw new ValetError('tool-input', 'invalid')
      const homeUrl = await reachableHome(ctx)
      const ids =
        input.calendar === undefined ? (await calendars(ctx, homeUrl)).map((c) => c.id) : [input.calendar]
      const range = `start="${icsStamp(from)}" end="${icsStamp(to)}"`
      const events: z.infer<typeof event>[] = []
      for (const id of ids.slice(0, 8)) {
        const found = await dav(
          ctx,
          `${homeUrl}${id}/`,
          'REPORT',
          '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
            `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter>` +
            '</c:calendar-query>',
          '1',
          CREDENTIAL,
        )
        for (const r of responses(found)) {
          const data = textIn(r.prop, 'calendar-data', CALDAV)
          if (data === null) continue
          for (const e of readEvents(data))
            events.push({
              calendar: id,
              title: e.title.slice(0, 300),
              start: e.start,
              end: e.end,
              allDay: e.allDay,
              timeZone: e.timeZone,
              location: e.location === null ? null : e.location.slice(0, 300),
            })
        }
      }
      events.sort((a, b) => a.start.localeCompare(b.start))
      return { events: events.slice(0, 200) }
    },
  }),

  add_event: tool({
    input: z.object({
      calendar: z.string().regex(ID),
      title: z.string().min(1).max(200),
      start: z.string().regex(UTC),
      end: z.string().regex(UTC),
      location: z.string().min(1).max(200).optional(),
    }),
    output: z.object({ uid: z.string(), created: z.boolean() }),
    async run(ctx, input) {
      if (!(Date.parse(input.end) > Date.parse(input.start))) throw new ValetError('tool-input', 'invalid')
      const homeUrl = await reachableHome(ctx)
      const uid = eventUid([input.calendar, input.title, input.start, input.end, input.location ?? ''])
      if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
      const response = await ctx.http.fetch(`${homeUrl}${input.calendar}/${uid}.ics`, {
        method: 'PUT',
        // Only if nothing is there: the same event added again is a 412, not a second copy.
        headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
        body: writeEvent({
          uid,
          title: input.title,
          start: input.start,
          end: input.end,
          location: input.location ?? null,
          stamp: icsStamp(Date.now()),
        }),
        credential: CREDENTIAL,
      })
      if (response.status === 201 || response.status === 204) return { uid, created: true }
      if (response.status === 412) return { uid, created: false }
      if (response.status === 401 || response.status === 403) throw new ValetError('tool-run', 'auth-failed')
      if (response.status === 404 || response.status === 409) throw new ValetError('tool-run', 'not-found')
      throw new ValetError('tool-run', 'unavailable')
    },
  }),
}

function icsStamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
}
