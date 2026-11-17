// WebDAV as CalDAV and CardDAV use it (RFC 4918): a request with an XML body and a Depth header,
// answered by a 207 multistatus of <response>s, each an href and the properties found for it.
// Pure parsing apart from `dav`, so cases test it through the tools.

import {
  parseXml,
  type ToolContext,
  ValetError,
  type XmlElement,
  xmlChild,
  xmlChildren,
  xmlText,
} from '@valet/core'

export const DAV = 'DAV:'

/** Sends one WebDAV request with the kept credential and parses the multistatus it answers. */
export async function dav(
  ctx: ToolContext,
  url: string,
  method: 'PROPFIND' | 'REPORT',
  body: string,
  depth: '0' | '1',
  credential: string,
): Promise<XmlElement> {
  if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
  const response = await ctx.http.fetch(url, {
    method,
    headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="UTF-8"?>${body}`,
    credential,
  })
  if (response.status === 401 || response.status === 403) throw new ValetError('tool-run', 'auth-failed')
  if (response.status === 429 || response.status === 503) throw new ValetError('tool-run', 'rate-limited')
  if (response.status === 404) throw new ValetError('tool-input', 'not-found')
  if (response.status !== 207) throw new ValetError('tool-run', 'unavailable')
  let root: XmlElement
  try {
    root = parseXml(response.body)
  } catch {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
  if (root.local !== 'multistatus' || root.ns !== DAV) throw new ValetError('tool-run', 'unexpected-shape')
  return root
}

export interface DavResponse {
  readonly href: string
  /** The <prop> of the 200 propstat, or null if no property was found. */
  readonly prop: XmlElement | null
}

export function responses(multistatus: XmlElement): DavResponse[] {
  return xmlChildren(multistatus, 'response', DAV).map((r) => {
    const href = xmlChild(r, 'href', DAV)
    const ok = xmlChildren(r, 'propstat', DAV).find((p) => {
      const status = xmlChild(p, 'status', DAV)
      return status !== null && / 200 /.test(xmlText(status))
    })
    return {
      href: href === null ? '' : xmlText(href).trim(),
      prop: ok === undefined ? null : xmlChild(ok, 'prop', DAV),
    }
  })
}

/** The text of the <href> inside a property, such as current-user-principal. */
export function hrefIn(prop: XmlElement | null, local: string, ns: string): string | null {
  const holder = prop === null ? null : xmlChild(prop, local, ns)
  const href = holder === null ? null : xmlChild(holder, 'href', DAV)
  return href === null ? null : xmlText(href).trim()
}

export function textIn(prop: XmlElement | null, local: string, ns: string): string | null {
  const element = prop === null ? null : xmlChild(prop, local, ns)
  return element === null ? null : xmlText(element).trim()
}

/**
 * An href as host and path: absolute (https only, on the default port) or a path on `host`. Tool
 * code has no URL class in Valet's sandbox, so this is the whole of what it needs. Null otherwise.
 */
export function splitHref(href: string, host: string): { host: string; path: string } | null {
  const absolute = /^https:\/\/([a-z0-9.-]{1,253})(?::443)?(\/[^?#\s]*)$/i.exec(href)
  if (absolute !== null) return { host: (absolute[1] as string).toLowerCase(), path: absolute[2] as string }
  if (/^\/[^?#\s]*$/.test(href)) return { host, path: href }
  return null
}
