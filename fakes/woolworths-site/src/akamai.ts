// A stand-in for Akamai Bot Manager. The real one sets `_abck` from a sensor script and answers
// suspicious clients with a bare "Access Denied" page; the live probe saw both. This fake keeps the
// observable behaviour: no sensor cookie, or too many API calls, means a 403 with that page.

import { randomBytes } from 'node:crypto'

export const SENSOR_COOKIE = '_abck'

/** A fresh sensor cookie value, shaped like the real one's `<id>~<state>~…` fields. */
export function newSensorValue(): string {
  return `${randomBytes(24).toString('hex').toUpperCase()}~0~-1~-1`
}

/**
 * The inline script that plays Akamai's sensor. It runs in the page, so the cookie it sets is
 * readable from script (not httpOnly), exactly like the real `_abck`.
 */
export function sensorScript(value: string): string {
  return `<script id="akam-sensor">(function () {
  if (/(?:^|;\\s*)${SENSOR_COOKIE}=/.test(document.cookie)) return
  var secure = location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = '${SENSOR_COOKIE}=${value}; path=/; max-age=31536000; SameSite=Lax' + secure
})()</script>`
}

/** Akamai escapes every non-alphanumeric character of the URL as a decimal entity. */
function akamaiEscape(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, (char) => `&#${char.codePointAt(0)};`)
}

/**
 * The block page, in the shape captured live (`login.json` in the spike results). Akamai prints
 * the URL with an http scheme even on https. `reference` stands in for its edge reference id.
 */
export function accessDeniedHtml(host: string, pathAndQuery: string, reference: string): string {
  const url = akamaiEscape(`http://${host}${pathAndQuery}`)
  const ref = akamaiEscape(reference)
  // Joined lines rather than a template literal, because the real page has a line holding a single
  // space and editors strip trailing whitespace.
  return [
    '<HTML><HEAD>',
    '<TITLE>Access Denied</TITLE>',
    '</HEAD><BODY>',
    '<H1>Access Denied</H1>',
    ' ',
    `You don't have permission to access "${url}" on this server.<P>`,
    `Reference&#32;&#35;${ref}`,
    `<P>${akamaiEscape(`https://errors.edgesuite.net/${reference}`)}</P>`,
    '</BODY>',
    '</HTML>',
    '',
  ].join('\n')
}
