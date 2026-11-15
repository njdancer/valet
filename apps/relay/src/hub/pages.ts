// The hub's pages (relay-hub.md): sign-up, sign-in, your nodes, adding a node, and security. Each is
// a fixed shell and one script that talks to the hub's own JSON API. Nothing a Mac or a client sent
// is ever written into HTML; the script sets text with textContent only.

export type HubPageName = 'home' | 'sign-in' | 'sign-up' | 'link' | 'security' | 'not-found'

const TITLES: Readonly<Record<HubPageName, string>> = {
  home: 'Your nodes',
  'sign-in': 'Sign in to Valet',
  'sign-up': 'Set up your Valet account',
  link: 'Add a Mac',
  security: 'Passkeys and sign-in',
  'not-found': 'Nothing here',
}

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --bg: #f5f5f7; --card: #fff; --muted: #6e6e73;
          --line: #d2d2d7; --accent: #0a5cd6; --bad: #b00020; --good: #1f7a3a; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #f5f5f7; --bg: #000; --card: #1c1c1e; --muted: #a1a1a6; --line: #3a3a3c;
            --accent: #4c9bff; --bad: #ff6b6b; --good: #5fd38a; }
  }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 16px;
         color: var(--fg); background: var(--bg); }
  main { max-width: 32rem; margin: 0 auto; background: var(--card); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  p { margin: 8px 0; }
  .muted { color: var(--muted); }
  .error { color: var(--bad); min-height: 1.5em; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input { font: inherit; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px;
          border: 1px solid var(--line); background: transparent; color: inherit; }
  input.code { font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: var(--accent);
           color: #fff; margin-top: 16px; cursor: pointer; }
  button.quiet { background: transparent; color: var(--accent); padding: 8px 0; }
  button.danger { background: transparent; color: var(--bad); padding: 4px 0; margin: 0; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 12px 0; border-top: 1px solid var(--line); display: flex; justify-content: space-between;
       gap: 12px; align-items: center; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
         background: var(--muted); }
  .dot.on { background: var(--good); }
  nav { display: flex; gap: 16px; margin-top: 24px; flex-wrap: wrap; align-items: baseline; }
  nav button.quiet { margin: 0; padding: 0; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
  [hidden] { display: none !important; }
`

const BODIES: Readonly<Record<HubPageName, string>> = {
  'sign-in': `
    <p class="muted">Use the passkey you set up for Valet.</p>
    <button id="passkey">Sign in with a passkey</button>
    <p><button class="quiet" id="show-app">Use your authenticator app instead</button></p>
    <form id="app" hidden>
      <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
      <label for="code">Code from your authenticator app</label><input id="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button type="submit">Sign in</button>
    </form>
    <p class="error" id="error" role="alert"></p>`,
  'sign-up': `
    <p class="muted">This hub holds one account. Type the setup code it was deployed with, then make a passkey.</p>
    <form id="sign-up">
      <label for="setup">Setup code</label><input id="setup" type="password" autocomplete="off" required>
      <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
      <button type="submit">Make a passkey</button>
    </form>
    <p class="error" id="error" role="alert"></p>`,
  home: `
    <p class="muted" id="who"></p>
    <ul id="nodes"></ul>
    <p class="muted" id="empty" hidden>No Macs yet. In Valet on your Mac, open Settings, Devices, and choose Connect to your Valet account.</p>
    <p class="error" id="error" role="alert"></p>
    <nav><a href="/link">Add a Mac</a><a href="/security">Passkeys and sign-in</a><button class="quiet" id="sign-out">Sign out</button></nav>`,
  link: `
    <form id="find">
      <p class="muted">In Valet on your Mac, open Settings, Devices, and choose Connect to your Valet account. Type the code it shows.</p>
      <label for="code">Code</label><input id="code" class="code" autocomplete="off" maxlength="9" required placeholder="ABCD-EFGH">
      <button type="submit">Next</button>
    </form>
    <form id="confirm" hidden>
      <p>Add <strong id="name"></strong> to your account? Agents you approve will see its tools.</p>
      <label for="slug">Short name, used in tool names</label><input id="slug" autocomplete="off" maxlength="16" required pattern="[a-z0-9](-?[a-z0-9])*">
      <button type="submit">Add this Mac</button>
    </form>
    <p class="error" id="error" role="alert"></p>
    <nav><a href="/">Your nodes</a></nav>`,
  security: `
    <h2>Passkeys</h2>
    <ul id="passkeys"></ul>
    <button id="add-passkey">Add a passkey</button>
    <h2>Authenticator app</h2>
    <p class="muted" id="app-state"></p>
    <form id="app-start" hidden>
      <p class="muted">A backup way in: email, a password and a code from an authenticator app, all three.</p>
      <label for="password">New password (12 characters or more)</label><input id="password" type="password" autocomplete="new-password" minlength="12" required>
      <button type="submit">Next</button>
    </form>
    <form id="app-confirm" hidden>
      <p>Add this key to your authenticator app, then type the code it shows.</p>
      <p><code id="secret"></code></p>
      <p><a id="uri">Open in your authenticator app</a></p>
      <label for="code">Code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" required>
      <button type="submit">Turn on</button>
    </form>
    <button class="danger" id="app-remove" hidden>Turn off the authenticator app</button>
    <p class="error" id="error" role="alert"></p>
    <nav><a href="/">Your nodes</a></nav>`,
  'not-found': '<p>Nothing here.</p><nav><a href="/">Your nodes</a></nav>',
}

// One script for every page. It never builds HTML from data: text goes in with textContent.
const SCRIPT = `
const page = document.body.dataset.page
const $ = (id) => document.getElementById(id)
const say = (text) => { const e = $('error'); if (e) e.textContent = text || '' }
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const response = await fetch(path, init)
  const data = await response.json().catch(() => ({}))
  if (response.ok) return data
  if (data.error === 'signed_out') { location.href = '/sign-in?next=' + encodeURIComponent(location.pathname); throw new Error('') }
  const error = new Error(data.message || 'Something went wrong.')
  error.code = data.error
  throw error
}

function creationOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o)
  return { ...o, challenge: unb64(o.challenge), user: { ...o.user, id: unb64(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: unb64(c.id) })) }
}
function requestOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o)
  return { ...o, challenge: unb64(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: unb64(c.id) })) }
}
function credentialJson(c) {
  if (typeof c.toJSON === 'function') return c.toJSON()
  const r = c.response
  const response = { clientDataJSON: b64(r.clientDataJSON) }
  if (r.attestationObject) { response.attestationObject = b64(r.attestationObject); response.transports = r.getTransports ? r.getTransports() : [] }
  if (r.authenticatorData) { response.authenticatorData = b64(r.authenticatorData); response.signature = b64(r.signature); if (r.userHandle) response.userHandle = b64(r.userHandle) }
  return { id: c.id, rawId: b64(c.rawId), type: c.type, response, clientExtensionResults: c.getClientExtensionResults() }
}
async function newPasskey(start, finish) {
  const { challengeId, options } = await api(start.path, start.body)
  const credential = await navigator.credentials.create({ publicKey: creationOptions(options) })
  return api(finish, { challengeId, response: credentialJson(credential), name: passkeyName() })
}
function passkeyName() {
  const ua = navigator.userAgent
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac/.test(ua) ? 'Mac' : 'Passkey'
}
async function signInWithPasskey() {
  const { challengeId, options } = await api('/api/sign-in/options', {})
  const credential = await navigator.credentials.get({ publicKey: requestOptions(options) })
  return api('/api/sign-in/verify', { challengeId, response: credentialJson(credential) })
}
/** Runs a change; if the hub asks to confirm it's you, signs in with a passkey and tries once more. */
async function recent(run) {
  try { return await run() } catch (error) {
    if (error.code !== 'reauth') throw error
    await signInWithPasskey()
    return run()
  }
}
const next = () => { const n = new URLSearchParams(location.search).get('next'); return n && /^\\/[a-z-]*$/.test(n) ? n : '/' }
const guard = (fn) => async (event) => { if (event) event.preventDefault(); say(''); try { await fn() } catch (error) { say(error.message) } }
const when = (d) => d ? new Date(d).toLocaleString() : 'never'
function row(list, main, sub, action) {
  const li = document.createElement('li')
  const left = document.createElement('div')
  left.append(main)
  if (sub) { const p = document.createElement('div'); p.className = 'muted'; p.textContent = sub; left.append(p) }
  li.append(left)
  if (action) li.append(action)
  list.append(li)
}
function button(text, onClick) {
  const b = document.createElement('button'); b.className = 'danger'; b.textContent = text; b.onclick = guard(onClick); return b
}

