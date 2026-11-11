#!/usr/bin/env node
// Packages a showcase build (out/, from `electron-vite build --mode showcase`) as Valet Demo: an
// unsigned development package for this Mac's architecture, as a DMG a person installs by dragging
// it to Applications. A showcase build is demo mode always (src/main/core/showcase.ts): the fake
// shop in its own process, the fake's test account, no real 1Password, Keychain item or Messages.
// It exists for the recorded install-to-order demo (.github/workflows/demo-video.yml).
//
//   pnpm --filter @valet/desktop package:showcase   # build --mode showcase, then this
//   node scripts/package-showcase.mjs [--out <dir>]
//
// Like scripts/package.mjs it never signs with an identity or notarises: the fuse flip re-signs the
// bundle ad hoc ("-"), and none of the caller's CSC_*, APPLE_* or VALET_* variables reach
// electron-builder but VALET_SHOWCASE, which this script sets.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, cleanEnv, electronDist, runBuilder } from './packaging.mjs'

const { values } = parseArgs({
  options: { out: { type: 'string', default: join(APP_DIR, 'dist', 'showcase') } },
})
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
if (!existsSync(join(APP_DIR, 'out', 'main', 'index.js'))) {
  process.stderr.write(
    'package-showcase: no out/main/index.js; run `electron-vite build --mode showcase` first\n',
  )
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'valet-showcase-'))
try {
  const output = resolve(values.out)
  runBuilder({
    projectDir: APP_DIR,
    output,
    targets: ['dmg'],
    arch,
    dist: electronDist(work),
    env: cleanEnv({ VALET_SHOWCASE: '1' }),
  })
  const dmg = readdirSync(output).find((name) => name.endsWith('.dmg'))
  if (dmg === undefined) throw new Error('package-showcase: electron-builder made no DMG')
  process.stdout.write(`package-showcase: ${join(output, dmg)}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
