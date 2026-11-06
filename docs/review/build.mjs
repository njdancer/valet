// Builds docs/review/index.html: the review hub. Decisions and the in-person list come from
// docs/plan.md, status from docs/review/status.json. No dependencies; run with
//   node docs/review/build.mjs
// Answers are kept in the browser (localStorage) and exported as Markdown to paste back.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dirname
const docs = join(here, '..')
const plan = readFileSync(join(docs, 'plan.md'), 'utf8')
const status = JSON.parse(readFileSync(join(here, 'status.json'), 'utf8'))

const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// Links in plan.md are relative to docs/; the hub lives in docs/review/. Anchors to decisions
// become links to the decision cards.
function href(target) {
  if (/^#d\d+a?-/i.test(target)) return `#${target.slice(1).split('-')[0].toLowerCase()}`
  if (target.startsWith('#')) return `../plan.md${target}`
  if (/^[a-z]+:/i.test(target)) return target
  return `../${target}`
}

function inline(text) {
  const codes = []
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escape(code)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  out = escape(out)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, target) => `<a href="${escape(href(target))}">${label}</a>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>')
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)])
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
      const cells = (row) => row.slice(1, -1).split('|').map((cell) => inline(cell.trim()))
      const [head, , ...body] = rows
      html.push(
        `<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body
          .map((row) => `<tr>${cells(row).map((c) => `<td>${c}</td>`).join('')}</tr>`)
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
      while (i < lines.length && (lines[i].trim() === '' ? /^\s+(-|\d+\.) |^\s{2,}\S/.test(lines[i + 1] ?? '') : /^\s*(-|\d+\.) |^\s{2,}\S/.test(lines[i]))) {
        block.push(lines[i++])
      }
      html.push(list(block))
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !/^\s*(-|\d+\.) |^\||^#/.test(lines[i])) para.push(lines[i++].trim())
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
    if (indentOf(line) === base && /^\s*(-|\d+\.) /.test(line)) items.push({ text: [line.replace(/^\s*(-|\d+\.) /, '')], children: [] })
    else if (indentOf(line) > base && /^\s*(-|\d+\.) /.test(line)) items.at(-1).children.push(line)
    else if (items.at(-1).children.length > 0) items.at(-1).children.push(line)
    else items.at(-1).text.push(line.trim())
  }
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag}>${items
    .map((item) => `<li>${inline(item.text.join(' '))}${item.children.length ? list(item.children) : ''}</li>`)
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
const answerFirst = new Set([...firstTable.slice(0, firstTable.indexOf('\n### D')).matchAll(/^\| (D\d+a?) /gm)].map((m) => m[1]))
const decided = new Set(['D9', 'D39'])

const decisions = [...decisionsText.matchAll(/^### (D\d+a?)\. (.+)\n([\s\S]*?)(?=^### |(?![\s\S]))/gm)].map(([, id, title, body]) => {
  const recommendation = body.match(/^- Recommendation:\s*([\s\S]*?)(?=^- [A-Z][a-z]+[^\n]*:|\n\n|(?![\s\S]))/m)?.[1]
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
})

const inPerson = markdown(section('What Nick has to do in person').replace(/^Collected from[^\n]*\n/, ''))

const card = (d) => `
<article class="decision${d.first ? ' first' : ''}${d.decided ? ' decided' : ''}" id="${d.id.toLowerCase()}" data-id="${d.id}" data-title="${escape(d.title)}">
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

const numbers = status.numbers.map((n) => `<div class="stat"><div class="value">${escape(n.value)}</div><div class="label">${escape(n.label)}</div></div>`).join('')
const built = status.built.map((b) => `<tr><td><code>${escape(b.area)}</code></td><td>${inline(b.state)}</td></tr>`).join('')
const gaps = status.gaps.map((g) => `<li>${inline(g)}</li>`).join('')
const links = status.links
  .map((group) => `<section class="links"><h3>${escape(group.title)}</h3><ul>${group.items.map((l) => `<li><a href="${escape(l.href)}">${escape(l.label)}</a>${l.note ? ` <span class="muted">${inline(l.note)}</span>` : ''}</li>`).join('')}</ul></section>`)
  .join('')
const gallery = status.screens
  .map((s) => `<figure><a href="${escape(s.src)}"><img loading="lazy" src="${escape(s.src)}" alt="${escape(s.caption)}"></a><figcaption>${escape(s.caption)}</figcaption></figure>`)
  .join('')

const html = `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>siteadapter review</title>
<link rel="stylesheet" href="../mockups/tokens.css">
<style>
  body { background: var(--bg-window); }
  main { max-width: 1100px; margin: 0 auto; padding: var(--space-5) var(--space-4) 80px; }
  h1 { font-size: var(--text-2xl); margin: 0 0 4px; }
  h2 { font-size: var(--text-xl); margin: var(--space-6) 0 var(--space-3); }
  h3 { font-size: var(--text-lg); margin: 0; }
  nav.tabs { position: sticky; top: 0; z-index: 2; background: var(--bg-window); display: flex; gap: 4px; padding: var(--space-3) 0; border-bottom: 0.5px solid var(--border); margin-bottom: var(--space-4); flex-wrap: wrap; }
  nav.tabs a { padding: 4px 12px; border-radius: 999px; color: var(--text); text-decoration: none; }
  nav.tabs a[aria-current="true"] { background: var(--bg-selected); color: var(--accent); font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3); }
  .stat, .panel, .decision { background: var(--bg-surface); border: 0.5px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-4); }
  .stat .value { font-size: var(--text-2xl); font-weight: 650; }
  .stat .label { color: var(--text-secondary); font-size: var(--text-sm); }
  table { border-collapse: collapse; width: 100%; font-size: var(--text-sm); }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 0.5px solid var(--border); }
  code { font-family: var(--font-mono); font-size: 0.92em; background: var(--bg-sunken); padding: 0 4px; border-radius: 4px; }
  pre { background: var(--bg-sunken); padding: var(--space-3); border-radius: var(--radius-md); overflow-x: auto; }
  pre code { background: none; padding: 0; }
  a { color: var(--accent); }
  .decision { margin-bottom: var(--space-3); scroll-margin-top: 64px; }
  .decision.first { border-left: 3px solid var(--write); }
  .decision.answered { border-left: 3px solid var(--read); }
  .decision header { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }
  .decision .id { font-family: var(--font-mono); color: var(--text-secondary); min-width: 36px; }
  .decision .blocks { margin-left: auto; color: var(--text-secondary); font-size: var(--text-sm); }
  .decision .rec { margin: var(--space-2) 0; }
  .decision details { margin: var(--space-2) 0; }
  .decision summary { cursor: pointer; color: var(--text-secondary); }
  .decision .body { font-size: var(--text-sm); }
  .answer { border: none; padding: 0; margin: var(--space-2) 0 0; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); }
  .answer textarea { flex-basis: 100%; font: inherit; padding: 6px 8px; border-radius: var(--radius-sm); border: 0.5px solid var(--border-strong); background: var(--bg-window); color: var(--text); }
  .toolbar { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
  .toolbar .muted { margin-left: auto; }
  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); }
  .gallery img { width: 100%; border-radius: var(--radius-md); border: 0.5px solid var(--border); }
  .gallery figure { margin: 0; }
  .gallery figcaption { font-size: var(--text-sm); color: var(--text-secondary); }
  .links { margin-bottom: var(--space-4); }
  .links ul { margin: var(--space-2) 0; padding-left: 18px; }
  [hidden] { display: none !important; }
  @media (max-width: 640px) { .decision .blocks { margin-left: 0; } }
