#!/usr/bin/env node
// `pnpm release <version>`: the one release command (M3, AC18). It builds, signs, verifies,
// notarises, staples, writes and signs the feed, and stages the upload, stopping at the first
// failure. docs/release-and-updates.md, "The release script", is the design; scripts/release-lib.ts
// holds the decisions, and test/updater/release.test.ts holds them in place.
//
//   pnpm release <version> --dry-run [--skip-check] [--allow-dirty] [--arch both|arm64|x64]
//   pnpm release <version> --no-publish            # on Nick's Mac, with the release variables
//
// A dry run is the same command with three effects swapped, so CI runs every other step for real:
//
// - signing is ad hoc ("-", no key, no keychain), through electron-builder.config.ts's
//   VALET_RELEASE_DRY_RUN, for the app and the DMG alike;
// - the feed key is a throwaway Ed25519 key made for this run in a temporary folder, and deleted
//   with it; the feed URL is a placeholder on example.com;
// - notarisation, stapling, the Gatekeeper assessment, the upload and the tag are stubs that print
//   the command they stand for and run nothing.
//
// A dry run refuses to start with any CSC_*, APPLE_*, VALET_TEAM_ID, VALET_FEED_KEY_REF or
// VALET_UPDATE_URL in its environment, so no real identity, notary profile or feed key is in reach,
// and it never touches the network beyond electron-builder fetching Electron for the other
// architecture.
//
// A real release needs VALET_TEAM_ID, VALET_UPDATE_URL, CSC_NAME, APPLE_KEYCHAIN_PROFILE and
// VALET_FEED_KEY_REF (an op:// reference to the feed's private key, D61), and --no-publish until the
// feed host (D23) is decided: it then stops with the feed staged in <out>/publish, unuploaded and
// untagged. It has not been run yet: the first one is Nick's, with his signing identity.

import { execFileSync, spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadFeedPublicKey, verifyFeed } from '../src/main/updater/feed-envelope.ts'
import { buildFeedYaml, hashZip, makeFeed } from './make-feed.mjs'
import {
  APP_DIR,
  appPath,
  asarFiles,
  BUILDER,
  CONFIG,
  cleanEnv,
  EXPECTED_FUSES,
  electronVersion,
  plist,
  readFuses,
} from './packaging.mjs'
import {
  checkStart,
  DRY_RUN_FEED_URL,
  normaliseRequirement,
  refusalLaunches,
  samePlist,
  uploadOrder,
} from './release-lib.ts'
import { ASAR_ALLOWED, launchRefused, makeHome } from './smoke/real-app.mjs'

const ROOT = resolve(APP_DIR, '..', '..')
const PRODUCT = 'Valet'
const APP_ID = 'me.dncr.valet'
/** electron-builder.config.ts's NATIVE_EXECUTABLES: shipped in Contents/MacOS. */
const NATIVE = ['valet-bridge', 'valet-keychain', 'valet-messages-helper', 'valet-approver']
/** docs/release-and-updates.md: each refused launch exits within two seconds. */
const REFUSE_WITHIN_MS = 2000

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    'skip-check': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    'no-publish': { type: 'boolean', default: false },
    'minimum-version': { type: 'string', default: '0.0.0' },
    arch: { type: 'string', default: 'both' },
    out: { type: 'string' },
  },
})
const dryRun = values['dry-run']
const version = positionals[0]
if (version === undefined || positionals.length !== 1) {
  fail(
    'usage: pnpm release <version> (--dry-run | --no-publish) [--skip-check] [--allow-dirty] [--arch both|arm64|x64]',
  )
}
const arches = { both: ['arm64', 'x64'], arm64: ['arm64'], x64: ['x64'] }[values.arch]
if (arches === undefined) fail('--arch is both, arm64 or x64')
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const out = resolve(values.out ?? join(APP_DIR, 'dist', `release-${version}${dryRun ? '-dry-run' : ''}`))
const buildDir = join(out, 'build')
const publishDir = join(out, 'publish')
const mode = dryRun ? 'dry run' : 'release'
/** What each step found, written to <out>/release-summary.json at the end. */
const summary = {
  mode,
  version,
  arches,
  startedAt: new Date().toISOString(),
  notes: [],
  stubs: [],
  steps: [],
}

