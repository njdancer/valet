#!/usr/bin/env node
// Packages the built app (out/, from `electron-vite build`) as an unsigned development build for
// this Mac's architecture: Valet Dev.app (dist/mac-arm64 or dist/mac) and its zip, in dist/.
// It builds the Swift bridge and helpers first (universal, as a release ships them) and refuses to
// finish without them: a packaged app with no approver or Keychain helper can't open its trusted
// approvals store and locks itself down. `--skip-swift` uses whatever is already built.
// The fuse flip re-signs it ad hoc ("-"), which uses no key. It never signs with an identity or
// notarises, and passes none of the caller's CSC_*, APPLE_* or VALET_* variables to
// electron-builder but VALET_UPDATE_URL (written to app-update.yml, as the build's feed).
//
//   mise exec -- pnpm --filter @valet/desktop package
//   node scripts/package.mjs [--target dir|zip|both] [--out <dir>]

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, appPath, cleanEnv, electronDist, runBuilder } from './packaging.mjs'

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: 'both' },
    out: { type: 'string', default: join(APP_DIR, 'dist') },
    'skip-swift': { type: 'boolean', default: false },
  },
})
const targets = { dir: ['dir'], zip: ['zip'], both: ['dir', 'zip'] }[values.target]
if (targets === undefined) throw new Error('--target is dir, zip or both')
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
if (!existsSync(join(APP_DIR, 'out', 'main', 'index.js'))) {
  process.stderr.write('package: no out/main/index.js; run `electron-vite build` first\n')
  process.exit(1)
}

// electron-builder.config.ts's SWIFT_BUILD_DIR and NATIVE_EXECUTABLES (kept equal by hand: this is a .mjs).
const SWIFT_PACKAGE = resolve(APP_DIR, '../../swift-bridge')
const SWIFT_PRODUCTS = join(SWIFT_PACKAGE, '.build', 'apple', 'Products', 'Release')
const NATIVE = ['valet-bridge', 'valet-keychain', 'valet-messages-helper', 'valet-approver']
if (!values['skip-swift']) {
  process.stdout.write('package: building the Swift bridge and helpers (universal, release)\n')
  execFileSync(
    'swift',
    ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--package-path', SWIFT_PACKAGE],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  )
}
const unbuilt = NATIVE.filter((name) => !existsSync(join(SWIFT_PRODUCTS, name)))
if (unbuilt.length > 0) {
  process.stderr.write(
    `package: no ${unbuilt.join(', ')} in ${SWIFT_PRODUCTS}; build them without --skip-swift\n`,
  )
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
  const app = appPath(output, arch)
  // The approvals store needs these beside the app's own executable (app.ts, nativeHelper).
  const missing = NATIVE.filter((name) => !existsSync(join(app, 'Contents', 'MacOS', name)))
  if (missing.length > 0) throw new Error(`package: ${app} has no ${missing.join(', ')} in Contents/MacOS`)
  process.stdout.write(`package: ${app}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