if (page === 'sign-in') {
  $('passkey').onclick = guard(async () => { await signInWithPasskey(); location.href = next() })
  $('show-app').onclick = () => { $('app').hidden = false; $('show-app').hidden = true }
  $('app').onsubmit = guard(async () => {
    await api('/api/sign-in/app', { email: $('email').value, password: $('password').value, code: $('code').value })
    location.href = next()
  })
}
if (page === 'sign-up') {
  $('sign-up').onsubmit = guard(async () => {
    await newPasskey({ path: '/api/sign-up/options', body: { setup: $('setup').value, email: $('email').value } }, '/api/sign-up/verify')
    location.href = '/'
  })
}
if (page === 'home') {
  const load = guard(async () => {
    const [me, { nodes }] = await Promise.all([api('/api/me'), api('/api/nodes')])
    $('who').textContent = 'Signed in as ' + me.email
    const list = $('nodes'); list.textContent = ''
    $('empty').hidden = nodes.length > 0
    for (const node of nodes) {
      const main = document.createElement('div')
      const dot = document.createElement('span'); dot.className = 'dot' + (node.online ? ' on' : '')
      main.append(dot, node.name + ' (' + node.slug + ')')
      row(list, main, node.online ? 'Online' : 'Offline, last seen ' + when(node.lastSeenAt),
        button('Remove', async () => { await recent(() => api('/api/nodes/remove', { macId: node.macId })); await load() }))
    }
  })
  $('sign-out').onclick = guard(async () => { await api('/api/sign-out', {}); location.href = '/sign-in' })
  load()
  setInterval(load, 30000)
}
if (page === 'link') {
  let code = ''
  $('find').onsubmit = guard(async () => {
    code = $('code').value
    const preview = await api('/api/nodes/preview', { code })
    $('name').textContent = preview.name
    $('slug').value = preview.slug
    $('find').hidden = true; $('confirm').hidden = false
  })
  $('confirm').onsubmit = guard(async () => {
    await recent(() => api('/api/nodes/link', { code, slug: $('slug').value }))
    location.href = '/'
  })
}
if (page === 'security') {
  const load = guard(async () => {
    const me = await api('/api/me')
    const list = $('passkeys'); list.textContent = ''
    for (const p of me.passkeys)
      row(list, p.name, 'Added ' + when(p.createdAt) + ', last used ' + when(p.lastUsedAt),
        button('Remove', async () => { await recent(() => api('/api/passkeys/remove', { id: p.id })); await load() }))
    $('app-state').textContent = me.app ? 'On.' : 'Off.'
    $('app-start').hidden = me.app; $('app-confirm').hidden = true; $('app-remove').hidden = !me.app
  })
  $('add-passkey').onclick = guard(async () => { await recent(() => newPasskey({ path: '/api/passkeys/options', body: {} }, '/api/passkeys/verify')); await load() })
  let challengeId = ''
  $('app-start').onsubmit = guard(async () => {
    const started = await recent(() => api('/api/app/start', { password: $('password').value }))
    challengeId = started.challengeId
    $('secret').textContent = started.secret
    $('uri').href = started.uri
    $('app-start').hidden = true; $('app-confirm').hidden = false
  })
  $('app-confirm').onsubmit = guard(async () => { await recent(() => api('/api/app/confirm', { challengeId, code: $('code').value })); await load() })
  $('app-remove').onclick = guard(async () => { await recent(() => api('/api/app/remove', {})); await load() })
  load()
}
`

export function hubPage(name: HubPageName, status: number): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLES[name]}</title><style>${STYLE}</style></head>
<body data-page="${name}"><main><h1>${TITLES[name]}</h1>${BODIES[name]}</main>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })
}
