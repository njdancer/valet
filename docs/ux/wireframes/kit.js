// Wireframe kit for Valet. Frames are plain HTML strings built with these helpers, so every frame
// shares one vocabulary. The design-system thread maps each wf-* class to a real component (see
// docs/ux/component-inventory.md). Keep helpers small and literal: a wireframe is about structure,
// placement and words, not looks.
/* eslint-disable */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Annotation marker: a numbered dot that matches a note under the frame.
const n = (i) => `<span class="wf-n" aria-hidden="true">${i}</span>`

const K = {
  // ---- atoms ----
  btn: (label, kind = '') => `<span class="wf-btn ${kind}">${label}</span>`,
  primary: (label) => K.btn(label, 'primary'),
  // danger: solid, only on the confirm of something that can't be undone. dangerSoft: the trigger that
  // opens that confirm (headers, cards). (Design system M17.)
  danger: (label) => K.btn(label, 'danger solid'),
  dangerSoft: (label) => K.btn(label, 'danger'),
  ghost: (label) => K.btn(label, 'ghost'),
  icon: (label) => `<span class="wf-btn icon" title="${label}">${label}</span>`,
  // Status badge: never interactive (E1). Tones: ok, warn, bad, info, idle, write, read, secret.
  badge: (label, tone = 'idle') => `<span class="wf-badge ${tone}">${label}</span>`,
  // Object link (E2): sites, clients, calls, secrets, records. Same look everywhere.
  link: (label) => `<span class="wf-link">${label}</span>`,
  // Selectable value with copy (E3): hashes, URLs, ids, codes.
  value: (v) => `<span class="wf-value">${v}<span class="wf-copy">⧉</span></span>`,
  // Deadline in the library's words (design M19): "2 min · until 9:50 pm", then "30 s" when urgent.
  countdown: (left, until) => `<span class="wf-count">${left}<small> · until ${until}</small></span>`,
  input: (ph, w = '') => `<span class="wf-input" style="${w ? `width:${w}` : ''}">${ph}</span>`,
  search: (ph) => `<span class="wf-input search">⌕ ${ph}</span>`,
  toggle: (on) => `<span class="wf-toggle ${on ? 'on' : ''}"></span>`,
  check: (label, on = false) => `<span class="wf-check ${on ? 'on' : ''}"><i></i>${label}</span>`,
  radio: (label, on = false) => `<span class="wf-radio ${on ? 'on' : ''}"><i></i>${label}</span>`,
  avatar: (l) => `<span class="wf-av">${l}</span>`,
  dot: (tone) => `<span class="wf-dot ${tone}"></span>`,
  kbd: (k) => `<kbd class="wf-kbd">${k}</kbd>`,
  text: (w = 100) => `<span class="wf-text" style="width:${w}%"></span>`,
  lines: (count = 3) => Array.from({ length: count }, (_, i) => K.text(i === count - 1 ? 60 : 100)).join(''),
  spark: () => `<span class="wf-spark"></span>`,
  seg: (items, active = 0) =>
    `<span class="wf-seg">${items.map((t, i) => `<span class="${i === active ? 'on' : ''}">${t}</span>`).join('')}</span>`,
  tabs: (items, active = 0) =>
    `<div class="wf-tabs" role="tablist">${items.map((t, i) => `<span class="${i === active ? 'on' : ''}">${t}</span>`).join('')}</div>`,
  menu: (items) =>
    `<div class="wf-menu">${items.map((t) => (t === '-' ? '<hr>' : `<div>${t}</div>`)).join('')}</div>`,

  // ---- molecules ----
  // Health line (E6): one sentence + its action.
  health: (tone, sentence, action = '') =>
    `<div class="wf-health ${tone}">${K.dot(tone)}<span class="grow">${sentence}</span>${action}</div>`,
  // Banner with an action (status + button, never a clickable pill).
  banner: (tone, title, body, actions = '') =>
    `<div class="wf-banner ${tone}"><div class="grow"><b>${title}</b> ${body}</div>${actions}</div>`,
  // Card with optional header actions.
  card: (title, body, actions = '', extra = '') =>
    `<section class="wf-card ${extra}">${title ? `<header><h4>${title}</h4><span class="grow"></span>${actions}</header>` : ''}<div class="body">${body}</div></section>`,
  // Label / value rows.
  kv: (rows) => `<dl class="wf-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`,
  // A list of rows; each row is an array of cells (strings). opts.head for a header row.
  table: (head, rows, opts = {}) =>
    `<div class="wf-table ${opts.cls || ''}" style="--cols:${opts.cols || head.map(() => '1fr').join(' ')}">` +
    (head.length ? `<div class="th">${head.map((h) => `<span>${h}</span>`).join('')}</div>` : '') +
    rows
      .map(
        (r, i) =>
          `<div class="tr ${opts.selected === i ? 'sel' : ''} ${opts.hover === i ? 'hover' : ''}">${r.map((c) => `<span>${c}</span>`).join('')}</div>`,
      )
      .join('') +
    `</div>`,
  // Inbox item (P1): kind icon, sentence, context, deadline, inline action.
  inbox: (kind, title, sub, deadline, actions, tone = '') =>
    `<div class="wf-inbox ${tone}"><span class="wf-kind">${kind}</span><div class="grow"><b>${title}</b><small>${sub}</small></div>${deadline}${actions}</div>`,
  // Empty state.
  empty: (title, body, action = '') =>
    `<div class="wf-empty"><b>${title}</b><span>${body}</span>${action}</div>`,
  toast: (text, action = '') => `<div class="wf-toast">${text}${action}</div>`,
  // Filter bar bound to the URL (P4).
  filters: (chips, right = '') =>
    `<div class="wf-filters">${chips.map((c) => `<span class="wf-chip">${c}</span>`).join('')}<span class="grow"></span>${right}</div>`,
  // Page header (one pattern everywhere): breadcrumb, title, status, primary actions.
  header: ({ crumbs = [], title, sub = '', status = '', actions = '', tabs = '' }) =>
    `<div class="wf-pagehead">` +
    (crumbs.length
      ? `<div class="wf-crumbs">${crumbs.map((c) => `<span>${c}</span>`).join('<i>›</i>')}</div>`
      : '') +
    `<div class="row"><h2>${title}</h2>${status}<span class="grow"></span>${actions}</div>` +
    (sub ? `<p class="sub">${sub}</p>` : '') +
    `${tabs}</div>`,
}

