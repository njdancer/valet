// Assembles the single-file wireframe page: template.html + kit.css + kit.js + intro.html +
// frames/*.js (in name order) -> index.html. Run: node docs/ux/wireframes/build.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(here, p), 'utf8')
const frames = readdirSync(join(here, 'frames'))
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => `<script>/* ${f} */\n${read(join('frames', f))}\n</script>`)
  .join('\n')
const html = read('template.html')
  .replace('/*KITCSS*/', () => read('kit.css'))
  .replace('/*KITJS*/', () => read('kit.js'))
  .replace('<!--INTRO-->', () => read('intro.html'))
  .replace('<!--FRAMESJS-->', () => frames)
writeFileSync(join(here, 'index.html'), html)
console.log(`index.html: ${html.length} bytes, ${frames.split('<script>').length - 1} frame files`)
