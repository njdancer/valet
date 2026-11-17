// A small XML reader and a feed parser for tool code (docs/adapter-kinds.md#ctxhttp): RSS 2.0,
// RSS 1.0, Atom and JSON Feed, and the XML that CalDAV and CardDAV answer with. Pure TypeScript
// with no Node imports, so the tool library bundles it for the isolated tool process.
//
// The XML is whatever a server sent, so the reader takes only what a feed or a WebDAV answer needs
// and refuses the rest: no DOCTYPE (so no entity declarations, no external entities, no entity
// expansion bombs), only the five predefined entities and character references, and bounds on size,
// depth, elements and attributes. Anything it can't read plainly throws
// `tool-run/unexpected-shape`.

import { ValetError } from './errors'

export const MAX_XML_CHARS = 4 * 1024 * 1024
const MAX_DEPTH = 100
const MAX_ELEMENTS = 200_000
const MAX_ATTRIBUTES = 64
export const MAX_FEED_ITEMS = 1000

export interface XmlElement {
  /** The name as written, prefix included. */
  readonly name: string
  /** The name without its prefix. */
  readonly local: string
  /** The namespace URI the prefix (or the default namespace) resolves to; '' for none. */
  readonly ns: string
  /** By name as written. */
  readonly attributes: Readonly<Record<string, string>>
  /** Elements and text, in order. */
  readonly children: readonly (XmlElement | string)[]
}

const fail = (): never => {
  throw new ValetError('tool-run', 'unexpected-shape')
}

const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
const NAME = /[A-Za-z_][A-Za-z0-9_.:-]{0,127}/y
const XML_NS = 'http://www.w3.org/XML/1998/namespace'

/** Text with its references replaced. Refuses any entity but the predefined five. */
function decodeText(raw: string): string {
  if (!raw.includes('&')) return raw
  let out = ''
  let at = 0
  while (at < raw.length) {
    const amp = raw.indexOf('&', at)
    if (amp === -1) {
      out += raw.slice(at)
      break
    }
    out += raw.slice(at, amp)
    const semi = raw.indexOf(';', amp)
    if (semi === -1 || semi - amp > 12) fail()
    const ref = raw.slice(amp + 1, semi)
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x'
      const digits = ref.slice(hex ? 2 : 1)
      if (!(hex ? /^[0-9A-Fa-f]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) fail()
      const code = Number.parseInt(digits, hex ? 16 : 10)
      const allowed =
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      if (!allowed) fail()
      out += String.fromCodePoint(code)
    } else {
      const value = Object.hasOwn(PREDEFINED, ref) ? PREDEFINED[ref] : undefined
      if (value === undefined) fail()
      out += value
    }
    at = semi + 1
  }
  return out
}

interface Open {
  readonly name: string
  readonly attributes: Record<string, string>
  readonly children: (XmlElement | string)[]
  readonly scope: ReadonlyMap<string, string>
}

