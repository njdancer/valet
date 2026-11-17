// The example CardDAV adapter (docs/adapter-kinds.md#h-example-adapters): iCloud contacts, read
// only. Discovery as for calendars (the principal, then its address book home on the account's own
// server), then one addressbook-query REPORT that matches on the name server-side. Every request
// names the kept credential "icloud".

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { DAV, dav, escapeXml, hrefIn, responses, splitHref, textIn } from './dav'
import { readCard } from './vcard'

const ENTRY = 'https://contacts.icloud.com'
/** The servers this version's manifest declares; keep in step with its egress. */
const SERVERS = ['p01-contacts.icloud.com']
const CARDDAV = 'urn:ietf:params:xml:ns:carddav'
const CREDENTIAL = 'icloud'

async function addressBook(ctx: ToolContext): Promise<string> {
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
    '<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>',
    '0',
    CREDENTIAL,
  )
  const href = hrefIn(responses(found)[0]?.prop ?? null, 'addressbook-home-set', CARDDAV)
  const home = href === null ? null : splitHref(href, 'contacts.icloud.com')
  if (home === null || !/^\/[0-9]{1,20}\/carddavhome\/$/.test(home.path))
    throw new ValetError('tool-run', 'unexpected-shape')
  // An account on a server this version doesn't name: a new version adds it (egress, the
  // credential's hosts and the requests), as list_calendars in the calendar example says.
  if (!SERVERS.includes(home.host)) throw new ValetError('tool-run', 'host-not-allowed')
  const homeUrl = `https://${home.host}${home.path}`
  const listed = await dav(
    ctx,
    homeUrl,
    'PROPFIND',
    '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    '1',
    CREDENTIAL,
  )
  for (const r of responses(listed)) {
    const type = r.prop?.children.find((c) => typeof c !== 'string' && c.local === 'resourcetype')
    const isBook =
      type !== undefined &&
      typeof type !== 'string' &&
      type.children.some((c) => typeof c !== 'string' && c.local === 'addressbook' && c.ns === CARDDAV)
    const path = splitHref(r.href, home.host)?.path ?? ''
    if (isBook && /^\/[0-9]{1,20}\/carddavhome\/[A-Za-z0-9-]{1,64}\/$/.test(path)) return `https://${home.host}${path}`
  }
  throw new ValetError('tool-input', 'not-found')
}

export const tools = {
  find_contacts: tool({
    input: z.object({ name: z.string().trim().min(2).max(60) }),
    output: z.object({
      contacts: z.array(
        z.object({
          name: z.string(),
          emails: z.array(z.string()),
          phones: z.array(z.string()),
          organisation: z.string().nullable(),
        }),
      ),
    }),
    async run(ctx, input) {
      const book = await addressBook(ctx)
      const found = await dav(
        ctx,
        book,
        'REPORT',
        '<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
          '<d:prop><d:getetag/><card:address-data/></d:prop>' +
          '<card:filter><card:prop-filter name="FN">' +
          `<card:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(input.name)}</card:text-match>` +
          '</card:prop-filter></card:filter><card:limit><card:nresults>20</card:nresults></card:limit></card:addressbook-query>',
        '1',
        CREDENTIAL,
      )
      const contacts = responses(found)
        .map((r) => readCard(textIn(r.prop, 'address-data', CARDDAV) ?? ''))
        .filter((c) => c !== null)
        .slice(0, 20)
      contacts.sort((a, b) => a.name.localeCompare(b.name))
      return { contacts }
    },
  }),
}
