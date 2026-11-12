// @vitest-environment node
// scripts/release-lib.ts: what the release command decides before and around the commands it runs.
// The commands themselves run in CI's release dry run (.github/workflows/ci.yml, release-dry-run).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RELEASE_REQUIREMENT_TEMPLATE, renderRequirement } from '../../electron-builder.config'
import {
  checkStart,
  DRY_RUN_FEED_URL,
  dryRunRefusedEnv,
  FULL_SUITE_HINT,
  fullSuiteVerdict,
  normaliseRequirement,
  REAL_RELEASE_ENV,
  refusalLaunches,
  type StartState,
  samePlist,
  uploadOrder,
} from '../../scripts/release-lib'
import { validateFeedUrl } from '../../src/main/updater/feed-url'

const APP_DIR = resolve(import.meta.dirname, '../..')

const REAL_ENV = {
  VALET_TEAM_ID: 'ABCDE12345',
  VALET_UPDATE_URL: 'https://updates.example.com/mac/',
  CSC_NAME: 'Example Person (ABCDE12345)',
  APPLE_KEYCHAIN_PROFILE: 'valet-notary',
  VALET_FEED_KEY_REF: 'op://Valet release/feed key/private key',
}

const DRY: StartState = {
  dryRun: true,
  version: '0.1.0',
  packageVersion: '0.1.0',
  platform: 'darwin',
  branch: 'main',
  dirty: false,
  tagExists: false,
  env: { PATH: '/usr/bin', HOME: '/Users/someone' },
  skipCheck: false,
  allowDirty: false,
  noPublish: false,
}

const REAL: StartState = {
  ...DRY,
  dryRun: false,
  env: REAL_ENV,
  noPublish: true,
  fullSuite: { passed: true, reason: '' },
}

describe('fullSuiteVerdict', () => {
  const SHA = 'abc123'
  const run = (event: string, conclusion: string | null, status = 'completed', head_sha = SHA) => ({
    head_sha,
    event,
    status,
    conclusion,
  })

  it('passes only on a successful nightly or by-hand run of that very commit', () => {
    expect(fullSuiteVerdict(SHA, [run('schedule', 'success')]).passed).toBe(true)
    expect(
      fullSuiteVerdict(SHA, [run('workflow_dispatch', 'failure'), run('workflow_dispatch', 'success')])
        .passed,
    ).toBe(true)
    expect(fullSuiteVerdict(SHA, [run('pull_request', 'success'), run('push', 'success')])).toEqual({
      passed: false,
      reason: 'the full suite has not run on abc123',
    })
    expect(fullSuiteVerdict(SHA, [run('schedule', 'success', 'completed', 'other')]).passed).toBe(false)
  })

  it('says whether the full suite failed, is still running, or GitHub gave nothing', () => {
    expect(fullSuiteVerdict(SHA, [run('schedule', 'failure')]).reason).toBe('the full suite failed on abc123')
    expect(fullSuiteVerdict(SHA, [run('workflow_dispatch', null, 'in_progress')]).reason).toBe(
      'the full suite is still running on abc123',
    )
    expect(fullSuiteVerdict(SHA, undefined)).toEqual({
      passed: false,
      reason: 'GitHub gave no CI runs for abc123',
    })
  })
})