/** Reads one XML document. Throws `tool-run/unexpected-shape` on anything it doesn't take. */
export function parseXml(text: string): XmlElement {
  if (typeof text !== 'string' || text.length > MAX_XML_CHARS) fail()
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0
  let elements = 0
  const stack: Open[] = []
  let root: XmlElement | null = null
  const rootScope = new Map<string, string>([['xml', XML_NS]])

  const readName = (): string => {
    NAME.lastIndex = at
    const match = NAME.exec(text)
    if (match === null) fail()
    at = NAME.lastIndex
    return (match as RegExpExecArray)[0]
  }
  const skipSpace = (): void => {
    while (at < text.length && ' \t\r\n'.includes(text[at] as string)) at++
  }
  const close = (open: Open): XmlElement => {
    const colon = open.name.indexOf(':')
    const prefix = colon === -1 ? '' : open.name.slice(0, colon)
    const ns = open.scope.get(prefix)
    if (ns === undefined && prefix !== '') fail()
    return Object.freeze({
      name: open.name,
      local: colon === -1 ? open.name : open.name.slice(colon + 1),
      ns: ns ?? '',
      attributes: Object.freeze(open.attributes),
      children: Object.freeze(open.children),
    })
  }

  while (at < text.length) {
    const lt = text.indexOf('<', at)
    const chunk = lt === -1 ? text.slice(at) : text.slice(at, lt)
    if (chunk.length > 0) {
      const top = stack.at(-1)
      if (top === undefined) {
        if (chunk.trim() !== '') fail()
      } else top.children.push(decodeText(chunk))
    }
    if (lt === -1) break
    at = lt
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4)
      if (end === -1) fail()
      at = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', at)) {
      const top = stack.at(-1)
      if (top === undefined) fail()
      const end = text.indexOf(']]>', at + 9)
      if (end === -1) fail()
      top?.children.push(text.slice(at + 9, end))
      at = end + 3
      continue
    }
    // A DOCTYPE, and with it every entity declaration, is refused outright.
    if (text.startsWith('<!', at)) fail()
    if (text.startsWith('<?', at)) {
      const end = text.indexOf('?>', at + 2)
      if (end === -1) fail()
      at = end + 2
      continue
    }
    if (text.startsWith('</', at)) {
      at += 2
      const name = readName()
      skipSpace()
      if (text[at] !== '>') fail()
      at++
      const open = stack.pop()
      if (open === undefined || open.name !== name) fail()
      const element = close(open as Open)
      const parent = stack.at(-1)
      if (parent === undefined) root = element
      else parent.children.push(element)
      continue
    }
    // A start tag.
    if (root !== null) fail()
    at++
    const name = readName()
    if (++elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) fail()
    const attributes: Record<string, string> = Object.create(null)
    let count = 0
    let selfClosing = false
    while (true) {
      const before = at
      skipSpace()
      if (text.startsWith('/>', at)) {
        selfClosing = true
        at += 2
        break
      }
      if (text[at] === '>') {
        at++
        break
      }
      if (at === before) fail()
      const attribute = readName()
      skipSpace()
      if (text[at] !== '=') fail()
      at++
      skipSpace()
      const quote = text[at]
      if (quote !== '"' && quote !== "'") fail()
      const end = text.indexOf(quote as string, at + 1)
      if (end === -1) fail()
      const raw = text.slice(at + 1, end)
      if (raw.includes('<')) fail()
      if (Object.hasOwn(attributes, attribute) || ++count > MAX_ATTRIBUTES) fail()
      attributes[attribute] = decodeText(raw)
      at = end + 1
    }
    const parentScope = stack.at(-1)?.scope ?? rootScope
    let scope: ReadonlyMap<string, string> = parentScope
    for (const [attribute, value] of Object.entries(attributes)) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) {
        if (scope === parentScope) scope = new Map(parentScope)
        ;(scope as Map<string, string>).set(attribute === 'xmlns' ? '' : attribute.slice(6), value)
      }
    }
    const open: Open = { name, attributes, children: [], scope }
    if (selfClosing) {
      const element = close(open)
      const parent = stack.at(-1)
      if (parent === undefined) root = element
      else parent.children.push(element)
    } else stack.push(open)
  }
  if (stack.length > 0 || root === null) fail()
  return root as XmlElement
}

/** The element's text, its descendants' included, in order. */
export function xmlText(element: XmlElement): string {
  let out = ''
  for (const child of element.children) out += typeof child === 'string' ? child : xmlText(child)
  return out
}

/** The child elements, those named `local` (in namespace `ns` if given) if a name is given. */
export function xmlChildren(element: XmlElement, local?: string, ns?: string): XmlElement[] {
  const out: XmlElement[] = []
  for (const child of element.children) {
    if (typeof child === 'string') continue
    if (local !== undefined && child.local !== local) continue
    if (ns !== undefined && child.ns !== ns) continue
    out.push(child)
  }
  return out
}

/** The first child element named `local` (in namespace `ns` if given), or null. */
export function xmlChild(element: XmlElement, local: string, ns?: string): XmlElement | null {
  return xmlChildren(element, local, ns)[0] ?? null
}

export interface FeedItem {
  readonly id: string | null
  readonly title: string | null
  readonly link: string | null
  /** ISO 8601, or null when the feed gives no date it can read. */
  readonly published: string | null
  readonly updated: string | null
  /** As the feed gives it: often HTML. */
  readonly summary: string | null
  readonly content: string | null
  readonly author: string | null
}

export interface Feed {
  readonly format: 'rss' | 'atom' | 'json'
  readonly title: string | null
  readonly link: string | null
  readonly description: string | null
  readonly items: readonly FeedItem[]
}

const ATOM_NS = 'http://www.w3.org/2005/Atom'
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/'
const DC_NS = 'http://purl.org/dc/elements/1.1/'
const MAX_FIELD_CHARS = 256 * 1024

function field(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed.slice(0, MAX_FIELD_CHARS)
}

