// The fake desktop app's one page. It renders from /api/state by its path: `/` the main window,
// `/settings` its Developer settings, `/prompt/<id>` an integration's prompt. Its look is its own:
// "Keyhold", a made-up password manager standing in for 1Password in demos and tests.

const LOGO = `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="9" fill="#0f5b52"/><circle cx="16" cy="13" r="5" fill="none" stroke="#f6c453" stroke-width="2.6"/><path d="M14.6 17.5h2.8l1 7.5h-4.8z" fill="#f6c453"/></svg>`

const STYLE = `
:root { color-scheme: light; --ink:#1d2a28; --muted:#5d6b68; --line:#d9e1de; --bg:#f7f5ef; --card:#fff;
  --teal:#0f5b52; --teal-2:#147a6d; --gold:#f6c453; --red:#b4232c; }
* { box-sizing: border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--ink);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
button { font: inherit; cursor: pointer; border-radius: 8px; padding: 8px 16px; border: 1px solid var(--line);
  background: var(--card); color: var(--ink); }
button.primary { background: var(--teal); border-color: var(--teal); color: #fff; font-weight: 600; }
button.primary:hover { background: var(--teal-2); }
button:focus-visible, input:focus-visible { outline: 3px solid var(--gold); outline-offset: 1px; }
input[type=password] { width:100%; font: inherit; padding: 9px 12px; border:1px solid var(--line); border-radius: 8px; background:#fff; }
.stack { display:flex; flex-direction:column; gap:10px; }
.side .brand svg rect { fill:#0b463f; }
.brand { display:flex; align-items:center; gap:10px; font-weight:700; letter-spacing:.2px; font-size:16px; }
.brand small { font-weight:500; color:var(--muted); font-size:11px; letter-spacing:.3px; text-transform:uppercase; }
.prompt { max-width: 420px; margin: 0 auto; padding: 22px 24px; display:flex; flex-direction:column; gap:16px; min-height:100%; }
.prompt h1 { font-size: 19px; margin: 6px 0 0; line-height:1.3; }
.prompt p { margin: 0; color: var(--muted); }
.who { display:flex; align-items:center; gap:12px; padding:12px; background:var(--card); border:1px solid var(--line); border-radius:12px; }
.avatar { width:36px; height:36px; border-radius:50%; background:var(--gold); color:var(--teal); display:grid; place-items:center; font-weight:700; }
.app-chip { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:12px; background:#eaf3f1; }
.app-chip b { color: var(--teal); }
ul.scope { margin:0; padding-left:18px; color:var(--muted); }
.actions { display:flex; gap:10px; justify-content:flex-end; margin-top:auto; }
.error { color: var(--red); font-size: 13px; min-height: 18px; }
.done { text-align:center; padding: 40px 0; color: var(--teal); font-weight:600; }
.shell { display:grid; grid-template-columns: 210px 1fr; height:100%; }
.side { background: var(--teal); color:#e7f2ef; padding: 18px 14px; display:flex; flex-direction:column; gap: 14px; }
.side .brand { color:#fff; }
.side a { color:#e7f2ef; text-decoration:none; padding:6px 8px; border-radius:6px; display:block; }
.side a[aria-current=page] { background: rgba(255,255,255,.14); color:#fff; }
.side .acct { font-size:12px; opacity:.85; margin-top:auto; }
.main { padding: 22px 26px; overflow:auto; }
.main h1 { font-size: 18px; margin: 0 0 14px; }
.vault { margin-bottom: 18px; }
.vault h2 { font-size: 12px; text-transform: uppercase; letter-spacing:.5px; color: var(--muted); margin: 0 0 6px; }
.item { display:flex; align-items:center; gap:12px; background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; margin-bottom:6px; }
.item .icon { width:30px; height:30px; border-radius:8px; background:#eaf3f1; display:grid; place-items:center; color:var(--teal); font-weight:700; }
.item .meta { font-size:12px; color:var(--muted); }
.dots { letter-spacing: 2px; color: var(--muted); margin-left:auto; }
.setting { display:flex; align-items:center; gap:16px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
.setting p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.switch { margin-left:auto; width:44px; height:26px; border-radius:13px; border:none; padding:0; background:#c4cdca; position:relative; }
.switch::after { content:""; position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; transition:left .15s; }
.switch[aria-checked=true] { background: var(--teal); }
.switch[aria-checked=true]::after { left:21px; }
.lock { max-width: 320px; margin: 60px auto; display:flex; flex-direction:column; gap:14px; text-align:center; }
.note { font-size: 11px; color: var(--muted); text-align:center; }
`

