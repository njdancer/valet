// The only HTML the remote listener ever serves: the page a browser waits on while the person
// answers on their Mac, and a page for a sign-in that can't go on (relay.md, "A separate listener
// with its own guards"). Both are fixed templates. Nothing a client sent is ever put in them: the
// code comes from our own alphabet and the handle is our own base64url token, and both are escaped
// all the same. No script, no forms, no images, nothing fetched: the waiting page refreshes itself.

import type { ServerResponse } from 'node:http'
import { displayCode } from './oauth-consent'

/** How often the waiting page asks again. */
export const WAIT_REFRESH_SECONDS = 3

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const

export type PageProblem = 'unknown-client' | 'bad-redirect' | 'busy' | 'too-many' | 'ended' | 'not-found'

const PROBLEM_TEXT: Readonly<Record<PageProblem, string>> = {
  'unknown-client': 'This connector isn’t registered with Valet. Remove it and add it again.',
  'bad-redirect': 'This connector asked to return somewhere it didn’t register. Valet stopped here.',
  busy: 'Valet has too many sign-ins waiting on the Mac. Try again in a few minutes.',
  'too-many': 'Too many sign-in attempts. Try again later.',
  ended: 'This sign-in has ended. Start again from the app you were connecting.',
  'not-found': 'Nothing here.',
}

const STYLE = `
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 16px;
         color: #1d1d1f; background: #f5f5f7; }
  main { max-width: 28rem; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .code { font: 600 32px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 0.08em;
          text-align: center; padding: 16px; border-radius: 8px; background: #f0f0f3; margin: 16px 0; }
  .warn { color: #8a3b00; }
  @media (prefers-color-scheme: dark) {
    body { color: #f5f5f7; background: #000; }
    main { background: #1c1c1e; }
    .code { background: #2c2c2e; }
    .warn { color: #ffb066; }
  }
`

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>
`
}

/** The page the browser that started the flow waits on. Shows the code; never anything else. */
export function waitingPage(code: string, handle: string): string {
  const next = `/authorize/wait?h=${encodeURIComponent(handle)}`
  return page(
    'Approve on your Mac',
    `<h1>Type this code into Valet on your Mac</h1>
<p>Valet is showing a sign-in request on your Mac. Type this code there to approve it.</p>
<div class="code">${escapeHtml(displayCode(code))}</div>
<p class="warn"><strong>If you didn’t just add a connector, close this page.</strong> Someone else started this sign-in.</p>
<p>This page moves on by itself once you answer on the Mac.</p>`,
    `<meta http-equiv="refresh" content="${WAIT_REFRESH_SECONDS};url=${escapeHtml(next)}">`,
  )
}

export function problemPage(problem: PageProblem): string {
  return page('Valet', `<h1>Valet</h1><p>${escapeHtml(PROBLEM_TEXT[problem])}</p>`)
}

export function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...PAGE_HEADERS, connection: 'close' })
  res.end(html)
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