describe('checkStart', () => {
  it('lets a dry run start anywhere a clean macOS checkout is, noting what a release would refuse', () => {
    expect(checkStart(DRY)).toEqual({ refusals: [], notes: [] })
    const onBranch = checkStart({ ...DRY, branch: 'HEAD', tagExists: true, skipCheck: true })
    expect(onBranch.refusals).toEqual([])
    expect(onBranch.notes).toEqual([
      'not on main (on HEAD)',
      'the tag v0.1.0 exists already',
      'pnpm check skipped (--skip-check)',
    ])
  })

  it('refuses a dry run with any real identity, notary profile, feed key or feed in reach', () => {
    for (const name of [
      'CSC_NAME',
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_KEYCHAIN_PROFILE',
      'APPLE_API_KEY',
      'APPLE_ID',
      'VALET_TEAM_ID',
      'VALET_FEED_KEY_REF',
      'VALET_UPDATE_URL',
    ]) {
      const verdict = checkStart({ ...DRY, env: { ...DRY.env, [name]: 'x' } })
      expect(verdict.refusals, name).toHaveLength(1)
      expect(verdict.refusals[0]).toContain(name)
    }
    // An empty variable is not a value.
    expect(dryRunRefusedEnv({ CSC_NAME: '', PATH: '/usr/bin' })).toEqual([])
  })

  it('refuses a dirty tree, unless a dry run is told to allow it', () => {
    expect(checkStart({ ...DRY, dirty: true }).refusals).toEqual(['the working tree is not clean'])
    expect(checkStart({ ...DRY, dirty: true, allowDirty: true }).refusals).toEqual([])
    expect(checkStart({ ...REAL, dirty: true, allowDirty: true }).refusals).toEqual([
      'the working tree is not clean',
      '--allow-dirty is for dry runs only',
    ])
  })

  it('builds only the version in package.json, and only on macOS', () => {
    expect(checkStart({ ...DRY, version: '0.2.0' }).refusals[0]).toMatch(/package\.json's \(0\.1\.0\)/)
    expect(checkStart({ ...DRY, platform: 'linux' }).refusals).toEqual(['a release is built on macOS'])
  })

  it('starts a real release on main, with a new tag, every variable, and --no-publish', () => {
    expect(checkStart(REAL)).toEqual({ refusals: [], notes: [] })
    expect(checkStart({ ...REAL, branch: 'feature' }).refusals).toEqual(['not on main (on feature)'])
    expect(checkStart({ ...REAL, tagExists: true }).refusals).toEqual(['the tag v0.1.0 exists already'])
    expect(checkStart({ ...REAL, skipCheck: true }).refusals[0]).toMatch(/runs pnpm check/)
    // The pre-release gate: a real release waits for the full suite on its commit; a dry run doesn't.
    const notRun = checkStart({
      ...REAL,
      fullSuite: { passed: false, reason: 'the full suite has not run on abc' },
    })
    expect(notRun.refusals).toEqual([`the full suite has not run on abc: ${FULL_SUITE_HINT}`])
    expect(checkStart({ ...REAL, fullSuite: undefined }).refusals[0]).toMatch(
      /^the full suite was not checked/,
    )
    expect(checkStart({ ...DRY, fullSuite: { passed: false, reason: 'x' } }).refusals).toEqual([])
    for (const name of REAL_RELEASE_ENV) {
      const verdict = checkStart({ ...REAL, env: { ...REAL_ENV, [name]: '' } })
      expect(verdict.refusals, name).toEqual([`a release needs ${name}`])
    }
  })

  it('refuses to publish a real release until the feed host (D23) is decided', () => {
    const verdict = checkStart({ ...REAL, noPublish: false })
    expect(verdict.refusals).toHaveLength(1)
    expect(verdict.refusals[0]).toMatch(/D23/)
  })
})

describe('the dry run feed', () => {
  it('is a public-shaped release feed, as the release config demands, on a host nobody publishes to', () => {
    expect(validateFeedUrl(DRY_RUN_FEED_URL, { requirePublicHost: true })).toBe(DRY_RUN_FEED_URL)
    expect(new URL(DRY_RUN_FEED_URL).hostname.endsWith('.example.com')).toBe(true)
  })
})

describe('normaliseRequirement', () => {
  it('compares codesign’s printed requirement with the rendered template', () => {
    const template = readFileSync(resolve(APP_DIR, 'build', RELEASE_REQUIREMENT_TEMPLATE), 'utf8')
    const rendered = renderRequirement(template, { appId: 'me.dncr.valet', teamId: 'ABCDE12345' })
    const printed =
      'designated => identifier "me.dncr.valet" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */\n' +
      '   and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ABCDE12345\n'
    expect(normaliseRequirement(rendered)).toMatch(/^identifier me\.dncr\.valet and anchor apple generic/)
    expect(normaliseRequirement(printed)).toBe(normaliseRequirement(rendered))
    expect(normaliseRequirement(printed.replace('ABCDE12345', 'ZZZZZ99999'))).not.toBe(
      normaliseRequirement(rendered),
    )
  })
})

describe('samePlist', () => {
  it('compares parsed values, whatever their key order', () => {
    expect(samePlist({ a: true, b: { c: 1, d: [1, 2] } }, { b: { d: [1, 2], c: 1 }, a: true })).toBe(true)
    expect(samePlist({ a: true }, { a: true, b: false })).toBe(false)
    expect(samePlist({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(samePlist(null, {})).toBe(false)
  })
})

describe('uploadOrder', () => {
  const files = [
    'latest-mac.envelope.json.sig',
    'beta-mac.yml',
    'valet-1.2.0-arm64.dmg',
    'latest-mac.yml',
    'valet-1.2.0-arm64.zip',
    'beta-mac.envelope.json',
    'valet-1.2.0-arm64.zip.blockmap',
    'latest-mac.envelope.json',
    'beta-mac.envelope.json.sig',
  ]

  it('puts the versioned files first, then the channel files, then the envelopes, last', () => {
    expect(uploadOrder(files, '1.2.0')).toEqual([
      { file: 'valet-1.2.0-arm64.dmg', cacheControl: 'public, max-age=31536000, immutable' },
      { file: 'valet-1.2.0-arm64.zip', cacheControl: 'public, max-age=31536000, immutable' },
      { file: 'valet-1.2.0-arm64.zip.blockmap', cacheControl: 'public, max-age=31536000, immutable' },
      { file: 'beta-mac.yml', cacheControl: 'no-cache' },
      { file: 'latest-mac.yml', cacheControl: 'no-cache' },
      { file: 'beta-mac.envelope.json', cacheControl: 'no-cache' },
      { file: 'beta-mac.envelope.json.sig', cacheControl: 'no-cache' },
      { file: 'latest-mac.envelope.json', cacheControl: 'no-cache' },
      { file: 'latest-mac.envelope.json.sig', cacheControl: 'no-cache' },
    ])
  })

  it('refuses a stray file, a file of another version, or a channel file without its envelope', () => {
    expect(() => uploadOrder([...files, 'notes.txt'], '1.2.0')).toThrow(/notes\.txt/)
    expect(() => uploadOrder([...files, 'valet-1.1.0-arm64.zip'], '1.2.0')).toThrow(/valet-1\.1\.0/)
    expect(() =>
      uploadOrder(
        files.filter((f) => f !== 'beta-mac.envelope.json.sig'),
        '1.2.0',
      ),
    ).toThrow(/envelope/)
  })
})

describe('refusalLaunches', () => {
  it('covers every switch in the doc’s table, and a relative bridge path', () => {
    const doc = readFileSync(resolve(APP_DIR, '../../docs/release-and-updates.md'), 'utf8')
    const table = doc.slice(
      doc.indexOf('## Command-line switches'),
      doc.indexOf('So nothing in the trusted path'),
    )
    const switches = [...table.matchAll(/`(--[a-z-]+)\*?`/g)].map((m) => m[1] as string)
    expect(switches.length).toBeGreaterThan(5)
    const launched = refusalLaunches(9222, '/tmp/x').flatMap((l) => l.args)
    for (const name of switches) {
      if (name === '--proxy-') continue // "--proxy-*": both spellings below
      expect(
        launched.some((arg) => arg === name || arg.startsWith(`${name}=`) || arg.startsWith(name)),
        name,
      ).toBe(true)
    }
    expect(launched).toContain('--proxy-server=127.0.0.1:9')
    expect(launched).toContain('--proxy-pac-url=http://127.0.0.1:9/proxy.pac')
    expect(refusalLaunches(9222, '/tmp/x').some((l) => l.args.join(' ') === '--mcp-bridge bridge.json')).toBe(
      true,
    )
  })
})