const SCRIPT = `
const root = document.getElementById('root')
const path = location.pathname
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c])
let state = null
let error = ''
let typed = ''
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  return r.json()
}
async function refresh() {
  try {
    const next = await (await fetch('/api/state')).json()
    const changed = JSON.stringify(next) !== JSON.stringify(state)
    state = next
    if (changed) render()
  } catch {}
}
function lockForm(lede) {
  return '<form id="unlock" class="stack">' +
    '<p>' + lede + '</p>' +
    '<label for="pw" style="text-align:left;font-weight:600">Account password</label>' +
    '<input id="pw" type="password" autocomplete="off" value="' + esc(typed) + '">' +
    '<div class="error" role="alert">' + esc(error) + '</div>' +
    '<div class="actions"><button class="primary" type="submit">Unlock</button></div></form>'
}
function wireUnlock() {
  const form = document.getElementById('unlock')
  if (!form) return
  const input = document.getElementById('pw')
  input.addEventListener('input', () => { typed = input.value })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const res = await post('/api/unlock', { password: input.value })
    typed = ''
    error = res.ok ? '' : 'That isn’t the account password.'
    await refresh(); render()
  })
  if (document.activeElement !== input) input.focus()
}
function renderPrompt(id) {
  const p = state.prompts.find((x) => x.id === id)
  const brand = '<div class="brand">${LOGO}<span>Keyhold<br><small>Stands in for 1Password</small></span></div>'
  if (!p) { root.innerHTML = '<main class="prompt">' + brand + '<p>This request has gone.</p></main>'; return }
  if (p.state !== 'pending') {
    root.innerHTML = '<main class="prompt">' + brand + '<div class="done" role="status">' +
      (p.state === 'allowed' ? 'Access allowed. You can close this window.' : 'Access denied.') + '</div></main>'
    return
  }
  const who = p.kind === 'cli' ? 'The Keyhold CLI (op)' : esc(p.integration === 'valet' ? 'Valet' : p.integration)
  if (state.locked) {
    root.innerHTML = '<main class="prompt">' + brand + '<h1>Unlock Keyhold</h1>' +
      lockForm(who + ' wants to use Keyhold. Unlock it to continue.') + '</main>'
    wireUnlock()
    return
  }
  const initials = state.account.name.split(/\\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase()
  root.innerHTML = '<main class="prompt">' + brand +
    '<h1>Allow ' + who + ' to use your account?</h1>' +
    '<div class="app-chip"><b>' + who + '</b><span>' + esc(p.integration + ' ' + p.integrationVersion) + '</span></div>' +
    '<div class="who"><div class="avatar">' + esc(initials) + '</div><div><div><b>' + esc(state.account.name) + '</b></div>' +
    '<div class="note" style="text-align:left">' + esc(state.account.email || '') + '</div></div></div>' +
    '<ul class="scope"><li>It can read the items in every vault you can open.</li>' +
    '<li>Access ends when Keyhold locks, or after 10 minutes unused.</li></ul>' +
    '<div class="actions"><button id="deny" type="button">Deny</button><button id="allow" class="primary" type="button">Allow</button></div></main>'
  document.getElementById('allow').onclick = async () => { await post('/api/prompts/' + id + '/allow'); refresh() }
  document.getElementById('deny').onclick = async () => { await post('/api/prompts/' + id + '/deny'); refresh() }
}
function renderMain(settings) {
  const nav = '<nav aria-label="Keyhold"><a href="/" ' + (settings ? '' : 'aria-current="page"') + '>All items</a>' +
    '<a href="/settings" ' + (settings ? 'aria-current="page"' : '') + '>Settings › Developer</a></nav>'
  const side = '<aside class="side"><div class="brand">${LOGO}<span>Keyhold<br><small>Stands in for 1Password</small></span></div>' + nav +
    '<div class="acct">' + esc(state.account.name) + (state.locked ? '' : '<br>' + esc(state.account.email)) + '</div>' +
    (state.locked ? '' : '<button id="lock" type="button">Lock</button>') + '</aside>'
  let main
  if (state.locked) {
    main = '<main class="main"><div class="lock"><h1>Keyhold is locked</h1>' + lockForm('Enter your account password.') + '</div></main>'
  } else if (settings) {
    main = '<main class="main"><h1>Developer</h1><div class="setting"><div><b id="integrate-label">Integrate with other apps</b>' +
      '<p>Let apps you approve, such as Valet, ask to use your account. You allow each app when it asks.</p></div>' +
      '<button class="switch" id="integrate" role="switch" aria-labelledby="integrate-label" aria-checked="' + state.integrationEnabled + '"></button></div>' +
      '<p class="note" style="text-align:left;margin-top:12px">Approved now: ' + (state.approvals.length === 0 ? 'none' : esc(state.approvals.join(', '))) + '</p></main>'
  } else {
    main = '<main class="main"><h1>All items</h1>' + state.vaults.map((v) => '<section class="vault"><h2>' + esc(v.title) + '</h2>' +
      v.items.map((i) => '<div class="item"><div class="icon">' + esc(i.title[0] || '?') + '</div><div><div>' + esc(i.title) + '</div>' +
        '<div class="meta">' + esc(i.username || '') + (i.websites[0] ? ' · ' + esc(i.websites[0]) : '') + '</div></div>' +
        (i.hasPassword ? '<span class="dots" aria-label="password hidden">••••••••</span>' : '') + '</div>').join('') + '</section>').join('') + '</main>'
  }
  root.innerHTML = '<div class="shell">' + side + main + '</div>'
  wireUnlock()
  const lock = document.getElementById('lock')
  if (lock) lock.onclick = async () => { await post('/api/lock'); refresh() }
  const sw = document.getElementById('integrate')
  if (sw) sw.onclick = async () => { await post('/api/integration', { enabled: !state.integrationEnabled }); refresh() }
}
function render() {
  if (state === null) return
  const prompt = /^\\/prompt\\/([A-Za-z0-9-]+)$/.exec(path)
  document.title = prompt ? 'Keyhold' : 'Keyhold'
  if (prompt) renderPrompt(prompt[1])
  else renderMain(path === '/settings')
}
refresh()
setInterval(refresh, 400)
`

export function appPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Keyhold</title><style>${STYLE}</style></head><body><div id="root"></div><script>${SCRIPT}</script></body></html>`
}
