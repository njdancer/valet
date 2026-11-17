// The XML reader and feed parser tool code gets: the feeds a fake API serves, and hostile XML.

import { parseFeed, parseXml, xmlChild, xmlChildren, xmlText } from '@valet/core'
import { ATOM_FEED, CALDAV_MULTISTATUS, RSS_FEED } from '@valet/fake-http-api'
import { describe, expect, it } from 'vitest'

const refused = { stage: 'tool-run', errorClass: 'unexpected-shape' }

describe('parseFeed', () => {
  it('reads RSS 2.0', () => {
    const feed = parseFeed(RSS_FEED)
    expect(feed).toMatchObject({ format: 'rss', title: 'Example News', link: 'https://feeds.example.test/' })
    expect(feed.items).toEqual([
      {
        id: 'item-1',
        title: 'First & foremost',
        link: 'https://feeds.example.test/1',
        published: '2026-11-16T09:00:00.000Z',
        updated: null,
        summary: '<p>Hello <b>world</b></p>',
        content: null,
        author: null,
      },
      expect.objectContaining({ id: 'https://feeds.example.test/2', summary: 'Plain text — with an entity' }),
    ])
  })

  it('reads Atom', () => {
    const feed = parseFeed(ATOM_FEED)
    expect(feed).toMatchObject({
      format: 'atom',
      title: 'Example Atom',
      link: 'https://feeds.example.test/atom',
    })
    expect(feed.items).toEqual([
      {
        id: 'urn:example:a1',
        title: 'Atom entry',
        link: 'https://feeds.example.test/a1',
        published: null,
        updated: '2026-11-17T09:00:00.000Z',
        summary: 'Summary text',
        content: null,
        author: 'Alex',
      },
    ])
  })

  it('reads RSS 1.0', () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <channel rdf:about="x"><title>R</title><link>https://r.test/</link></channel>
      <item rdf:about="https://r.test/1"><title>One</title><link>https://r.test/1</link><dc:date>2026-11-01T00:00:00Z</dc:date><dc:creator>Sam</dc:creator></item>
    </rdf:RDF>`
    expect(parseFeed(rdf).items).toEqual([
      expect.objectContaining({
        id: 'https://r.test/1',
        title: 'One',
        published: '2026-11-01T00:00:00.000Z',
        author: 'Sam',
      }),
    ])
  })

  it('reads JSON Feed', () => {
    const feed = parseFeed(
      JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'J',
        items: [
          {
            id: 7,
            url: 'https://j.test/7',
            content_text: 'hi',
            authors: [{ name: 'Kim' }],
            date_published: '2026-11-02T10:00:00+11:00',
          },
        ],
      }),
    )
    expect(feed.items).toEqual([
      {
        id: '7',
        title: null,
        link: 'https://j.test/7',
        published: '2026-11-01T23:00:00.000Z',
        updated: null,
        summary: null,
        content: 'hi',
        author: 'Kim',
      },
    ])
  })

  it.each([
    ['HTML', '<html><body>hi</body></html>'],
    ['JSON that is not a feed', '{"items": []}'],
    ['text', 'hello'],
  ])('refuses %s', (_why, text) => {
    expect(() => parseFeed(text)).toThrow(expect.objectContaining(refused))
  })
})

describe('parseXml', () => {
  it('resolves namespaces, as CalDAV answers need', () => {
    const root = parseXml(CALDAV_MULTISTATUS)
    expect(root).toMatchObject({ local: 'multistatus', ns: 'DAV:' })
    const response = xmlChild(root, 'response', 'DAV:')
    expect(xmlText(xmlChild(response!, 'href', 'DAV:')!)).toBe('/calendars/alex/home/')
    expect(xmlChildren(root)).toHaveLength(1)
  })

  it.each([
    ['a DOCTYPE', '<!DOCTYPE r [<!ENTITY a "b">]><r>&a;</r>'],
    ['an external entity', '<!DOCTYPE r SYSTEM "file:///etc/passwd"><r/>'],
    ['an undeclared entity', '<r>&nbsp;</r>'],
    ['a NUL reference', '<r>&#0;</r>'],
    ['a surrogate reference', '<r>&#xD800;</r>'],
    ['an unknown prefix', '<x:r/>'],
    ['mismatched tags', '<a><b></a></b>'],
    ['two roots', '<a/><b/>'],
    ['an unclosed element', '<a><b></b>'],
    ['text outside the root', 'x<a/>'],
    ['a repeated attribute', '<a x="1" x="2"/>'],
    ['an unquoted attribute', '<a x=1/>'],
    ['< in an attribute', '<a x="<"/>'],
  ])('refuses %s', (_why, text) => {
    expect(() => parseXml(text)).toThrow(expect.objectContaining(refused))
  })

  it('refuses nesting past its depth, and documents past its size', () => {
    expect(() => parseXml(`${'<a>'.repeat(200)}${'</a>'.repeat(200)}`)).toThrow(
      expect.objectContaining(refused),
    )
    expect(() => parseXml(`<a>${'x'.repeat(5 * 1024 * 1024)}</a>`)).toThrow(expect.objectContaining(refused))
  })

  it('never throws anything but its refusal on mangled input', () => {
    let seed = 7
    const next = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed >>> 16
    }
    for (let i = 0; i < 3000; i++) {
      const chars = RSS_FEED.split('')
      for (let j = 0; j < 6; j++) chars[next() % chars.length] = '<>&;"\'/!?x '[next() % 11] as string
      try {
        parseFeed(chars.join(''))
      } catch (error) {
        expect(error).toMatchObject(refused)
      }
    }
  })
})
