#!/usr/bin/env node
// Packages a placeholder app (scripts/smoke/main.cjs) with the real electron-builder config, as a
// development build, unsigned, in a temporary directory. Then it checks what came out and launches it
// to see that the fuses hold. Proof that the packaging config works before the main process exists.
// Nothing it builds is kept unless --keep is given.
//
//   node scripts/package-smoke.mjs [--arch arm64|x64] [--target dir|zip] [--keep]
//
// The other architecture than the host's needs electron-builder to download that Electron build.
// --target zip also builds the zip and compares electron-builder's latest-mac.yml with what
// scripts/make-feed.mjs writes for the same zip.
//
// It never signs with an identity or notarises: the child gets CSC_IDENTITY_AUTO_DISCOVERY=false and
// none of the CSC_*, APPLE_* or SITEADAPTER_* variables from the caller. The fuse flip re-signs the
// bundle ad hoc ("-"), which uses no key, and which Apple silicon needs to run a modified binary at
// all. Launches use a temporary --user-data-dir and Chromium's mock keychain, so nothing is written to
// ~/Library or the Keychain. Every launch is killed after 30 seconds if it hasn't exited.

import { execFileSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildFeedYaml, hashZip } from './make-feed.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILDER = join(APP_DIR, 'node_modules', '.bin', 'electron-builder')
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
// @electron/fuses 1.8.0's names, in wire order. Electron 44's wire is longer; extra ones print as fuseN.
const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
]
const VERSION = '0.1.0'

const { values } = parseArgs({
  options: {
    arch: { type: 'string', default: process.arch },
    target: { type: 'string', default: 'dir' },
    keep: { type: 'boolean', default: false },
  },
})
const { arch, target } = values
if (arch !== 'arm64' && arch !== 'x64') throw new Error('--arch is arm64 or x64')
if (target !== 'dir' && target !== 'zip') throw new Error('--target is dir or zip')

const work = mkdtempSync(join(tmpdir(), 'siteadapter-package-'))
const project = join(work, 'project')

function writePlaceholder() {
  mkdirSync(join(project, 'out', 'main'), { recursive: true })
  mkdirSync(join(project, 'out', 'renderer', 'assets'), { recursive: true })
  const pkg = { name: 'siteadapter-desktop-placeholder', version: VERSION, main: 'out/main/index.js' }
  writeFileSync(join(project, 'package.json'), JSON.stringify(pkg, null, 2))
  cpSync(join(APP_DIR, 'scripts', 'smoke', 'main.cjs'), join(project, 'out', 'main', 'index.js'))
  // Must not be packaged: the config excludes source maps.
  writeFileSync(join(project, 'out', 'main', 'index.js.map'), '{}')
  writeFileSync(
    join(project, 'out', 'renderer', 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>loading</title>' +
      '<script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>',
  )
  writeFileSync(join(project, 'out', 'renderer', 'assets', 'app.js'), "document.title = 'module-ok'\n")
  // electron-builder reads build resources (entitlements) relative to the project.
  cpSync(join(APP_DIR, 'build'), join(project, 'build'), { recursive: true })
}

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(CSC_|APPLE_|SITEADAPTER_|ELECTRON_|NODE_OPTIONS)/.test(name)) delete env[name]
  }
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...extra }
}

function build() {
  const electron = JSON.parse(readFileSync(join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8'))
  execFileSync(
    BUILDER,
    [
      '--mac',
      ...(target === 'dir' ? ['--dir'] : ['zip']),
      `--${arch}`,
      '--projectDir',
      project,
      '--config',
      join(APP_DIR, 'electron-builder.config.ts'),
      `-c.electronVersion=${electron.version}`,
      // The installed Electron is the host's architecture only; for the other one electron-builder
      // downloads Electron itself (network), as a real build does.
      ...(arch === process.arch
        ? [`-c.electronDist=${join(APP_DIR, 'node_modules', 'electron', 'dist')}`]
        : []),
      '--publish',
      'never',
    ],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: cleanEnv({ SITEADAPTER_UPDATE_URL: 'http://127.0.0.1:4555/' }),
    },
  )
}

function plist(path) {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }),
  )
}

/** The file list in app.asar, from its JSON header (two pickled sizes, then the header). */
function asarFiles(path) {
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

/** The fuse wire as @electron/fuses reads it: sentinel, version, length, then one byte per fuse. */
function fuses(app) {
  const binary = readFileSync(
    join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  )
  const at = binary.indexOf(SENTINEL)
  if (at === -1) throw new Error('no fuse sentinel')
  const wire = at + SENTINEL.length
  const states = { 48: 'off', 49: 'on', 114: 'removed' }
  const result = { version: binary[wire] }
  for (let i = 0; i < binary[wire + 1]; i++) {
    result[FUSE_NAMES[i] ?? `fuse${i}`] = states[binary[wire + 2 + i]] ?? 'unknown'
  }
  return result
}

function sh(script, ...args) {
  return execFileSync('/bin/sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' })
}

/** Runs the app once: its report (or null), its exit, and whether it had to be killed. */
function launch(app, name, { args = [], env = {} } = {}) {
  const executable = join(
    app,
    'Contents',
    'MacOS',
    plist(join(app, 'Contents', 'Info.plist')).CFBundleExecutable,
  )
  const reportPath = join(work, `report-${name}.json`)
  return new Promise((done) => {
    const child = spawn(executable, [`--user-data-dir=${join(work, `userData-${name}`)}`, ...args], {
      env: cleanEnv({ SITEADAPTER_SMOKE_REPORT: reportPath, ...env }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (d) => {
      output += d
    })
    child.stderr.on('data', (d) => {
      output += d
    })
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, 30_000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
      const integrity = /integrity/i.test(output)
      done({ code, signal, killed, report, debuggerListening: /Debugger listening/.test(output), integrity })
    })
  })
}