function date(value: unknown): string | null {
  const text = field(value)
  if (text === null) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const textOf = (element: XmlElement | null): string | null =>
  element === null ? null : field(xmlText(element))

/**
 * Reads an RSS, Atom or JSON Feed document into one shape. Throws `tool-run/unexpected-shape`
 * when it isn't one of those, or isn't something the XML reader takes.
 */
export function parseFeed(text: string): Feed {
  if (typeof text !== 'string') fail()
  const start = text.replace(/^﻿/, '').trimStart()
  if (start.startsWith('{')) return jsonFeed(start)
  const root = parseXml(text)
  if (root.local === 'rss') {
    const channel = xmlChild(root, 'channel')
    if (channel === null) fail()
    return rss(channel as XmlElement, xmlChildren(channel as XmlElement, 'item'))
  }
  if (root.local === 'RDF') {
    const channel = xmlChild(root, 'channel')
    if (channel === null) fail()
    return rss(channel as XmlElement, xmlChildren(root, 'item'))
  }
  if (root.local === 'feed' && root.ns === ATOM_NS) return atom(root)
  return fail()
}

function rss(channel: XmlElement, items: readonly XmlElement[]): Feed {
  return {
    format: 'rss',
    title: textOf(xmlChild(channel, 'title')),
    link: textOf(xmlChild(channel, 'link', '')) ?? textOf(xmlChild(channel, 'link')),
    description: textOf(xmlChild(channel, 'description')),
    items: items.slice(0, MAX_FEED_ITEMS).map((item) => ({
      id: textOf(xmlChild(item, 'guid')) ?? item.attributes['rdf:about'] ?? null,
      title: textOf(xmlChild(item, 'title')),
      link: textOf(xmlChild(item, 'link')),
      published: date(textOf(xmlChild(item, 'pubDate')) ?? textOf(xmlChild(item, 'date', DC_NS))),
      updated: null,
      summary: textOf(xmlChild(item, 'description')),
      content: textOf(xmlChild(item, 'encoded', CONTENT_NS)),
      author: textOf(xmlChild(item, 'author')) ?? textOf(xmlChild(item, 'creator', DC_NS)),
    })),
  }
}

function atomLink(element: XmlElement): string | null {
  const links = xmlChildren(element, 'link', ATOM_NS)
  const alternate = links.find((l) => (l.attributes['rel'] ?? 'alternate') === 'alternate') ?? links[0]
  return field(alternate?.attributes['href'])
}

function atom(feed: XmlElement): Feed {
  const child = (e: XmlElement, name: string) => xmlChild(e, name, ATOM_NS)
  return {
    format: 'atom',
    title: textOf(child(feed, 'title')),
    link: atomLink(feed),
    description: textOf(child(feed, 'subtitle')),
    items: xmlChildren(feed, 'entry', ATOM_NS)
      .slice(0, MAX_FEED_ITEMS)
      .map((entry) => {
        const author = child(entry, 'author')
        return {
          id: textOf(child(entry, 'id')),
          title: textOf(child(entry, 'title')),
          link: atomLink(entry),
          published: date(textOf(child(entry, 'published'))),
          updated: date(textOf(child(entry, 'updated'))),
          summary: textOf(child(entry, 'summary')),
          content: textOf(child(entry, 'content')),
          author: author === null ? null : textOf(child(author, 'name')),
        }
      }),
  }
}

function jsonFeed(text: string): Feed {
  if (text.length > MAX_XML_CHARS) fail()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail()
  }
  const feed = value as Record<string, unknown> | null
  if (feed === null || typeof feed !== 'object' || Array.isArray(feed)) fail()
  const record = feed as Record<string, unknown>
  if (typeof record['version'] !== 'string' || !record['version'].startsWith('https://jsonfeed.org/version/'))
    fail()
  const items = Array.isArray(record['items']) ? record['items'] : fail()
  const authorOf = (item: Record<string, unknown>): string | null => {
    const authors = Array.isArray(item['authors']) ? item['authors'] : [item['author']]
    const first = authors[0] as Record<string, unknown> | undefined
    return first !== null && typeof first === 'object' ? field(first['name']) : null
  }
  return {
    format: 'json',
    title: field(record['title']),
    link: field(record['home_page_url']),
    description: field(record['description']),
    items: (items as unknown[])
      .slice(0, MAX_FEED_ITEMS)
      .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object' && !Array.isArray(i))
      .map((item) => ({
        id: field(typeof item['id'] === 'number' ? String(item['id']) : item['id']),
        title: field(item['title']),
        link: field(item['url']),
        published: date(item['date_published']),
        updated: date(item['date_modified']),
        summary: field(item['summary']),
        content: field(item['content_html']) ?? field(item['content_text']),
        author: authorOf(item),
      })),
  }
}
