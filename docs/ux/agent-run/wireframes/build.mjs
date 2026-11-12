// Assembles the agent-run wireframes page from the v3 kit (../../wireframes: template, kit.css,
// kit.js) plus the phone kit here (phone.css, phone.js), intro.html and frames/*.js -> index.html.
// Run: node docs/ux/agent-run/wireframes/build.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const v3 = join(here, '..', '..', 'wireframes')
const read = (dir, p) => readFileSync(join(dir, p), 'utf8')
const frames = readdirSync(join(here, 'frames'))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => `<script>/* ${f} */\n${read(here, join('frames', f))}\n</script>`)
  .join('\n')
const swap = (s, from, to) => {
  if (!s.includes(from)) throw new Error(`template changed: missing ${from.slice(0, 60)}`)
  return s.replace(from, () => to)
}
let html = read(v3, 'template.html')
html = swap(html, '<title>Valet wireframes</title>', '<title>Agent-run Valet wireframes</title>')
html = swap(html, '<b>Valet wireframes</b>', '<b>Agent-run Valet</b>')
html = swap(
  html,
  '<h1>Valet: information architecture and wireframes</h1>',
  '<h1>Agent-run Valet: journeys and wireframes</h1>',
)
html = html.replace(
  /<p class="lede">Every page and state of the redesigned[^<]*<\/p>/,
  () =>
    '<p class="lede">Journeys J1 to J8 for Valet run by your own agents, with approvals on the iPhone and the Mac. Phone frames are drawn at 393 × 852 points, Mac frames at the real 1180 × 780 window. Pink numbers match the notes beside each frame. Specs: <code>docs/ux/agent-run/</code>.</p>',
)
html = swap(html, 'banner:[1180,780] }', 'banner:[1180,780], phone:[393,852] }')
html = swap(html, '/*KITCSS*/', read(v3, 'kit.css') + '\n' + read(here, 'phone.css'))
html = swap(html, '/*KITJS*/', read(v3, 'kit.js') + '\n' + read(here, 'phone.js'))
html = swap(html, '<!--INTRO-->', read(here, 'intro.html'))
html = swap(html, '<!--FRAMESJS-->', frames)
writeFileSync(join(here, 'index.html'), html)
const count = (html.match(/FRAMES\.push\(/g) || []).length
console.log(
  `index.html: ${html.length} bytes, ${frames.split('<script>').length - 1} frame files, ${count} pushes`,
)