/** A copy of the bundle, changed by `change(resourcesDir)`, for launching. */
function variant(app, name, change) {
  const copy = join(work, 'variants', name, 'siteadapter-dev.app')
  mkdirSync(dirname(copy), { recursive: true })
  execFileSync('/usr/bin/ditto', [app, copy])
  change(join(copy, 'Contents', 'Resources'))
  return copy
}

writePlaceholder()
build()
const app = join(project, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'siteadapter-dev.app')
const info = plist(join(app, 'Contents', 'Info.plist'))
const resources = join(app, 'Contents', 'Resources')

const injected = join(work, 'inject.js')
const injectedMarker = join(work, 'injected-ran')
writeFileSync(injected, `require('node:fs').writeFileSync(${JSON.stringify(injectedMarker)}, 'x')\n`)
const runAsNodeMarker = join(work, 'run-as-node-ran')

// One byte of the main process's code changed inside the asar. Electron checks each file's block
// hashes as it reads them, so the change must be in a file the app loads at start.
const tamperedAsar = variant(app, 'tampered-asar', (dir) => {
  const asar = readFileSync(join(dir, 'app.asar'))
  const at = asar.indexOf(Buffer.from('use-mock-keychain'))
  if (at === -1) throw new Error('main process code not found in app.asar')
  asar.write('U', at)
  writeFileSync(join(dir, 'app.asar'), asar)
})
const folderBesideAsar = variant(app, 'app-folder', (dir) => {
  renameSync(join(dir, 'app.asar'), join(dir, 'moved.asar'))
  mkdirSync(join(dir, 'app'))
  writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ name: 'evil', main: 'main.js' }))
  writeFileSync(
    join(dir, 'app', 'main.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(injectedMarker)}, 'x')\n`,
  )
})

const launches = {
  plain: await launch(app, 'plain'),
  runAsNode: await launch(app, 'run-as-node', {
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(runAsNodeMarker)}, 'x')`],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }),
  nodeOptions: await launch(app, 'node-options', { env: { NODE_OPTIONS: `--require ${injected}` } }),
  inspect: await launch(app, 'inspect', { args: ['--inspect=0'] }),
  tamperedAsar: await launch(tamperedAsar, 'tampered-asar'),
  appFolderBesideAsar: await launch(folderBesideAsar, 'app-folder'),
}

let feed = null
if (target === 'zip') {
  const dist = join(project, 'dist')
  const zipName = `siteadapter-dev-${VERSION}-${arch}.zip`
  const fromBuilder = readFileSync(join(dist, 'latest-mac.yml'), 'utf8')
  const zip = await hashZip(join(dist, zipName))
  const releaseDate = /releaseDate: '([^']+)'/.exec(fromBuilder)?.[1]
  const fromScript = buildFeedYaml({ version: VERSION, files: [zip], releaseDate })
  const fields = (yaml) =>
    Object.fromEntries(
      [...yaml.matchAll(/^\s*-?\s*(url|sha512|size|path|version|releaseDate): '?([^'\n]+)'?$/gm)].map((m) => [
        `${m[1]}`,
        m[2],
      ]),
    )
  feed = {
    electronBuilderYml: fromBuilder,
    sameFieldsAsMakeFeed: JSON.stringify(fields(fromBuilder)) === JSON.stringify(fields(fromScript)),
    channelFiles: ['latest-mac.yml', 'beta-mac.yml', 'alpha-mac.yml'].filter((f) =>
      existsSync(join(dist, f)),
    ),
  }
}

const summary = {
  electronBuilder: execFileSync(BUILDER, ['--version'], { encoding: 'utf8' }).trim(),
  app: app.replace(work, '<tmp>'),
  infoPlist: {
    CFBundleIdentifier: info.CFBundleIdentifier,
    CFBundleName: info.CFBundleName,
    CFBundleExecutable: info.CFBundleExecutable,
    LSUIElement: info.LSUIElement,
    ElectronAsarIntegrity: Object.keys(info.ElectronAsarIntegrity ?? {}),
  },
  fuses: fuses(app),
  resources: {
    appAsar: existsSync(join(resources, 'app.asar')),
    appFolder: existsSync(join(resources, 'app')),
    asarFiles: asarFiles(join(resources, 'app.asar')),
    appUpdateYml: existsSync(join(resources, 'app-update.yml'))
      ? readFileSync(join(resources, 'app-update.yml'), 'utf8')
      : null,
  },
  // codesign -dv only reads the signature; it writes to stderr.
  signature: sh('/usr/bin/codesign -dv "$1" 2>&1 || true', app)
    .split('\n')
    .filter((l) => /^(Identifier|Format|CodeDirectory|Signature|TeamIdentifier|Runtime)/.test(l)),
  signedEntitlements:
    sh('/usr/bin/codesign -d --entitlements - --xml "$1" 2>/dev/null || true', app).trim() || null,
  launches,
  runAsNodeScriptRan: existsSync(runAsNodeMarker),
  injectedScriptRan: existsSync(injectedMarker),
  feed,
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

if (values.keep) process.stdout.write(`kept: ${work}\n`)
else rmSync(work, { recursive: true, force: true })
