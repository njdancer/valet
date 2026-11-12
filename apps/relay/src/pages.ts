// The only HTML the relay serves: the consent pages for `/authorize`, filled from the Mac's
// structured `consent-view`, never from HTML a Mac sent (relay.md: otherwise any program speaking
// the protocol could host pages on the relay's domain). The same rules as the Mac's own pages
// (packages/mcp-server/src/oauth-pages.ts): no script, no forms, no images, nothing fetched.

export const WAIT_REFRESH_SECONDS = 3

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

export type RelayPageProblem = 'mac-offline' | 'no-answer' | 'cant-go-on' | 'ended' | 'too-many' | 'not-found'

const PROBLEM_TEXT: Readonly<Record<RelayPageProblem, string>> = {
  'mac-offline':
    'The Mac running Valet isn’t connected right now. Wake it or check its internet, then start again from the app you were connecting.',
  'no-answer': 'Valet on your Mac didn’t answer. Start again from the app you were connecting.',
  'cant-go-on': 'Valet can’t go on with this sign-in. Remove the connector and add it again.',
  ended: 'This sign-in has ended. Start again from the app you were connecting.',
  'too-many': 'Too many sign-in attempts. Try again later.',
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

const CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/
const ID = /^[A-Za-z0-9_.-]{1,1200}$/

/** The page a browser waits on. `code` is checked against the contract's shape again here. */
export function waitingPage(code: string, id: string): Response {
  if (!CODE.test(code) || !ID.test(id)) return problemPage('cant-go-on', 502)
  const next = `/authorize?wait=${encodeURIComponent(id)}`
  return html(
    200,
    page(
      'Approve on your Mac',
      `<h1>Type this code into Valet on your Mac</h1>
<p>Valet is showing a sign-in request on your Mac. Type this code there to approve it.</p>
<div class="code">${escapeHtml(code)}</div>
<p class="warn"><strong>If you didn’t just add a connector, close this page.</strong> Someone else started this sign-in.</p>
<p>This page moves on by itself once you answer on the Mac.</p>`,
      `<meta http-equiv="refresh" content="${WAIT_REFRESH_SECONDS};url=${escapeHtml(next)}">`,
    ),
  )
}

export function problemPage(problem: RelayPageProblem, status: number): Response {
  return html(status, page('Valet', `<h1>Valet</h1><p>${escapeHtml(PROBLEM_TEXT[problem])}</p>`))
}

/** On to the client, with the code or the error the Mac put in its redirect URI. */
export function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}

function html(status: number, body: string): Response {
  return new Response(body, { status, headers: PAGE_HEADERS })
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