</style>
</head>
<body>
<main>
  <h1>siteadapter: overnight review</h1>
  <p class="muted">${escape(status.generated)}. Built from <code>docs/plan.md</code> and <code>docs/review/status.json</code> by <code>node docs/review/build.mjs</code>.</p>
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
    <div class="toolbar">
      <button class="btn" data-filter="first">Answer first</button>
      <button class="btn" data-filter="open">Unanswered</button>
      <button class="btn" data-filter="all">All</button>
      <button class="btn primary" id="copy">Copy answers as Markdown</button>
      <button class="btn" id="download">Download answers.md</button>
      <span class="muted" id="progress"></span>
    </div>
    <p class="muted">Answers stay in this browser. When you're done, copy them and paste them into the chat, or save <code>answers.md</code> into <code>docs/review/</code>.</p>
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
  const KEY = 'siteadapter-review-answers'
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }
  const write = (value) => { try { localStorage.setItem(KEY, JSON.stringify(value)) } catch {} }
  const answers = read()
  const cards = [...document.querySelectorAll('.decision')]

  function refresh() {
    let done = 0
    for (const card of cards) {
      const a = answers[card.dataset.id]
      const answered = Boolean(a && (a.choice || a.note))
      card.classList.toggle('answered', answered)
      if (answered) done++
    }
    document.getElementById('progress').textContent = done + ' of ' + cards.length + ' answered'
  }

  for (const card of cards) {
    const id = card.dataset.id
    const saved = answers[id] || {}
    for (const radio of card.querySelectorAll('input[type=radio]')) {
      radio.checked = radio.value === saved.choice
      radio.addEventListener('change', () => { answers[id] = { ...answers[id], choice: radio.value }; write(answers); refresh() })
    }
    const note = card.querySelector('textarea')
    note.value = saved.note || ''
    note.addEventListener('input', () => { answers[id] = { ...answers[id], note: note.value }; write(answers); refresh() })
  }

  const LABELS = { accept: 'accept the recommendation', other: 'something else', discuss: 'discuss', later: 'later' }
  function exportMarkdown() {
    const lines = ['# Decisions from the overnight review', '']
    for (const card of cards) {
      const a = answers[card.dataset.id]
      if (!a || !(a.choice || a.note)) continue
      lines.push('- **' + card.dataset.id + ' ' + card.dataset.title + '**: ' + (LABELS[a.choice] || 'note') + (a.note ? '. ' + a.note.trim().replace(/\\n+/g, ' ') : ''))
    }
    return lines.join('\\n') + '\\n'
  }
  document.getElementById('copy').addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(exportMarkdown())
    event.target.textContent = 'Copied'
    setTimeout(() => { event.target.textContent = 'Copy answers as Markdown' }, 1500)
  })
  document.getElementById('download').addEventListener('click', () => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([exportMarkdown()], { type: 'text/markdown' }))
    link.download = 'answers.md'
    link.click()
  })

  function filter(kind) {
    for (const card of cards) {
      const answered = card.classList.contains('answered')
      card.hidden = (kind === 'first' && !card.classList.contains('first')) || (kind === 'open' && answered)
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
  refresh()
</script>
</body>
</html>
`

writeFileSync(join(here, 'index.html'), html)
console.log(`wrote docs/review/index.html: ${decisions.length} decisions, ${answerFirst.size} to answer first`)
