// Builds docs/review/index.html: the review hub. Decisions and the in-person list come from
// docs/plan.md, status from docs/review/status.json. No dependencies; run with
//   node docs/review/build.mjs
// Answers are kept in the browser (localStorage) and exported as Markdown to paste back.
//
//   node docs/review/build.mjs --artifact
// builds the same hub as a claude.ai Artifact page in docs/review/artifact/ (gitignored): no
// document skeleton, tokens inlined, screenshots renamed into screens/ (files.json maps each
// published path to its source), repo links shown as paths, and answers kept in the artifact's
// own store, where Claude reads them and writes replies back.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, posix } from 'node:path'

const here = import.meta.dirname
const docs = join(here, '..')
const plan = readFileSync(join(docs, 'plan.md'), 'utf8')
const status = JSON.parse(readFileSync(join(here, 'status.json'), 'utf8'))
const ARTIFACT = process.argv.includes('--artifact')

// Where a hub link points in the repo, for the artifact, which can't follow it.
const repoPath = (target) => posix.normalize(posix.join('docs/review', target.split('#')[0]))

const escapeHtml = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// Links in plan.md are relative to docs/; the hub lives in docs/review/. Anchors to decisions
// become links to the decision cards.
// In the artifact, links into the repo have nowhere to go, so they return null and show as text.
function href(target) {
  if (/^#d\d+a?-/i.test(target)) return `#${target.slice(1).split('-')[0].toLowerCase()}`
  if (/^[a-z]+:/i.test(target)) return target
  if (ARTIFACT) return null
  if (target.startsWith('#')) return `../plan.md${target}`
  return `../${target}`
}

function inline(text) {
  const codes = []
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return `\uE000${codes.length - 1}\uE000`
  })
  out = escapeHtml(out)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, target) => {
    const to = href(target)
    return to === null ? `<span class="ref">${label}</span>` : `<a href="${escapeHtml(to)}">${label}</a>`
  })
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>')
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => codes[Number(i)])
}

// A small Markdown subset: paragraphs, nested "-" and "1." lists, pipe tables, #### headings.
function markdown(source) {
  const lines = source.split('\n')
  const html = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++])
      const cells = (row) =>
        row
          .slice(1, -1)
          .split('|')
          .map((cell) => inline(cell.trim()))
      const [head, , ...body] = rows
      html.push(
        `<table><thead><tr>${cells(head)
          .map((c) => `<th>${c}</th>`)
          .join('')}</tr></thead><tbody>${body
          .map(
            (row) =>
              `<tr>${cells(row)
                .map((c) => `<td>${c}</td>`)
                .join('')}</tr>`,
          )
          .join('')}</tbody></table>`,
      )
      continue
    }
    if (/^#{4,6} /.test(line)) {
      html.push(`<h4>${inline(line.replace(/^#+ /, ''))}</h4>`)
      i++
      continue
    }
    if (/^\s*(-|\d+\.) /.test(line)) {
      const block = []
      while (
        i < lines.length &&
        (lines[i].trim() === ''
          ? /^\s+(-|\d+\.) |^\s{2,}\S/.test(lines[i + 1] ?? '')
          : /^\s*(-|\d+\.) |^\s{2,}\S/.test(lines[i]))
      ) {
        block.push(lines[i++])
      }
      html.push(list(block))
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*(-|\d+\.) |^\||^#/.test(lines[i]))
      para.push(lines[i++].trim())
    html.push(`<p>${inline(para.join(' '))}</p>`)
  }
  return html.join('\n')
}

