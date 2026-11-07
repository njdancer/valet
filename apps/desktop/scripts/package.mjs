#!/usr/bin/env node
// Packages the built app (out/, from `electron-vite build`) as an unsigned development build for
// this Mac's architecture: Valet Dev.app (dist/mac-arm64 or dist/mac) and its zip, in dist/.
// The fuse flip re-signs it ad hoc ("-"), which uses no key. It never signs with an identity or
// notarises, and passes none of the caller's CSC_*, APPLE_* or VALET_* variables to
// electron-builder but VALET_UPDATE_URL (written to app-update.yml, as the build's feed).
//
//   mise exec -- pnpm --filter @valet/desktop package
//   node scripts/package.mjs [--target dir|zip|both] [--out <dir>]

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, appPath, cleanEnv, electronDist, runBuilder } from './packaging.mjs'

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'both' },
    out: { type: 'string', default: join(APP_DIR, 'dist') },
  },
})
const targets = { dir: ['dir'], zip: ['zip'], both: ['dir', 'zip'] }[values.target]
if (targets === undefined) throw new Error('--target is dir, zip or both')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
if (!existsSync(join(APP_DIR, 'out', 'main', 'index.js'))) {
  process.stderr.write('package: no out/main/index.js; run `electron-vite build` first\n')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'valet-package-'))
try {
  const output = resolve(values.out)
  runBuilder({
    projectDir: APP_DIR,
    output,
    targets,
    arch,
    dist: electronDist(work),
    env: cleanEnv({}, ['VALET_UPDATE_URL']),
  })
  process.stdout.write(`package: ${appPath(output, arch)}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
