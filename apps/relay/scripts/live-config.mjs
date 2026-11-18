// Writes the live deploy's wrangler config: wrangler.jsonc with wrangler.live.jsonc laid over it
// (top-level keys replaced, `vars` merged), and GIT_SHA set so the deploy can check that the Hub
// object itself runs the new code (/api/version). The deploy-hub workflow runs this; so can a person.
//
//   node scripts/live-config.mjs <git sha> [out]   (out defaults to wrangler.live.generated.json)

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const [sha, out = 'wrangler.live.generated.json'] = process.argv.slice(2)
if (!/^[0-9a-f]{7,40}$/.test(sha ?? '')) {
  console.error('usage: node scripts/live-config.mjs <git sha> [out]')
  process.exit(2)
}

const base = readJsonc(join(here, 'wrangler.jsonc'))
const live = readJsonc(join(here, 'wrangler.live.jsonc'))
const merged = { ...base, ...live, vars: { ...base.vars, ...live.vars, GIT_SHA: sha } }
// The generated file sits beside wrangler.jsonc, so `main` and the schema path still resolve.
writeFileSync(join(here, out), `${JSON.stringify(merged, null, 2)}\n`)
console.log(`wrote ${out} for ${sha}`)

/** JSON with // and /* comments and trailing commas, as wrangler reads it. */
export function readJsonc(path) {
  return JSON.parse(stripJsonc(readFileSync(path, 'utf8')))
}

export function stripJsonc(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      // A string, escapes and all.
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  // Trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1')
}