// ---- the window shell ----
const NAV = [
  ['needs', 'Needs you'],
  ['sites', 'Sites'],
  ['activity', 'Activity'],
  ['connections', 'Connections'],
  ['secrets', 'Secrets'],
  ['settings', 'Settings'],
]

/**
 * The control panel window: titlebar with back/forward, global search and Pause; a sidebar that
 * never changes shape; the page. opts.badges: { needs: 3 } (alert counts only, E11).
 */
function shell(active, page, opts = {}) {
  const badges = opts.badges || { needs: 3 }
  const sites = opts.sites || [
    ['W', 'Woolworths', 'warn'],
    ['Y', 'Yahoo Finance', 'ok'],
    ['W', 'Wikipedia', 'ok'],
  ]
  const nav = NAV.map(
    ([id, label]) =>
      `<div class="nav ${id === active ? 'on' : ''}"><span class="ico"></span>${label}${badges[id] ? `<span class="wf-alert">${badges[id]}</span>` : ''}</div>`,
  ).join('')
  const siteRows = sites
    .map(
      ([l, name, tone], i) =>
        `<div class="nav sub ${opts.site === i ? 'on' : ''}">${K.avatar(l)}${name}${K.dot(tone)}</div>`,
    )
    .join('')
  const paused = opts.paused
  return `<div class="wf-window ${opts.cls || ''}">
    <div class="wf-titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="wf-hist">‹ ›</span>
      <span class="grow"></span>${K.search('Search sites, calls, apps  ⌘K')}
      ${paused ? K.primary('Resume Valet') : K.btn('Pause Valet')}</div>
    ${paused ? `<div class="wf-shellstatus">${K.dot('warn')} <b>Valet is paused.</b> Calls are refused and nothing reaches any site. <span class="grow"></span>${K.btn('Resume')}</div>` : ''}
    <div class="wf-body">
      <aside class="wf-side">${nav}<div class="grp">Sites</div>${siteRows}
        <div class="grow"></div>
        <div class="foot">${paused ? `${K.dot('warn')} Paused · calls refused` : `${K.dot('ok')} Ready · 2 apps connected`}</div>
      </aside>
      <main class="wf-main">${page}</main>
    </div>${opts.over || ''}</div>`
}

/** A sheet over the window (review, grant, add client, confirm dialogs). */
const sheet = (title, body, footer, cls = '') =>
  `<div class="wf-scrim"></div><div class="wf-sheet ${cls}"><header><h3>${title}</h3><span class="grow"></span>${K.icon('✕')}</header><div class="body">${body}</div><footer>${footer}</footer></div>`

/** A small modal dialog (destructive confirm). */
const dialog = (title, body, footer) =>
  `<div class="wf-scrim"></div><div class="wf-dialog"><h3>${title}</h3><div class="body">${body}</div><footer>${footer}</footer></div>`

window.WF = { K, n, esc, shell, sheet, dialog, FRAMES: [] }
