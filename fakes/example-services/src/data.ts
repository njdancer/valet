// What the fake services hold: the stories, feeds, calendars, contacts, devices and cache entries the
// example adapters (examples/) read and change, and the credentials each service takes.

export const HN_HOST = 'hacker-news.firebaseio.com'
export const BBC_HOST = 'feeds.bbci.co.uk'
export const GITHUB_HOST = 'github.com'
export const CALDAV_HOST = 'caldav.icloud.com'
export const CALDAV_PARTITION = 'p01-caldav.icloud.com'
export const CARDDAV_HOST = 'contacts.icloud.com'
export const CARDDAV_PARTITION = 'p01-contacts.icloud.com'
export const REDIS_HOST = 'cache.example.com'
export const REDIS_PORT = 6380
/** The home hub, on the person's own network. */
export const HUB_ADDRESS = '192.168.1.20'
export const HUB_PORT = 8123

/** The names the TLS certificate covers. */
export const TLS_HOSTS = [
  HN_HOST,
  BBC_HOST,
  GITHUB_HOST,
  CALDAV_HOST,
  CALDAV_PARTITION,
  CARDDAV_HOST,
  CARDDAV_PARTITION,
  REDIS_HOST,
]

/** An iCloud account's Apple ID and app-specific password, as a CalDAV or CardDAV client signs in. */
export const ICLOUD_USER = 'alex@icloud.com'
export const ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop'
/** The account's number in iCloud's paths. */
export const ICLOUD_DSID = '1234567890'
/** The home hub's long-lived access token. */
export const HUB_TOKEN = 'hub_9c8b7a6f5e4d3c2b1a09'
/** The cache's user and password. */
export const REDIS_USER = 'reader'
export const REDIS_PASSWORD = 'rds_5f4e3d2c1b0a9f8e7d6c'

export interface HnItem {
  readonly id: number
  readonly type: 'story' | 'comment' | 'job'
  readonly by: string
  readonly time: number
  readonly title?: string
  readonly url?: string
  readonly text?: string
  readonly score?: number
  readonly descendants?: number
  readonly kids?: readonly number[]
  readonly parent?: number
  readonly deleted?: boolean
  readonly dead?: boolean
}

export const HN_ITEMS: readonly HnItem[] = [
  {
    id: 41001,
    type: 'story',
    by: 'pg',
    time: 1_763_370_000,
    title: 'Show HN: A calendar that reads itself',
    url: 'https://example.org/calendar',
    score: 312,
    descendants: 2,
    kids: [41010, 41011],
  },
  {
    id: 41002,
    type: 'story',
    by: 'dang',
    time: 1_763_373_600,
    title: 'Ask HN: What do you self-host?',
    text: 'I run a <i>small</i> server at home &amp; want ideas.<p>Second paragraph.',
    score: 120,
    descendants: 0,
  },
  {
    id: 41003,
    type: 'job',
    by: 'acme',
    time: 1_763_377_200,
    title: 'Acme (YC W24) is hiring',
    url: 'https://example.org/jobs',
    score: 1,
  },
  { id: 41004, type: 'story', by: 'gone', time: 1_763_380_800, deleted: true },
  {
    id: 41010,
    type: 'comment',
    by: 'alice',
    time: 1_763_371_000,
    parent: 41001,
    text: 'Love it. Does it sync with <a href="https://example.org">CalDAV</a>?',
  },
  {
    id: 41011,
    type: 'comment',
    by: 'bob',
    time: 1_763_372_000,
    parent: 41001,
    text: 'Nice &gt; nicer',
    dead: true,
  },
]

export const HN_LISTS: Readonly<Record<string, readonly number[]>> = {
  topstories: [41001, 41002, 41003, 41004],
  newstories: [41004, 41003, 41002, 41001],
  beststories: [41001],
  askstories: [41002],
  jobstories: [41003],
}

export const BBC_FEEDS: Readonly<Record<string, string>> = {
  '/news/rss.xml': rssOf('BBC News', [
    ['Storm closes coastal roads', 'https://www.bbc.co.uk/news/articles/a1', 'Mon, 16 Nov 2026 07:00:00 GMT'],
    [
      'Markets rise on <b>rate</b> hopes &amp; more',
      'https://www.bbc.co.uk/news/articles/a2',
      'Mon, 16 Nov 2026 08:30:00 GMT',
    ],
  ]),
  '/news/technology/rss.xml': rssOf('BBC News - Technology', [
    [
      'New phone has a bigger screen',
      'https://www.bbc.co.uk/news/articles/t1',
      'Tue, 17 Nov 2026 09:00:00 GMT',
    ],
  ]),
  '/news/world/rss.xml': rssOf('BBC News - World', []),
}