function list(block) {
  const indentOf = (line) => line.match(/^\s*/)[0].length
  const base = indentOf(block[0])
  const ordered = /^\s*\d+\. /.test(block[0])
  const items = []
  for (const line of block) {
    if (line.trim() === '') continue
    if (indentOf(line) === base && /^\s*(-|\d+\.) /.test(line))
      items.push({ text: [line.replace(/^\s*(-|\d+\.) /, '')], children: [] })
    else if (indentOf(line) > base && /^\s*(-|\d+\.) /.test(line)) items.at(-1).children.push(line)
    else if (items.at(-1).children.length > 0) items.at(-1).children.push(line)
    else items.at(-1).text.push(line.trim())
  }
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag}>${items
    .map(
      (item) => `<li>${inline(item.text.join(' '))}${item.children.length ? list(item.children) : ''}</li>`,
    )
    .join('')}</${tag}>`
}

function section(title) {
  const start = plan.indexOf(`\n## ${title}\n`)
  if (start < 0) throw new Error(`plan.md has no section "${title}"`)
  const rest = plan.slice(start + title.length + 5)
  const end = rest.search(/\n## /)
  return end < 0 ? rest : rest.slice(0, end)
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1)

const decisionsText = section('Decisions')
const firstTable = decisionsText.slice(decisionsText.indexOf('### Answer these first'))
const answerFirst = new Set(
  [...firstTable.slice(0, firstTable.indexOf('\n### D')).matchAll(/^\| (D\d+a?) /gm)].map((m) => m[1]),
)
const decided = new Set(['D1', 'D2', 'D3', 'D9', 'D39'])

