// What scripts/package.mjs and scripts/package-smoke.mjs share: electron-builder run as an
// unsigned development build, on a copy of the installed Electron, with none of the caller's
// signing or notarisation variables.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const BUILDER = join(APP_DIR, 'node_modules', '.bin', 'electron-builder')
export const CONFIG = join(APP_DIR, 'electron-builder.config.ts')

/**
 * The caller's environment without anything that could sign, notarise, make a release or reach
 * into Electron's or Node's start-up: no CSC_*, APPLE_*, SITEADAPTER_* (but `keep`), ELECTRON_* or
 * NODE_OPTIONS. Never signing with an identity: CSC_IDENTITY_AUTO_DISCOVERY=false.
 */
export function cleanEnv(extra = {}, keep = []) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (keep.includes(name)) continue
    if (/^(CSC_|APPLE_|SITEADAPTER_|ELECTRON_|NODE_OPTIONS)/.test(name)) delete env[name]
  }
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...extra }
}

/**
 * The installed Electron, cloned (APFS copy-on-write) into `work` without the default app:
 * electron-builder skips its own clean-up when given electronDist, and the bundle should match
 * what a release (which downloads Electron) contains.
 */
export function electronDist(work) {
  const dist = join(work, 'electron-dist')
  execFileSync('/bin/cp', ['-cR', join(APP_DIR, 'node_modules', 'electron', 'dist'), dist])
  rmSync(join(dist, 'Electron.app', 'Contents', 'Resources', 'default_app.asar'), { force: true })
  return dist
}

export function electronVersion() {
  return JSON.parse(readFileSync(join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version
}

/**
 * Runs electron-builder for macOS: `targets` (dir, zip) for `arch`, from `projectDir`, into
 * `output`. For the host's architecture it builds from `dist` (electronDist); the other one needs
 * electron-builder to download that Electron (network), as a real build does.
 */
export function runBuilder({ projectDir, output, targets, arch, dist, env }) {
  execFileSync(
    BUILDER,
    [
      '--mac',
      ...targets,
      `--${arch}`,
      '--projectDir',
      projectDir,
      '--config',
      CONFIG,
      `-c.electronVersion=${electronVersion()}`,
      `-c.directories.output=${output}`,
      ...(dist === null ? [] : [`-c.electronDist=${dist}`]),
      '--publish',
      'never',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], env },
  )
}

/** Every .js file under out/main, joined, or null when there is no out/main/index.js. */
export function mainBundle(dir = join(APP_DIR, 'out', 'main')) {
  if (!existsSync(join(dir, 'index.js'))) return null
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

/** The .app electron-builder made in `output` for `arch`. */
export function appPath(output, arch, productName = 'siteadapter-dev') {
  return join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', `${productName}.app`)
}

/** The file list in app.asar, from its JSON header (two pickled sizes, then the header). */
export function asarFiles(path) {
  const buffer = readFileSync(path)
  const header = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)).toString('utf8'))
  const files = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      if (child.files) walk(child, `${prefix}${name}/`)
      else files.push(`${prefix}${name}`)
    }
  }
  walk(header, '')
  return files.sort()
}

export function plist(path) {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }),
  )
}