function say(text) {
  process.stdout.write(`release: ${text}\n`)
}

function fail(text) {
  process.stderr.write(`release: ${text}\n`)
  process.exit(1)
}

/** Runs a command, its output passed through; throws on a non-zero exit. */
function run(command, args, options = {}) {
  say(`$ ${[command, ...args].join(' ')}`)
  execFileSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options })
}

/** Runs a command and returns its stdout and stderr, whatever its exit. */
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** What a dry run stands in for: printed, recorded, never run. */
function stub(what, command) {
  say(`dry run: would ${what}: ${command}`)
  summary.stubs.push({ what, command })
}

let stepNumber = 0
/** One step: its checks are collected, and any failure stops the release after the step. */
async function step(name, body) {
  stepNumber += 1
  say(`[${stepNumber}] ${name}`)
  const failures = []
  const expect = (check, ok, detail) => {
    if (ok) return
    failures.push(
      detail === undefined
        ? check
        : `${check}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    )
  }
  const result = await body(expect)
  summary.steps.push({ name, failures })
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`release: FAILED ${failure}\n`)
    writeSummary('failed')
    fail(`stopped at [${stepNumber}] ${name}: ${failures.length} check(s) failed`)
  }
  return result
}

function writeSummary(outcome) {
  if (!existsSync(out)) return
  writeFileSync(
    join(out, 'release-summary.json'),
    `${JSON.stringify({ ...summary, outcome, finishedAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

function git(...args) {
  return capture('git', args, { cwd: ROOT })
}

// ---------------------------------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'valet-release-'))
try {
  await release()
} finally {
  rmSync(work, { recursive: true, force: true })
}

async function release() {
  const packageVersion = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version
  const verdict = checkStart({
    dryRun,
    version,
    packageVersion,
    platform: process.platform,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(),
    dirty: git('status', '--porcelain').stdout.trim() !== '',
    tagExists: git('rev-parse', '-q', '--verify', `refs/tags/v${version}`).code === 0,
    env: process.env,
    skipCheck: values['skip-check'],
    allowDirty: values['allow-dirty'],
    noPublish: values['no-publish'],
  })
  for (const note of verdict.notes) say(`note (${mode}): ${note}`)
  summary.notes.push(...verdict.notes)
  if (verdict.refusals.length > 0) {
    for (const refusal of verdict.refusals) process.stderr.write(`release: refused: ${refusal}\n`)
    process.exit(1)
  }
  if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} exists: remove it first`)
  mkdirSync(publishDir, { recursive: true })
  say(`${mode} of ${version} for ${arches.join(' and ')}, into ${out}`)

  if (!values['skip-check']) await step('pnpm check', () => run('pnpm', ['check'], { cwd: ROOT }))

  const feedUrl = dryRun ? DRY_RUN_FEED_URL : process.env.VALET_UPDATE_URL
  const feedKey = await step('feed key', (expect) => {
    let privateKey
    if (dryRun) {
      // Throwaway: made here, kept in the temporary folder, deleted when the run ends.
      privateKey = generateKeyPairSync('ed25519').privateKey
      say('dry run: a throwaway Ed25519 feed key, made for this run only')
    } else {
      say(`reading the feed key from 1Password (${process.env.VALET_FEED_KEY_REF}); approve with Touch ID`)
      const pem = execFileSync('op', ['read', process.env.VALET_FEED_KEY_REF], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      privateKey = createPrivateKey(pem)
    }
    expect(
      'the feed key is Ed25519',
      privateKey.asymmetricKeyType === 'ed25519',
      privateKey.asymmetricKeyType,
    )
    const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
    const publicFile = join(work, 'feed-public.pem')
    writeFileSync(publicFile, publicPem, { mode: 0o600 })
    return { privateKey, publicPem, publicFile }
  })

  await step('Swift bridge and helpers, universal, signed first', () => {
    run(
      'swift',
      ['build', '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64', '--package-path', 'swift-bridge'],
      { cwd: ROOT },
    )
    // The universal build leaves them unsigned, and @electron/osx-sign signs Contents/MacOS/Valet
    // before its siblings there (same depth, and "V" sorts first), which codesign refuses while a
    // sibling is unsigned. So each is signed here first, with the app's identity and options;
    // electron-builder signs them again (mac.binaries) before sealing the bundle.
    const identity = dryRun ? '-' : signingIdentity()
    for (const name of NATIVE) {
      run('/usr/bin/codesign', [
        '--sign',
        identity,
        '--force',
        '--options',
        'runtime',
        ...(dryRun ? [] : ['--timestamp']),
        '--entitlements',
        join(APP_DIR, 'build', 'entitlements.mac.inherit.plist'),
        join(ROOT, 'swift-bridge', '.build', 'apple', 'Products', 'Release', name),
      ])
    }
  })

  await step('electron-vite build, with the release feed compiled in', () =>
    run(join(APP_DIR, 'node_modules', '.bin', 'electron-vite'), ['build'], {
      cwd: APP_DIR,
      env: cleanEnv({
        VALET_RELEASE: '1',
        VALET_UPDATE_URL: feedUrl,
        VALET_FEED_PUBLIC_KEY_FILE: feedKey.publicFile,
      }),
    }),
  )

  await step(`electron-builder: DMG and zip, ${dryRun ? 'signed ad hoc' : 'signed and notarised'}`, () => {
    const env = dryRun
      ? cleanEnv({
          VALET_RELEASE: '1',
          VALET_RELEASE_DRY_RUN: '1',
          VALET_UPDATE_URL: feedUrl,
          // electron-builder skips signing in a pull request's CI unless told otherwise. A dry run
          // has nothing to protect: no identity, no secret.
          CSC_FOR_PULL_REQUEST: 'true',
        })
      : cleanEnv({ VALET_RELEASE: '1' }, [
          'VALET_TEAM_ID',
          'VALET_UPDATE_URL',
          'CSC_NAME',
          'APPLE_KEYCHAIN_PROFILE',
        ])
    // A release signs: the config refuses CSC_IDENTITY_AUTO_DISCOVERY=false for one.
    if (!dryRun) delete env.CSC_IDENTITY_AUTO_DISCOVERY
    run(
      BUILDER,
      [
        '--mac',
        'dmg',
        'zip',
        ...arches.map((arch) => `--${arch}`),
        '--projectDir',
        APP_DIR,
        '--config',
        CONFIG,
        `-c.electronVersion=${electronVersion()}`,
        `-c.directories.output=${buildDir}`,
        '--publish',
        'never',
      ],
      { cwd: APP_DIR, env },
    )
  })

  for (const arch of arches) {
    const app = appPath(buildDir, arch, PRODUCT)
    await step(`verify ${basename(app)} (${arch})`, async (expect) => verifyApp(app, arch, feedUrl, expect))
  }

  const dmgs = arches.map((arch) => join(buildDir, `valet-${version}-${arch}.dmg`))
  for (const dmg of dmgs) {
    await step(`sign, notarise and staple ${basename(dmg)}`, (expect) => finishDmg(dmg, expect))
  }

  await step('feed: channel files and signed envelopes', async (expect) => {
    const zips = arches.map((arch) => join(buildDir, `valet-${version}-${arch}.zip`))
    for (const file of readdirSync(buildDir)) {
      if (file.includes(`-${version}-`) && /\.(zip|zip\.blockmap|dmg)$/.test(file)) {
        copyFileSync(join(buildDir, file), join(publishDir, file))
      }
    }
    const written = await makeFeed({
      version,
      zips,
      outDir: publishDir,
      signingKey: feedKey.privateKey,
      minimumVersion: values['minimum-version'],
    })
    for (const path of written) say(`wrote ${basename(path)}`)
    verifyStagedFeed(feedKey.publicPem, expect)
    // electron-builder writes its own latest-mac.yml during the build; it must say the same as ours.
    const fromBuilder = readFileSync(join(buildDir, 'latest-mac.yml'), 'utf8')
    const releaseDate = /releaseDate: '([^']+)'/.exec(fromBuilder)?.[1]
    const files = []
    for (const zip of zips) files.push(await hashZip(zip))
    const ours = buildFeedYaml({ version, files, releaseDate })
    expect('electron-builder’s zips match make-feed’s', sameZips(fromBuilder, ours), {
      fromBuilder,
      ours,
    })
  })

  await step(dryRun ? 'upload (dry run)' : 'upload (staged only, --no-publish)', () => {
    const order = uploadOrder(readdirSync(publishDir), version)
    summary.upload = order
    for (const [i, upload] of order.entries()) {
      say(`  ${i + 1}. ${upload.file}  (Cache-Control: ${upload.cacheControl})`)
    }
    if (dryRun) {
      stub('upload, in this order, to the feed host (D23)', `${order.length} files to ${feedUrl}`)
    } else {
      say(`staged in ${publishDir}; not uploaded: the feed host (D23) is not decided yet`)
    }
  })

  await step('tag', () => {
    if (dryRun) stub('tag the release commit', `git tag v${version} && git push origin v${version}`)
    else say(`not tagged: a release is tagged once it is uploaded (v${version})`)
  })

  writeSummary('passed')
  say(`${mode} of ${version} passed: ${out}`)
}

// ---------------------------------------------------------------------------------------------------

async function verifyApp(app, arch, feedUrl, expect) {
  const info = plist(join(app, 'Contents', 'Info.plist'))
  expect('CFBundleIdentifier', info.CFBundleIdentifier === APP_ID, info.CFBundleIdentifier)
  expect(
    'CFBundleShortVersionString',
    info.CFBundleShortVersionString === version,
    info.CFBundleShortVersionString,
  )
  expect('LSUIElement', info.LSUIElement === true)
  expect(
    'ElectronAsarIntegrity',
    JSON.stringify(Object.keys(info.ElectronAsarIntegrity ?? {})) === '["Resources/app.asar"]',
  )

  const verify = capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  expect('codesign --verify --deep --strict', verify.code === 0, verify.stderr)

  // codesign -dv writes to stderr.
  const details = capture('/usr/bin/codesign', ['-dv', '--verbose=4', app]).stderr
  expect('hardened runtime', /flags=0x[0-9a-f]*\([^)]*runtime[^)]*\)/.test(details), details)
  if (dryRun) {
    expect('signed ad hoc', details.includes('Signature=adhoc'), details)
  } else {
    expect('signed with Developer ID', details.includes('Authority=Developer ID Application:'), details)
    expect('signed by the team', details.includes(`TeamIdentifier=${process.env.VALET_TEAM_ID}`), details)
  }

  if (dryRun) {
    say('dry run: designated requirement not compared: an ad hoc signature’s requirement is its own cdhash')
    summary.stubs.push({ what: 'compare the designated requirement', command: 'codesign -d -r- <app>' })
  } else {
    const { renderRequirement, RELEASE_REQUIREMENT_TEMPLATE } = await import('../electron-builder.config.ts')
    const template = readFileSync(join(APP_DIR, 'build', RELEASE_REQUIREMENT_TEMPLATE), 'utf8')
    const expected = normaliseRequirement(
      renderRequirement(template, { appId: APP_ID, teamId: process.env.VALET_TEAM_ID }),
    )
    const actual = normaliseRequirement(capture('/usr/bin/codesign', ['-d', '-r-', app]).stdout)
    expect('designated requirement', actual === expected, { actual, expected })
  }

  const signedEntitlements = join(work, `entitlements-${arch}.plist`)
  const entitlements = capture('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app])
  writeFileSync(signedEntitlements, entitlements.stdout)
  const signed = entitlements.stdout.trim() === '' ? null : plist(signedEntitlements)
  const source = plist(join(APP_DIR, 'build', 'entitlements.mac.plist'))
  expect('signed entitlements are build/entitlements.mac.plist', samePlist(signed, source), {
    signed,
    source,
  })

  const fuses = { ...readFuses(app), version: undefined, fuse8: undefined }
  expect('fuses', samePlist(fuses, { ...EXPECTED_FUSES }), fuses)

  const resources = join(app, 'Contents', 'Resources')
  const updateYml = readFileSync(join(resources, 'app-update.yml'), 'utf8')
  expect('app-update.yml names the compiled-in feed', updateYml.includes(`url: ${feedUrl}`), updateYml)
  expect('no Resources/app folder', !existsSync(join(resources, 'app')))
  expect('no default_app.asar', !existsSync(join(resources, 'default_app.asar')))
  const unexpected = asarFiles(join(resources, 'app.asar')).filter(
    (f) => !ASAR_ALLOWED.some((p) => p.test(f)),
  )
  expect('the asar holds only the build and the SDK', unexpected.length === 0, unexpected)
  for (const name of NATIVE) {
    expect(`${name} ships in Contents/MacOS`, existsSync(join(app, 'Contents', 'MacOS', name)))
  }
  expect(
    'the Messages helper’s launch agent ships',
    existsSync(join(app, 'Contents', 'Library', 'LaunchAgents', 'messages-helper.plist')),
  )

  if (dryRun) {
    stub('validate the stapled ticket', `xcrun stapler validate "${app}"`)
    stub(
      'assess with Gatekeeper (expect "source=Notarized Developer ID")',
      `spctl --assess -vvv --type exec "${app}"`,
    )
  } else {
    const staple = capture('/usr/bin/xcrun', ['stapler', 'validate', app])
    expect('stapler validate', staple.code === 0, staple.stdout + staple.stderr)
    const gatekeeper = capture('/usr/sbin/spctl', ['--assess', '-vvv', '--type', 'exec', app])
    expect(
      'Gatekeeper: Notarized Developer ID',
      gatekeeper.stderr.includes('source=Notarized Developer ID'),
      gatekeeper.stderr,
    )
  }

  if (arch !== hostArch) {
    say(`launch checks skipped for ${arch}: this Mac runs ${hostArch}`)
    return
  }
  await checkRefusals(app, expect)
}

/** The release check from "Command-line switches": every unexpected switch is refused at once. */
async function checkRefusals(app, expect) {
  const port = 9000 + Math.floor(Math.random() * 1000)
  // The first launch of a new binary waits on the system's own checks; it isn't timed.
  await launchRefused(app, makeHome(work, 'warm-up'), ['--warm-up'], {}, { userDataName: PRODUCT })
  const results = {}
  for (const [i, launch] of refusalLaunches(port, work).entries()) {
    const home = makeHome(work, `refusal-${i}`)
    const result = await launchRefused(app, home, launch.args, {}, { userDataName: PRODUCT })
    const userData = join(home, 'Library', 'Application Support', PRODUCT)
    const written = existsSync(userData) ? readdirSync(userData) : []
    results[launch.name] = { code: result.exit.code, ms: result.ms, written }
    expect(
      `refuses ${launch.name}: exit 64 with the fixed message`,
      result.exit.code === 64 && result.refusedMessage,
      result,
    )
    expect(`refuses ${launch.name} within ${REFUSE_WITHIN_MS} ms`, result.ms <= REFUSE_WITHIN_MS, result.ms)
    expect(`refusing ${launch.name} wrote nothing under userData`, written.length === 0, written)
  }
  expect(`nothing answers on the debugging port ${port}`, !(await listening(port)))
  summary.refusals = results
}

function listening(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      done(true)
    })
    socket.once('error', () => done(false))
  })
}

function finishDmg(dmg, expect) {
  if (dryRun) {
    run('/usr/bin/codesign', ['--sign', '-', '--force', dmg])
  } else {
    run('/usr/bin/codesign', ['--sign', signingIdentity(), '--timestamp', dmg])
  }
  const verify = capture('/usr/bin/codesign', ['--verify', '--verbose=2', dmg])
  expect('codesign --verify the DMG', verify.code === 0, verify.stderr)
  const details = capture('/usr/bin/codesign', ['-dv', dmg]).stderr
  if (dryRun) expect('the DMG is signed ad hoc', details.includes('Signature=adhoc'), details)

  // What the DMG holds: the app, intact.
  const mount = join(work, `mount-${basename(dmg, '.dmg')}`)
  mkdirSync(mount)
  run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, dmg])
  try {
    const inside = join(mount, `${PRODUCT}.app`)
    expect('the DMG holds Valet.app', existsSync(inside), readdirSync(mount))
    const deep = capture('/usr/bin/codesign', ['--verify', '--deep', '--strict', inside])
    expect('Valet.app in the DMG verifies', deep.code === 0, deep.stderr)
  } finally {
    run('/usr/bin/hdiutil', ['detach', mount, '-force'])
  }

  if (dryRun) {
    stub('notarise the DMG', `xcrun notarytool submit "${dmg}" --keychain-profile valet-notary --wait`)
    stub('staple the DMG', `xcrun stapler staple "${dmg}"`)
    stub(
      'assess the DMG with Gatekeeper',
      `spctl --assess -vvv --type open --context context:primary-signature "${dmg}"`,
    )
  } else {
    run('/usr/bin/xcrun', [
      'notarytool',
      'submit',
      dmg,
      '--keychain-profile',
      process.env.APPLE_KEYCHAIN_PROFILE,
      '--wait',
    ])
    run('/usr/bin/xcrun', ['stapler', 'staple', dmg])
    const gatekeeper = capture('/usr/sbin/spctl', [
      '--assess',
      '-vvv',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      dmg,
    ])
    expect('Gatekeeper accepts the DMG', gatekeeper.code === 0, gatekeeper.stderr)
  }
}

/**
 * Verifies each staged channel file with the app's own verifier and the public key the build
 * compiled in, then checks a changed byte is refused, so the check is known to bite.
 */
function verifyStagedFeed(publicPem, expect) {
  const publicKey = loadFeedPublicKey(publicPem)
  const readYmlVersion = (yml) => /^version: '([^']+)'$/m.exec(yml)?.[1]
  const channels = readdirSync(publishDir)
    .map((file) => /^(latest|beta)-mac\.yml$/.exec(file)?.[1])
    .filter((channel) => channel !== undefined)
  expect(
    'a stable release writes both channels',
    !/-/.test(version) ? channels.length === 2 : channels.length === 1,
    channels,
  )
  summary.feed = {}
  for (const channel of channels) {
    const read = (suffix) => readFileSync(join(publishDir, `${channel}-mac${suffix}`), 'utf8')
    const input = {
      yml: read('.yml'),
      envelope: read('.envelope.json'),
      signature: read('.envelope.json.sig'),
    }
    const verdict = verifyFeed(input, { publicKey, channel, now: Date.now(), readYmlVersion })
    expect(`${channel}: the envelope verifies`, verdict.ok, verdict)
    const tampered = verifyFeed(
      { ...input, yml: input.yml.replace(/size: (\d)/, (_, d) => `size: ${(Number(d) + 1) % 10}`) },
      { publicKey, channel, now: Date.now(), readYmlVersion },
    )
    expect(
      `${channel}: a changed channel file is refused`,
      !tampered.ok && tampered.reason === 'yml-mismatch',
      tampered,
    )
    summary.feed[channel] = { verified: verdict.ok, envelope: input.envelope }
    say(`${channel}: envelope verified with the compiled-in public key`)
  }
}

/**
 * The zips two channel files list, as a set of name, SHA-512 and size. A dmg-and-zip build's own
 * latest-mac.yml also lists the DMGs, some entries more than once; it is never published (make-feed's
 * is), so only its zips are compared.
 */
function sameZips(a, b) {
  const zips = (yaml) =>
    [
      ...new Set(
        [
          ...yaml.matchAll(/-\s*url:\s*'?([^'\n]+\.zip)'?\n\s*sha512:\s*'?([^'\n]+)'?\n\s*size:\s*(\d+)/g),
        ].map((m) => `${m[1]} ${m[2]} ${m[3]}`),
      ),
    ]
      .sort()
      .join('\n')
  return zips(a) !== '' && zips(a) === zips(b)
}

/** The Developer ID identity codesign takes: CSC_NAME as a SHA-1, or its full certificate name. */
function signingIdentity() {
  const name = process.env.CSC_NAME
  return /^[0-9A-F]{40}$/.test(name) ? name : `Developer ID Application: ${name}`
}