const decisions = [...decisionsText.matchAll(/^### (D\d+a?)\. (.+)\n([\s\S]*?)(?=^### |(?![\s\S]))/gm)].map(
  ([, id, title, body]) => {
    const recommendation = body.match(
      /^- Recommendation:\s*([\s\S]*?)(?=^- [A-Z][a-z]+[^\n]*:|\n\n|(?![\s\S]))/m,
    )?.[1]
    const blocks = body.match(/^- Blocks:\s*(.+)$/m)?.[1] ?? ''
    return {
      id,
      title,
      first: answerFirst.has(id),
      decided: decided.has(id),
      recommendation: recommendation ? capitalise(recommendation.replace(/\s+/g, ' ').trim()) : '',
      blocks: blocks.replace(/\.$/, ''),
      body: markdown(body.replace(/^- Blocks:.+$/m, '')),
    }
  },
)

const inPerson = markdown(section('What Nick has to do in person').replace(/^Collected from[^\n]*\n/, ''))

const card = (d) => `
<article class="decision${d.first ? ' first' : ''}${d.decided ? ' decided' : ''}" id="${d.id.toLowerCase()}" data-id="${d.id}" data-title="${escapeHtml(d.title)}">
  <header>
    <span class="id">${d.id}</span>
    <h3>${inline(d.title)}</h3>
    ${d.first ? '<span class="badge write">Answer first</span>' : ''}
    ${d.decided ? '<span class="badge read">Decided</span>' : ''}
    ${d.blocks ? `<span class="blocks">Blocks ${inline(d.blocks)}</span>` : ''}
  </header>
  ${d.recommendation ? `<p class="rec"><strong>Recommendation.</strong> ${inline(d.recommendation)}</p>` : ''}
  <details><summary>Options and reasoning</summary><div class="body">${d.body}</div></details>
  <fieldset class="answer">
    <label><input type="radio" name="${d.id}" value="accept"> Accept the recommendation</label>
    <label><input type="radio" name="${d.id}" value="other"> Something else</label>
    <label><input type="radio" name="${d.id}" value="discuss"> Discuss with me</label>
    <label><input type="radio" name="${d.id}" value="later"> Later</label>
    <textarea name="${d.id}-note" rows="2" placeholder="Notes, or your answer"></textarea>
  </fieldset>
</article>`

const numbers = status.numbers
  .map(
    (n) =>
      `<div class="stat"><div class="value">${escapeHtml(n.value)}</div><div class="label">${escapeHtml(n.label)}</div></div>`,
  )
  .join('')
const built = status.built
  .map((b) => `<tr><td><code>${escapeHtml(b.area)}</code></td><td>${inline(b.state)}</td></tr>`)
  .join('')
const gaps = status.gaps.map((g) => `<li>${inline(g)}</li>`).join('')
const links = status.links
  .map(
    (group) =>
      `<section class="links"><h3>${escapeHtml(group.title)}</h3><ul>${group.items
        .map((l) => {
          const label = ARTIFACT
            ? `${escapeHtml(l.label)} <code>${escapeHtml(repoPath(l.href))}</code>`
            : `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`
          return `<li>${label}${l.note ? ` <span class="muted">${inline(l.note)}</span>` : ''}</li>`
        })
        .join('')}</ul></section>`,
  )
  .join('')
// The artifact publishes each screenshot beside the page, as screens/<live|mockup>-<name>.png.
const published = {}
const screenSrc = (src) => {
  if (!ARTIFACT) return src
  const name = `screens/${src.includes('/screens/live/') ? 'live' : 'mockup'}-${basename(src)}`
  published[name] = repoPath(src)
  return name
}
const gallery = status.screens
  .map((s) => {
    const src = escapeHtml(screenSrc(s.src))
    return `<figure><a href="${src}"><img loading="lazy" src="${src}" alt="${escapeHtml(s.caption)}"></a><figcaption>${escapeHtml(s.caption)}</figcaption></figure>`
  })
  .join('')

const css = `
  main { max-width: 1100px; margin: 0 auto; padding-block: var(--space-5) 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
  body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg-window); }
  h1 { font-size: var(--text-2xl); margin: 0 0 4px; text-wrap: balance; }
  h2 { font-size: var(--text-xl); margin: var(--space-6) 0 var(--space-3); text-wrap: balance; }
  h3 { font-size: var(--text-lg); margin: 0; }
  nav.tabs { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; background: var(--bg-window); display: flex; gap: 4px; padding: var(--space-3) 0; border-bottom: 0.5px solid var(--border); margin-bottom: var(--space-4); flex-wrap: wrap; }
  nav.tabs a { padding: 4px 12px; border-radius: 999px; color: var(--text); text-decoration: none; }
  nav.tabs a[aria-current="true"] { background: var(--bg-selected); color: var(--accent); font-weight: 600; }
  nav.tabs a:focus-visible, .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3); }
  .stat, .panel, .decision { background: var(--bg-surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); min-width: 0; }
  .stat .value { font-size: var(--text-2xl); font-weight: 650; font-variant-numeric: tabular-nums; }
  .stat .label { color: var(--text-secondary); font-size: var(--text-sm); }
  .panel { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: var(--text-sm); }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 0.5px solid var(--border); }
  code { font-family: var(--font-mono); font-size: 0.92em; background: var(--bg-sunken); padding: 0 4px; border-radius: 4px; overflow-wrap: anywhere; }
  pre { background: var(--bg-sunken); padding: var(--space-3); border-radius: var(--radius-md); overflow-x: auto; }
  pre code { background: none; padding: 0; }
  a { color: var(--accent); }
  .ref { border-bottom: 1px dotted var(--text-tertiary); }
  .decision { margin-bottom: var(--space-3); scroll-margin-top: 64px; }
  .decision.first { border-left: 3px solid var(--write); }
  .decision.answered { border-left: 3px solid var(--read); }
  .decision header { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }
  .decision .id { font-family: var(--font-mono); color: var(--text-secondary); min-width: 36px; }
  .decision .blocks { margin-left: auto; color: var(--text-secondary); font-size: var(--text-sm); }
  .decision .rec { margin: var(--space-2) 0; }
  .decision details { margin: var(--space-2) 0; }
  .decision summary { cursor: pointer; color: var(--text-secondary); }
  .decision .body { font-size: var(--text-sm); overflow-x: auto; }
  .answer { border: none; padding: 0; margin: var(--space-2) 0 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); }
  textarea { flex-basis: 100%; width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border-radius: var(--radius-sm); border: 0.5px solid var(--border-strong); background: var(--bg-window); color: var(--text); }
  textarea:disabled, input:disabled { opacity: 0.6; }
  .reply { margin-top: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--bg-sunken); border-radius: var(--radius-md); font-size: var(--text-sm); white-space: pre-wrap; }
  .reply .who { display: block; font-weight: 600; color: var(--accent); margin-bottom: 2px; white-space: normal; }
  .general { margin-bottom: var(--space-4); display: grid; gap: var(--space-2); }
  .toolbar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
  .toolbar .muted { margin-left: auto; }
  #todo ol > li { margin-bottom: var(--space-2); }
  #todo ol > li > input { margin-right: 8px; }
  #todo ol > li.done { color: var(--text-secondary); }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); }
  .gallery img { width: 100%; border-radius: var(--radius-md); border: 0.5px solid var(--border); }
  .gallery figure { margin: 0; }
  .gallery figcaption { font-size: var(--text-sm); color: var(--text-secondary); }
  .links { margin-bottom: var(--space-4); }
  .links ul { margin: var(--space-2) 0; padding-left: 18px; }
  [hidden] { display: none !important; }
  @media (max-width: 640px) { .decision .blocks { margin-left: 0; } .toolbar .muted { margin-left: 0; flex-basis: 100%; } }
`

// The local hub saves answers.md; the artifact viewer refuses downloads, so it gets no handler.
const DOWNLOAD_HANDLER =
  "  document.getElementById('download')?.addEventListener('click', () => {\n    const link = document.createElement('a')\n    link.href = URL.createObjectURL(new Blob([exportMarkdown()], { type: 'text/markdown' }))\n    link.download = 'answers.md'\n    link.click()\n  })"

const intro = ARTIFACT
  ? 'Your answers save here as you go, and Claude reads them from this page. When you’ve done a batch, say so in the chat. Claude’s replies appear under each answer.'
  : 'Answers stay in this browser. When you’re done, copy them and paste them into the chat, or save <code>answers.md</code> into <code>docs/review/</code>.'

const content = `<main>
  <h1>valet: overnight review</h1>
  <p class="muted">${escapeHtml(status.generated)}. Built from <code>docs/plan.md</code> and <code>docs/review/status.json</code> by <code>node docs/review/build.mjs${ARTIFACT ? ' --artifact' : ''}</code>.</p>
  <nav class="tabs">
    <a href="#overview" data-tab="overview">Overview</a>
    <a href="#decisions-tab" data-tab="decisions-tab">Decisions (${decisions.length})</a>
    <a href="#todo" data-tab="todo">In person</a>
    <a href="#screens" data-tab="screens">Screens</a>
    <a href="#material" data-tab="material">Material</a>
  </nav>

  <section id="overview" data-panel>
    <p>${inline(status.headline)}</p>
    <div class="stats">${numbers}</div>
    <h2>Try it</h2>
    <div class="panel">${markdown(status.tryIt)}</div>
    <h2>What exists</h2>
    <div class="panel"><table><tbody>${built}</tbody></table></div>
    <h2>Known gaps and risks</h2>
    <div class="panel"><ul>${gaps}</ul></div>
  </section>

  <section id="decisions-tab" data-panel hidden>
    <p class="muted">${intro}</p>
    <div class="panel general">
      <label for="general-note"><strong>Anything else for Claude</strong></label>
      <textarea id="general-note" rows="3" placeholder="Priorities, questions, things to change"></textarea>
      <div class="reply" id="general-reply" hidden></div>
    </div>
    <div class="toolbar">
      <button type="button" class="btn" data-filter="first">Answer first</button>
      <button type="button" class="btn" data-filter="open">Unanswered</button>
      <button type="button" class="btn" data-filter="replied">With a reply</button>
      <button type="button" class="btn" data-filter="all">All</button>
      <button type="button" class="btn primary" id="copy">Copy answers as Markdown</button>
      ${ARTIFACT ? '' : '<button type="button" class="btn" id="download">Download answers.md</button>'}
      <span class="muted" id="progress"></span>
      <span class="muted" id="save-state" role="status"></span>
    </div>
    ${decisions.map(card).join('\n')}
  </section>

  <section id="todo" data-panel hidden>
    <div class="panel">${inPerson}</div>
  </section>

  <section id="screens" data-panel hidden>
    <div class="gallery">${gallery}</div>
  </section>

  <section id="material" data-panel hidden>
    ${links}
  </section>
</main>
<script>
  const ARTIFACT = ${ARTIFACT}
  const cards = [...document.querySelectorAll('.decision')]
  const state = { answers: {}, replies: {}, todo: {}, notes: {} }
  const general = document.getElementById('general-note')
  const generalReply = document.getElementById('general-reply')
  const saveState = document.getElementById('save-state')
  const say = (text) => { saveState.textContent = text }
  let backend = null
  let canWrite = false

  for (const card of cards) {
    const reply = document.createElement('div')
    reply.className = 'reply'
    reply.hidden = true
    card.append(reply)
  }
  const todoItems = [...document.querySelectorAll('#todo .panel > ol > li')]
  todoItems.forEach((item, index) => {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.id = 'todo-item-' + (index + 1)
    box.setAttribute('aria-label', 'Done')
    item.prepend(box)
    box.addEventListener('change', () => write('todo', 'item-' + (index + 1), { done: box.checked, at: new Date().toISOString() }))
  })

  function showReply(element, reply) {
    const text = reply && typeof reply.text === 'string' ? reply.text : ''
    element.hidden = !text
    element.replaceChildren()
    if (!text) return
    const who = document.createElement('span')
    who.className = 'who'
    who.textContent = 'Claude' + (reply.at ? ', ' + new Date(reply.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '')
    element.append(who, document.createTextNode(text))
  }

  function render() {
    let done = 0
    for (const card of cards) {
      const id = card.dataset.id
      const a = state.answers[id] || {}
      const answered = Boolean(a.choice || a.note)
      card.classList.toggle('answered', answered)
      card.classList.toggle('replied', Boolean(state.replies[id] && state.replies[id].text))
      if (answered) done++
      for (const radio of card.querySelectorAll('input[type=radio]')) {
        radio.checked = radio.value === a.choice
        radio.disabled = !canWrite
      }
      const note = card.querySelector('textarea')
      if (document.activeElement !== note) note.value = a.note || ''
      note.disabled = !canWrite
      showReply(card.querySelector('.reply'), state.replies[id])
    }
    document.getElementById('progress').textContent = done + ' of ' + cards.length + ' answered'
    todoItems.forEach((item, index) => {
      const box = item.querySelector('input')
      const t = state.todo['item-' + (index + 1)] || {}
      box.checked = Boolean(t.done)
      box.disabled = !canWrite
      item.classList.toggle('done', Boolean(t.done))
    })
    if (document.activeElement !== general) general.value = (state.notes.general && state.notes.general.text) || ''
    general.disabled = !canWrite
    showReply(generalReply, state.replies.general)
  }

  function write(kind, id, value) {
    if (!backend || !canWrite) return
    state[kind] = { ...state[kind], [id]: value }
    render()
    backend.write(kind, id, value)
  }

  const timers = {}
  const later = (key, fn) => { clearTimeout(timers[key]); timers[key] = setTimeout(fn, 800) }
  for (const card of cards) {
    const id = card.dataset.id
    for (const radio of card.querySelectorAll('input[type=radio]'))
      radio.addEventListener('change', () => write('answers', id, { ...state.answers[id], choice: radio.value, at: new Date().toISOString() }))
    const note = card.querySelector('textarea')
    note.addEventListener('input', () => later(id, () => write('answers', id, { ...state.answers[id], note: note.value, at: new Date().toISOString() })))
  }
  general.addEventListener('input', () => later('general', () => write('notes', 'general', { text: general.value, at: new Date().toISOString() })))

  function localBackend() {
    const KEY = 'valet-review'
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null') || { answers: JSON.parse(localStorage.getItem('valet-review-answers') || '{}') }
      state.answers = saved.answers || {}
      state.todo = saved.todo || {}
      state.notes = saved.notes || {}
    } catch {}
    canWrite = true
    return { write: () => { try { localStorage.setItem(KEY, JSON.stringify({ answers: state.answers, todo: state.todo, notes: state.notes })) } catch {} } }
  }

  async function artifactBackend() {
    const use = window.claude && window.claude.use
    const db = use ? await window.claude.use('db') : null
    if (!db) { say('Answers can’t be saved in this view.'); return null }
    const user = await window.claude.use('user')
    canWrite = user ? await user.isOwner() : true
    if (!canWrite) say('Read only: only the owner answers here.')
    const timer = setTimeout(() => say('Can’t reach saved answers yet.'), 10000)
    for (const kind of ['answers', 'replies', 'todo', 'notes']) {
      db.collection(kind).onSnapshot(
        (snap) => {
          if (!snap.metadata.fromCache) { clearTimeout(timer); if (saveState.textContent.startsWith('Can’t reach')) say('') }
          const next = {}
          for (const doc of snap.docs) next[doc.id] = doc.data()
          state[kind] = next
          render()
        },
        (error) => { clearTimeout(timer); say('Saved answers stopped updating (' + error.code + '). Reload the page to reconnect.') },
      )
    }
    const chains = {}
    return {
      write(kind, id, value) {
        const key = kind + '/' + id
        say('Saving…')
        chains[key] = (chains[key] || Promise.resolve())
          .then(() => db.collection(kind).doc(id).set(value))
          .then(
            () => say('Saved'),
            (error) => {
              if (error.code === 'invalid_argument') { canWrite = false; render(); say('This page is read only for you.') }
              else say('Not saved: ' + (error.message || error.code) + '. Try again in a moment.')
            },
          )
      },
    }
  }

  const LABELS = { accept: 'accept the recommendation', other: 'something else', discuss: 'discuss', later: 'later' }
  function exportMarkdown() {
    const lines = ['# Decisions from the overnight review', '']
    for (const card of cards) {
      const a = state.answers[card.dataset.id]
      if (!a || !(a.choice || a.note)) continue
      lines.push('- **' + card.dataset.id + ' ' + card.dataset.title + '**: ' + (LABELS[a.choice] || 'note') + (a.note ? '. ' + a.note.trim().replace(/\\n+/g, ' ') : ''))
    }
    if (state.notes.general && state.notes.general.text) lines.push('', state.notes.general.text.trim())
    return lines.join('\\n') + '\\n'
  }
  document.getElementById('copy').addEventListener('click', async (event) => {
    const button = event.currentTarget
    try { await navigator.clipboard.writeText(exportMarkdown()); button.textContent = 'Copied' }
    catch { button.textContent = 'Copy failed' }
    setTimeout(() => { button.textContent = 'Copy answers as Markdown' }, 1500)
  })
${ARTIFACT ? '' : DOWNLOAD_HANDLER}
  function filter(kind) {
    for (const card of cards) {
      card.hidden =
        (kind === 'first' && !card.classList.contains('first')) ||
        (kind === 'open' && card.classList.contains('answered')) ||
        (kind === 'replied' && !card.classList.contains('replied'))
    }
  }
  for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => filter(button.dataset.filter))

  function show(tab) {
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.id !== tab
    for (const link of document.querySelectorAll('nav.tabs a')) link.setAttribute('aria-current', String(link.dataset.tab === tab))
  }
  function route() {
    const hash = location.hash.slice(1)
    if (/^d\\d+a?$/.test(hash)) { show('decisions-tab'); filter('all'); document.getElementById(hash)?.scrollIntoView(); return }
    show(document.getElementById(hash)?.dataset.panel !== undefined ? hash : 'overview')
  }
  window.addEventListener('hashchange', route)
  route()
  render()
  if (ARTIFACT) artifactBackend().then((b) => { backend = b; render() })
  else { backend = localBackend(); render() }
</script>
`

const tokens = readFileSync(join(docs, 'mockups', 'tokens.css'), 'utf8')

if (ARTIFACT) {
  // The publish step wraps this in the document skeleton, so the page starts with its title.
  const out = join(here, 'artifact')
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'index.html'),
    `<title>Valet review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${tokens}
${css}
</style>
${content}`,
  )
  writeFileSync(join(out, 'files.json'), `${JSON.stringify(published, null, 2)}\n`)
  console.log(
    `wrote docs/review/artifact/: ${decisions.length} decisions, ${Object.keys(published).length} screenshots`,
  )
} else {
  writeFileSync(
    join(here, 'index.html'),
    `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Valet review</title>
<link rel="stylesheet" href="../mockups/tokens.css">
<style>${css}</style>
</head>
<body>
${content}</body>
</html>
`,
  )
  console.log(
    `wrote docs/review/index.html: ${decisions.length} decisions, ${answerFirst.size} to answer first`,
  )
}
