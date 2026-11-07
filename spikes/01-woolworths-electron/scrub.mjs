// pnpm scrub: checks every results/*.json for anything shaped like a secret, and if all are clean
// writes results/findings-draft.md, a summary to copy into docs/ after a read. It exits 1 and
// writes nothing if any file fails; fix the spike, not the check.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findLeaks } from './lib.mjs'

function summarise(name, r) {
  const lines = [`## ${name}`, '', `${r.mode} mode, ${r.uaMode} user agent, ${r.at}, Electron ${r.electron}.`]
  if (r.blocked) lines.push('', `**Stopped on a block:** ${r.blocked}`)
  if (r.mode === 'login') {
    for (const page of r.authPages ?? []) {
      const forms = page.forms
        .map(
          (f) =>
            `${f.fields.map((x) => `${x.name ?? x.id}:${x.type ?? x.tag}`).join(', ')} → ${f.actionOrigin}`,
        )
        .join('; ')
      lines.push(
        `- ${page.host}${page.path}: ${forms}${page.rememberDevice ? ' (remember this device offered)' : ''}`,
      )
    }
    for (const [world, p] of Object.entries(r.toolProbe ?? {})) {
      lines.push(
        `- trolley in the ${world} world: ${p.error ?? `${p.status}, ${p.isJson ? 'JSON' : 'not JSON'}`}`,
      )
    }
    if (r.authCookies) lines.push(`- auth cookies: ${r.authCookies.map((c) => c.name).join(', ')}`)
    if (r.toolCookiesAfterLoad)
      lines.push(`- tool cookies: ${r.toolCookiesAfterLoad.map((c) => c.name).join(', ')}`)
  }
  if (r.mode === 'silent' && r.verdict) {
    lines.push(
      `- verdict: ${r.verdict.outcome}`,
      `- steps: ${(r.steps ?? []).map((s) => s.host + s.path).join(' → ')}`,
    )
  }
  if (r.mode === 'probe' && r.bootstrap) {
    lines.push(
      `- bootstrap: ${r.bootstrap.error ?? r.bootstrap.status}`,
      '',
      '```json',
      JSON.stringify(r.bootstrap.keys, null, 2),
      '```',
    )
  }
  if (r.mode === 'record') {
    lines.push('', '| page | requests | page-initiated | deny | cancelled |', '|---|---|---|---|---|')
    for (const v of r.summary ?? [])
      lines.push(`| ${v.path} | ${v.requests} | ${v.pageInitiated} | ${v.deny} | ${v.cancelled} |`)
  }
  return lines.join('\n')
}

/** Checks every result file; returns the leaks, or the draft when there are none. */
export async function scrub(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).sort()
  const leaks = []
  const sections = []
  for (const name of names) {
    const text = await readFile(join(dir, name), 'utf8')
    for (const leak of findLeaks(text)) leaks.push({ file: name, ...leak })
    sections.push(summarise(name, JSON.parse(text)))
  }
  const draft = ['# Spike 1 findings (draft)', '', ...sections.flatMap((s) => [s, ''])].join('\n')
  for (const leak of findLeaks(draft)) leaks.push({ file: 'findings-draft.md', ...leak })
  return { files: names.length, leaks, draft: leaks.length === 0 ? draft : null }
}

/* v8 ignore start */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = join(import.meta.dirname, 'results')
  const { files, leaks, draft } = await scrub(dir)
  if (leaks.length > 0) {
    for (const l of leaks) console.error(`${l.file}:${l.line}: looks like a ${l.kind}`)
    console.error(`scrub failed: ${leaks.length} suspect lines in ${files} files; nothing written`)
    process.exit(1)
  }
  await writeFile(join(dir, 'findings-draft.md'), draft)
  console.log(`scrub passed: ${files} files; wrote results/findings-draft.md`)
}
/* v8 ignore stop */