function rssOf(title: string, items: readonly (readonly [string, string, string])[]): string {
  const esc = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const body = items
    .map(
      ([t, link, date]) =>
        `<item><title><![CDATA[${t}]]></title><description>${esc(`About: ${t}`)}</description>` +
        `<link>${link}</link><guid isPermaLink="true">${link}</guid><pubDate>${date}</pubDate></item>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)}</title><link>https://www.bbc.co.uk/news</link><description>${esc(title)}</description>${body}</channel></rss>`
}

/** GitHub releases, Atom, by owner/repo. */
export const GITHUB_RELEASES: Readonly<
  Record<string, readonly { tag: string; date: string; notes: string }[]>
> = {
  'nodejs/node': [
    { tag: 'v24.11.1', date: '2026-11-12T10:00:00Z', notes: '<p>Security release.</p>' },
    { tag: 'v24.11.0', date: '2026-10-28T10:00:00Z', notes: '<p>Notable changes &amp; fixes.</p>' },
  ],
}

export interface CalendarEvent {
  readonly uid: string
  readonly summary: string
  readonly start: string
  readonly end: string
  readonly location?: string
}

export interface Calendar {
  readonly id: string
  readonly name: string
  readonly color: string
  readonly events: CalendarEvent[]
}

export function initialCalendars(): Calendar[] {
  return [
    {
      id: 'home',
      name: 'Home',
      color: '#34AADC',
      events: [
        {
          uid: 'ev-dentist',
          summary: 'Dentist',
          start: '20261118T090000Z',
          end: '20261118T100000Z',
          location: '12 High St, Sydney',
        },
        {
          uid: 'ev-dinner',
          summary: 'Dinner, with friends',
          start: '20261120T080000Z',
          end: '20261120T110000Z',
        },
        { uid: 'ev-old', summary: 'Last month', start: '20261001T090000Z', end: '20261001T100000Z' },
      ],
    },
    {
      id: 'work',
      name: 'Work',
      color: '#FF2968',
      events: [
        { uid: 'ev-standup', summary: 'Stand-up', start: '20261118T230000Z', end: '20261118T231500Z' },
      ],
    },
  ]
}

export interface Contact {
  readonly uid: string
  readonly name: string
  readonly emails: readonly string[]
  readonly phones: readonly string[]
  readonly org?: string
}

export const CONTACTS: readonly Contact[] = [
  {
    uid: 'c-sam',
    name: 'Sam Lee',
    emails: ['sam@example.org'],
    phones: ['+61 400 000 001'],
    org: 'Example Pty Ltd',
  },
  { uid: 'c-sami', name: 'Samira Khan', emails: ['samira@example.net', 'sk@example.org'], phones: [] },
  { uid: 'c-jo', name: 'Jo Bloggs', emails: [], phones: ['+61 2 9000 0000'] },
]

export interface HubEntity {
  readonly entity_id: string
  state: string
  readonly attributes: Readonly<Record<string, unknown>>
  last_changed: string
}

export function initialEntities(): HubEntity[] {
  return [
    {
      entity_id: 'light.kitchen',
      state: 'off',
      attributes: { friendly_name: 'Kitchen light', brightness: 0 },
      last_changed: '2026-11-17T07:00:00Z',
    },
    {
      entity_id: 'light.porch',
      state: 'on',
      attributes: { friendly_name: 'Porch light', brightness: 180 },
      last_changed: '2026-11-17T06:00:00Z',
    },
    {
      entity_id: 'sensor.living_room_temperature',
      state: '21.5',
      attributes: { friendly_name: 'Living room temperature', unit_of_measurement: '°C' },
      last_changed: '2026-11-17T08:55:00Z',
    },
    {
      entity_id: 'lock.front_door',
      state: 'locked',
      attributes: { friendly_name: 'Front door' },
      last_changed: '2026-11-17T05:00:00Z',
    },
  ]
}

export const REDIS_DATA: Readonly<Record<string, string>> = {
  'weather:sydney': '{"tempC":24,"sky":"sunny"}',
  'weather:hobart': '{"tempC":13,"sky":"rain"}',
  'queue:depth': '42',
  'secret:admin': 'not for readers',
}
