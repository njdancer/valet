// @vitest-environment node
// The packaging configuration, held in place: identity, signing, fuses, entitlements and the feed.
// Each refusal has a test that tries to get a weaker build out of the config.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ENTITLEMENTS,
  BRIDGE_EXECUTABLE,
  BuildConfigError,
  type BuildEnv,
  type ConfigDeps,
  checkReleaseBundle,
  createBuilderConfig,
  DEV_APP_ID,
  DEV_PRODUCT_NAME,
  ELECTRON_FUSES,
  ENTITLEMENTS_INHERIT_PATH,
  ENTITLEMENTS_PATH,
  FORBIDDEN_ENTITLEMENTS,
  nodeDeps,
  RELEASE_APP_ID,
  RELEASE_PRODUCT_NAME,
  readBundle,
  renderRequirement,
  SIGN_RETRIES,
  SIGN_RETRY_BACKOFF_MS,
  SIGN_RETRY_INTERVAL_MS,
  type SignOptionsLike,
  SWIFT_BRIDGE_BUILD,
  SWIFT_BUILD_DIR,
  signWithRequirement,
} from '../../electron-builder.config'
import { RELEASE_APP_ID as SCRIPT_RELEASE_APP_ID } from '../../scripts/make-feed.mjs'
import { SMOKE_BUILD_MARKER } from '../../src/main/core/smoke'

/** An Apple Development identity's SHA-1, as `security find-identity` prints it. */
const DEV_IDENTITY = '0123456789ABCDEF0123456789ABCDEF01234567'

const APP_DIR = resolve(import.meta.dirname, '../..')
const DOC = readFileSync(resolve(APP_DIR, '../../docs/release-and-updates.md'), 'utf8')

const RELEASE_ENV: BuildEnv = {
  VALET_RELEASE: '1',
  VALET_TEAM_ID: 'ABCDE12345',
  VALET_UPDATE_URL: 'https://updates.example.com/mac/',
  CSC_NAME: 'Example Person (ABCDE12345)',
  APPLE_KEYCHAIN_PROFILE: 'valet-notary',
}

/** A release's out/main, built with RELEASE_ENV's feed. */
const RELEASE_BUNDLE =
  'const FEED_BASE_URL = "https://updates.example.com/mac/";\n' +
  'const FEED_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\\nMCow…\\n-----END PUBLIC KEY-----\\n";'

const signCalls: SignOptionsLike[] = []
const DEPS: ConfigDeps = {
  readTemplate: nodeDeps.readTemplate,
  loadSignAsync: () => async (options) => {
    signCalls.push(options)
  },
  readMainBundle: () => RELEASE_BUNDLE,
  bridgeBuilt: () => true,
}

// The config's nested option types are electron-builder's unions; tests read them loosely.
const config = (env: BuildEnv): any => createBuilderConfig(env, DEPS)

const RELEASE_REQUIREMENT =
  '=designated => identifier "me.dncr.valet" and anchor apple generic and ' +
  'certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and ' +
  'certificate leaf[subject.OU] = "ABCDE12345"'

describe('a release build', () => {
  it('has the release identity, is signed with the hardened runtime and notarised', () => {
    const c = config(RELEASE_ENV)
    expect(c.appId).toBe(RELEASE_APP_ID)
    expect(c.appId).toBe('me.dncr.valet')
    expect(c.productName).toBe('Valet')
    expect(c.extraMetadata).toEqual({ name: 'valet', productName: RELEASE_PRODUCT_NAME })
    expect(c.forceCodeSigning).toBe(true)
    expect(c.mac.hardenedRuntime).toBe(true)
    expect(c.mac.notarize).toBe(true)
    expect(c.mac.type).toBe('distribution')
    expect('identity' in c.mac).toBe(false)
  })

  it('is a menu-bar app, built as dmg and zip for arm64 and x64', () => {
    const c = config(RELEASE_ENV)
    expect(c.mac.extendInfo).toEqual({ LSUIElement: true })
    expect(c.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ])
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own macros
    expect(c.mac.artifactName).toBe('valet-${version}-${arch}.${ext}')
    expect(c.dmg).toEqual({ sign: false })
  })

  it('flips every fuse as required, and does not re-sign ad hoc', () => {
    const c = config(RELEASE_ENV)
    expect(c.electronFuses).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableCookieEncryption: true,
      grantFileProtocolExtraPrivileges: false,
      loadBrowserProcessSpecificV8Snapshot: false,
      resetAdHocDarwinSignature: false,
    })
  })

  it('signs with exactly the entitlements files, nothing added automatically', () => {
    const c = config(RELEASE_ENV)
    expect(c.mac.entitlements).toBe(ENTITLEMENTS_PATH)
    expect(c.mac.entitlementsInherit).toBe(ENTITLEMENTS_INHERIT_PATH)
    expect(c.mac.preAutoEntitlements).toBe(false)
  })

  it('gives the designated requirement to the outer bundle only, never through mac.requirements', async () => {
    const c = config(RELEASE_ENV)
    expect(c.mac.requirements).toBeUndefined()
    signCalls.length = 0
    const app = '/dist/mac-arm64/valet.app'
    await c.mac.sign({
      app,
      identity: 'ABCDEF',
      optionsForFile: () => ({ hardenedRuntime: true, entitlements: 'e.plist', requirements: 'leaked' }),
    })
    const options = signCalls[0] as SignOptionsLike & { identity: string }
    expect(options.identity).toBe('ABCDEF')
    expect(options.optionsForFile?.(app)).toEqual({
      hardenedRuntime: true,
      entitlements: 'e.plist',
      requirements: RELEASE_REQUIREMENT,
    })
    expect(options.optionsForFile?.(`${app}/Contents/Frameworks/valet Helper.app`)).toEqual({
      hardenedRuntime: true,
      entitlements: 'e.plist',
      requirements: undefined,
    })
  })

  it('publishes to the generic feed with the channel left to the version', () => {
    const c = config(RELEASE_ENV)
    expect(c.publish).toEqual([{ provider: 'generic', url: 'https://updates.example.com/mac/' }])
    expect(c.generateUpdatesFilesForAllChannels).toBe(true)
    expect(c.detectUpdateChannel).toBeUndefined()
  })

  it('packages only the build output', () => {
    const c = config(RELEASE_ENV)
    expect(c.files).toEqual([
      'out/main/**/*',
      'out/preload/**/*',
      'out/renderer/**/*',
      'package.json',
      '!**/*.map',
      '!node_modules/**/*',
      'node_modules/@1password/sdk/**/*',
      'node_modules/@1password/sdk-core/**/*',
    ])
    expect(c.asar).toBe(true)
    expect(c.directories).toEqual({ output: 'dist', buildResources: 'build' })
  })

  it('accepts an identity by SHA-1, a .p12 through CSC_LINK, and an API key for notarisation', () => {
    expect(() => config({ ...RELEASE_ENV, CSC_NAME: 'A'.repeat(40) })).not.toThrow()
    expect(() => config({ ...RELEASE_ENV, CSC_NAME: undefined, CSC_LINK: '/tmp/id.p12' })).not.toThrow()
    expect(() =>
      config({
        ...RELEASE_ENV,
        APPLE_KEYCHAIN_PROFILE: undefined,
        APPLE_API_KEY: '/tmp/AuthKey.p8',
        APPLE_API_KEY_ID: 'KEY123',
        APPLE_API_ISSUER: 'issuer-uuid',
      }),
    ).not.toThrow()
  })
})

describe('a release build refuses to be built weaker', () => {
  const refuses = (env: BuildEnv, message: string | RegExp) => {
    expect(() => config(env)).toThrow(BuildConfigError)
    expect(() => config(env)).toThrow(message)
  }

  it('without a Team ID, or with one that could change the requirement', () => {
    refuses({ ...RELEASE_ENV, VALET_TEAM_ID: undefined }, 'VALET_TEAM_ID')
    refuses({ ...RELEASE_ENV, VALET_TEAM_ID: '' }, 'VALET_TEAM_ID')
    for (const teamId of [
      'abcde12345',
      'ABCDE1234',
      'ABCDE123456',
      'ABCDE12345" or anchor apple',
      'ABCDE 2345',
    ]) {
      refuses({ ...RELEASE_ENV, VALET_TEAM_ID: teamId }, 'VALET_TEAM_ID')
    }
  })

  it('without an https feed, or with a token in it', () => {
    refuses({ ...RELEASE_ENV, VALET_UPDATE_URL: undefined }, 'VALET_UPDATE_URL')
    for (const url of [
      'http://updates.example.com/mac/',
      'http://127.0.0.1:4555/',
      'https://updates.example.com/mac/?token=abc',
      'https://user:pw@updates.example.com/mac/',
      'https://updates.example.com/mac',
    ]) {
      refuses({ ...RELEASE_ENV, VALET_UPDATE_URL: url }, 'VALET_UPDATE_URL')
    }
  })

  it('with a feed on a host that cannot be public, baked into app-update.yml', () => {
    for (const url of [
      'https://localhost/mac/',
      'https://127.0.0.1/mac/',
      'https://192.168.1.10/mac/',
      'https://[::1]/mac/',
      'https://updates/mac/',
      'https://updates.local/mac/',
    ]) {
      refuses({ ...RELEASE_ENV, VALET_UPDATE_URL: url }, 'public host name')
    }
  })

  it('without a signing identity, or with automatic discovery turned off', () => {
    refuses({ ...RELEASE_ENV, CSC_NAME: undefined }, 'CSC_NAME or CSC_LINK')
    refuses({ ...RELEASE_ENV, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, 'CSC_IDENTITY_AUTO_DISCOVERY')
  })

  it('with an identity from another team, a certificate-type prefix, or no name', () => {
    refuses({ ...RELEASE_ENV, CSC_NAME: 'Someone (ZZZZZ99999)' }, 'CSC_NAME')
    // electron-builder refuses a Developer ID prefix itself; an Apple Development one would sign
    // with the wrong kind of certificate.
    refuses({ ...RELEASE_ENV, CSC_NAME: 'Developer ID Application: Example Person (ABCDE12345)' }, 'CSC_NAME')
    refuses({ ...RELEASE_ENV, CSC_NAME: 'Apple Development: Example Person (ABCDE12345)' }, 'CSC_NAME')
    refuses({ ...RELEASE_ENV, CSC_NAME: 'Example Person (ABCDE12345) x' }, 'CSC_NAME')
    refuses({ ...RELEASE_ENV, CSC_NAME: ' (ABCDE12345)' }, 'CSC_NAME')
    refuses({ ...RELEASE_ENV, CSC_NAME: 'a'.repeat(40) }, 'CSC_NAME')
  })

  it('without notarisation credentials, or with a partial or Apple ID set', () => {
    refuses({ ...RELEASE_ENV, APPLE_KEYCHAIN_PROFILE: undefined }, 'notarised')
    refuses(
      { ...RELEASE_ENV, APPLE_KEYCHAIN_PROFILE: undefined, APPLE_API_KEY: '/tmp/k.p8' },
      'APPLE_API_ISSUER',
    )
    refuses({ ...RELEASE_ENV, APPLE_ID: 'someone@example.com' }, 'APPLE_ID')
    refuses({ ...RELEASE_ENV, APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh' }, 'APPLE_ID')
  })

  it('from an out/main not built as this release: no build, another feed, no key, or a smoke build', () => {
    const withBundle = (bundle: string | null) => () =>
      createBuilderConfig(RELEASE_ENV, { ...DEPS, readMainBundle: () => bundle })
    expect(withBundle(null)).toThrow(/run `electron-vite build`/)
    expect(withBundle('const FEED_BASE_URL = "";')).toThrow(/not built with this VALET_UPDATE_URL/)
    expect(withBundle(RELEASE_BUNDLE.replace('/mac/', '/mac/beta/'))).toThrow(/VALET_UPDATE_URL/)
    expect(withBundle(RELEASE_BUNDLE.replace('BEGIN PUBLIC KEY', 'nothing'))).toThrow(/public key/)
    expect(withBundle(`${RELEASE_BUNDLE}\nconst m = "${SMOKE_BUILD_MARKER}";`)).toThrow(/smoke build/)
    for (const bundle of [null, ''])
      expect(() => checkReleaseBundle(bundle, 'https://updates.example.com/mac/')).toThrow(BuildConfigError)
    // A development build never reads out/.
    expect(() =>
      createBuilderConfig(
        {},
        {
          ...DEPS,
          readMainBundle: () => {
            throw new Error('read')
          },
        },
      ),
    ).not.toThrow()
  })

  it('ships the Swift stdio bridge in Contents/MacOS, and refuses a release without it', () => {
    expect(config(RELEASE_ENV).extraFiles).toEqual([
      { from: SWIFT_BRIDGE_BUILD, to: `MacOS/${BRIDGE_EXECUTABLE}` },
      { from: `${SWIFT_BUILD_DIR}/valet-keychain`, to: 'MacOS/valet-keychain' },
      { from: `${SWIFT_BUILD_DIR}/valet-messages-helper`, to: 'MacOS/valet-messages-helper' },
      {
        from: 'build/launch-agents/me.dncr.valet.messages-helper.plist',
        to: 'Library/LaunchAgents/messages-helper.plist',
      },
    ])
    // A development build's agent has its own label, so it never stands in for the release's.
    expect(createBuilderConfig({}, DEPS).extraFiles).toContainEqual({
      from: 'build/launch-agents/me.dncr.valet.dev.messages-helper.plist',
      to: 'Library/LaunchAgents/messages-helper.plist',
    })
    expect(() => createBuilderConfig(RELEASE_ENV, { ...DEPS, bridgeBuilt: () => false })).toThrow(
      /ships the stdio bridge/,
    )
    // A development build without it packages without it.
    expect(createBuilderConfig({}, { ...DEPS, bridgeBuilt: () => false }).extraFiles).toEqual([])
  })

  it('gives each build’s Messages helper agent its own label, socket and bundle', () => {
    for (const appId of ['me.dncr.valet', 'me.dncr.valet.dev']) {
      const plist = readFileSync(
        join(import.meta.dirname, '../..', `build/launch-agents/${appId}.messages-helper.plist`),
        'utf8',
      )
      expect(plist).toContain(`<key>Label</key>\n  <string>${appId}.messages-helper</string>`)
      expect(plist).toContain(`<string>serve</string>\n    <string>${appId}.messages-helper</string>`)
      expect(plist).toContain('<string>Contents/MacOS/valet-messages-helper</string>')
      expect(plist).toContain(
        `<key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>${appId}</string>`,
      )
    }
  })

  it('when the release flag is anything but 1', () => {
    for (const flag of ['true', 'yes', '2', 'release']) {
      refuses({ ...RELEASE_ENV, VALET_RELEASE: flag }, 'VALET_RELEASE')
    }
  })
})

/** A release dry run's environment, as scripts/release.mjs --dry-run sets it. */
const DRY_RUN_ENV: BuildEnv = {
  VALET_RELEASE: '1',
  VALET_RELEASE_DRY_RUN: '1',
  VALET_UPDATE_URL: 'https://updates.example.com/mac/',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
}

describe('a release dry run', () => {
  const refuses = (env: BuildEnv, message: string | RegExp) => {
    expect(() => config(env)).toThrow(BuildConfigError)
    expect(() => config(env)).toThrow(message)
  }

  it('is the release app, signed ad hoc with the same fuses and entitlements, never notarised', () => {
    const c = config(DRY_RUN_ENV)
    const release = config(RELEASE_ENV)
    expect(c.appId).toBe(RELEASE_APP_ID)
    expect(c.productName).toBe(RELEASE_PRODUCT_NAME)
    expect(c.extraMetadata).toEqual(release.extraMetadata)
    expect(c.mac.identity).toBe('-')
    expect(c.mac.sign).toBeUndefined()
    expect(c.mac.notarize).toBe(false)
    expect(c.forceCodeSigning).toBe(true)
    expect(c.electronFuses).toEqual(release.electronFuses)
    expect(c.mac.entitlements).toBe(release.mac.entitlements)
    expect(c.mac.entitlementsInherit).toBe(release.mac.entitlementsInherit)
    expect(c.mac.target).toEqual(release.mac.target)
    expect(c.mac.artifactName).toBe(release.mac.artifactName)
    expect(c.mac.type).toBe('distribution')
    expect(c.publish).toEqual(release.publish)
    expect(c.files).toEqual(release.files)
    expect(c.extraFiles).toEqual(release.extraFiles)
    const binaries = [
      'Contents/MacOS/valet-bridge',
      'Contents/MacOS/valet-keychain',
      'Contents/MacOS/valet-messages-helper',
    ]
    expect(c.mac.binaries).toEqual(binaries)
    expect(release.mac.binaries).toEqual(binaries)
    expect(createBuilderConfig(DRY_RUN_ENV, DEPS).mac?.binaries).toEqual(release.mac.binaries)
  })

  it('takes no signing identity, Team ID or notarisation credentials', () => {
    for (const [name, value] of Object.entries({
      CSC_NAME: 'Example Person (ABCDE12345)',
      CSC_LINK: '/tmp/cert.p12',
      VALET_TEAM_ID: 'ABCDE12345',
      APPLE_KEYCHAIN_PROFILE: 'valet-notary',
      APPLE_API_KEY: '/tmp/key.p8',
      APPLE_API_KEY_ID: 'ABC123',
      APPLE_API_ISSUER: 'issuer',
      APPLE_TEAM_ID: 'ABCDE12345',
    })) {
      expect(() => config({ ...DRY_RUN_ENV, [name]: value }), name).toThrow(BuildConfigError)
    }
    refuses({ ...DRY_RUN_ENV, APPLE_ID: 'person@example.com' }, 'APPLE_ID')
  })

  it('still needs the release feed, an out/main built for it, and the bridge', () => {
    refuses({ ...DRY_RUN_ENV, VALET_UPDATE_URL: undefined }, 'VALET_UPDATE_URL')
    refuses({ ...DRY_RUN_ENV, VALET_UPDATE_URL: 'http://127.0.0.1:4555/' }, 'VALET_UPDATE_URL')
    const smoke = { ...DEPS, readMainBundle: () => `${RELEASE_BUNDLE}${SMOKE_BUILD_MARKER}` }
    expect(() => createBuilderConfig(DRY_RUN_ENV, smoke)).toThrow(/smoke build/)
    expect(() => createBuilderConfig(DRY_RUN_ENV, { ...DEPS, bridgeBuilt: () => false })).toThrow(/bridge/)
  })

  it('is only a dry run of a release, and the flag is 1 or unset', () => {
    refuses({ VALET_RELEASE_DRY_RUN: '1' }, 'VALET_RELEASE=1')
    for (const flag of ['true', 'yes', '2']) {
      refuses({ ...DRY_RUN_ENV, VALET_RELEASE_DRY_RUN: flag }, 'VALET_RELEASE_DRY_RUN')
    }
    expect(config({ ...RELEASE_ENV, VALET_RELEASE_DRY_RUN: '0' }).mac.notarize).toBe(true)
  })
})

describe('a development build', () => {
  it('has its own bundle ID and name, so it shares no Keychain items or userData with release', () => {
    const c = config({})
    expect(c.appId).toBe(DEV_APP_ID)
    expect(c.appId).toBe('me.dncr.valet.dev')
    expect(c.productName).toBe(DEV_PRODUCT_NAME)
    expect(c.extraMetadata).toEqual({ name: 'valet-dev', productName: 'Valet Dev' })
    expect(config({ VALET_RELEASE: '0' }).appId).toBe(DEV_APP_ID)
  })

  it('is unsigned unless an identity is named, and re-signed ad hoc after the fuses flip', () => {
    for (const env of [{}, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }]) {
      const c = config(env)
      expect(c.mac.identity).toBeNull()
      expect(c.forceCodeSigning).toBe(false)
      expect(c.electronFuses.resetAdHocDarwinSignature).toBe(true)
      expect(c.mac.sign).toBeUndefined()
    }
  })

  it('has the same fuses and entitlements as release', () => {
    const { resetAdHocDarwinSignature: _dev, ...dev } = config({}).electronFuses
    const { resetAdHocDarwinSignature: _release, ...release } = config(RELEASE_ENV).electronFuses
    expect(dev).toEqual(release)
    expect(dev).toEqual(ELECTRON_FUSES)
    expect(config({}).mac.entitlements).toBe(ENTITLEMENTS_PATH)
    expect(config({}).mac.hardenedRuntime).toBe(true)
  })

  it('is never notarised, even with credentials in the environment', () => {
    const c = config({
      APPLE_KEYCHAIN_PROFILE: 'valet-notary',
      CSC_NAME: DEV_IDENTITY,
    })
    expect(c.mac.notarize).toBe(false)
    expect(c.mac.type).toBe('development')
  })

  it('pins a signed dev build to the team with the Apple Development requirement, for the .dev ID', async () => {
    const c = config({ CSC_NAME: DEV_IDENTITY, VALET_TEAM_ID: 'ABCDE12345' })
    expect('identity' in c.mac).toBe(false)
    expect(c.electronFuses.resetAdHocDarwinSignature).toBe(false)
    signCalls.length = 0
    await c.mac.sign({ app: '/x/valet-dev.app', optionsForFile: () => ({}) })
    expect(signCalls[0]?.optionsForFile?.('/x/valet-dev.app')).toEqual({
      requirements:
        '=designated => identifier "me.dncr.valet.dev" and anchor apple generic and ' +
        'certificate 1[field.1.2.840.113635.100.6.2.1] and certificate leaf[subject.OU] = "ABCDE12345"',
    })
  })

  it('signs without a requirement when no Team ID is given', () => {
    const c = config({ CSC_NAME: DEV_IDENTITY })
    expect(c.mac.sign).toBeUndefined()
  })

  it('takes a signing identity only as a SHA-1, so a name can’t find the Developer ID key', () => {
    // electron-builder searches "Mac Developer" and "Developer ID Application" certificates for a
    // development build's CSC_NAME; the release's "<name> (TEAMID)" form would match Developer ID.
    for (const name of [
      'Example Person (ABCDE12345)',
      'Apple Development: Example Person (ABCDE12345)',
      'Developer ID Application: Example Person (ABCDE12345)',
      DEV_IDENTITY.toLowerCase(),
      `${DEV_IDENTITY}0`,
    ]) {
      expect(() => config({ CSC_NAME: name }), name).toThrow('SHA-1 of an Apple Development identity')
      expect(() => config({ CSC_NAME: name, VALET_TEAM_ID: 'ABCDE12345' }), name).toThrow(BuildConfigError)
    }
    expect(() => config({ CSC_LINK: '/tmp/developer-id.p12' })).toThrow('unset CSC_LINK')
    expect(() => config({ CSC_LINK: '/tmp/x.p12', CSC_NAME: DEV_IDENTITY })).toThrow('unset CSC_LINK')
  })

  it('may point at a local feed, and has none by default', () => {
    expect(config({}).publish).toBeNull()
    expect(config({ VALET_UPDATE_URL: 'http://127.0.0.1:4555/' }).publish).toEqual([
      { provider: 'generic', url: 'http://127.0.0.1:4555/' },
    ])
    expect(() => config({ VALET_UPDATE_URL: 'http://updates.example.com/' })).toThrow(BuildConfigError)
    expect(() => config({ VALET_TEAM_ID: 'nope' })).toThrow(BuildConfigError)
  })

  it('still refuses an Apple ID for notarisation', () => {
    expect(() => config({ APPLE_ID: 'someone@example.com' })).toThrow('APPLE_ID')
  })
})

describe('renderRequirement', () => {
  const template = nodeDeps.readTemplate('designated-requirement.txt')

  it('fills the release template and drops its comments', () => {
    expect(renderRequirement(template, { appId: RELEASE_APP_ID, teamId: 'ABCDE12345' })).toBe(
      RELEASE_REQUIREMENT,
    )
  })

  it('refuses a Team ID or bundle ID that would rewrite the requirement', () => {
    expect(() => renderRequirement(template, { appId: RELEASE_APP_ID, teamId: 'X" or true or "' })).toThrow(
      BuildConfigError,
    )
    expect(() =>
      renderRequirement(template, { appId: 'me.dncr" or anchor apple', teamId: 'ABCDE12345' }),
    ).toThrow(BuildConfigError)
  })

  it('refuses a template left with placeholders, an open comment, or no designated clause', () => {
    const values = { appId: RELEASE_APP_ID, teamId: 'ABCDE12345' }
    expect(() => renderRequirement(`${template} and __OTHER__`, values)).toThrow('malformed')
    expect(() => renderRequirement(`${template} /* unterminated`, values)).toThrow('malformed')
    expect(() => renderRequirement('anchor apple', values)).toThrow('malformed')
  })
})

describe('signWithRequirement', () => {
  it('works when electron-builder passes no per-file options', async () => {
    const seen: SignOptionsLike[] = []
    const sign = signWithRequirement(
      () => async (o) => {
        seen.push(o)
      },
      '=designated => anchor apple',
    )
    await sign({ app: '/a.app' })
    expect(seen[0]?.optionsForFile?.('/a.app')).toEqual({ requirements: '=designated => anchor apple' })
    expect(seen[0]?.optionsForFile?.('/a.app/Contents/MacOS/a')).toEqual({ requirements: undefined })
  })

  it('retries a failed signing as electron-builder’s default signing does, then gives up', async () => {
    const waits: number[] = []
    let calls = 0
    const flaky = signWithRequirement(
      () => async () => {
        calls++
        if (calls < 3) throw new Error('timestamp service unavailable')
      },
      '=designated => anchor apple',
      async (ms) => {
        waits.push(ms)
      },
    )
    await flaky({ app: '/a.app' })
    expect(calls).toBe(3)
    expect(waits).toEqual([SIGN_RETRY_INTERVAL_MS, SIGN_RETRY_INTERVAL_MS + SIGN_RETRY_BACKOFF_MS])

    calls = 0
    waits.length = 0
    const broken = signWithRequirement(
      () => async () => {
        calls++
        throw new Error('no identity')
      },
      '=designated => anchor apple',
      async (ms) => {
        waits.push(ms)
      },
    )
    await expect(broken({ app: '/a.app' })).rejects.toThrow('no identity')
    expect(calls).toBe(SIGN_RETRIES + 1)
    expect(SIGN_RETRIES).toBe(3)
    expect(waits).toHaveLength(SIGN_RETRIES)
  })

  it('keeps the requirement on the outer app on every attempt', async () => {
    const seen: SignOptionsLike[] = []
    const sign = signWithRequirement(
      () => async (o) => {
        seen.push(o)
        if (seen.length === 1) throw new Error('flaky')
      },
      '=designated => anchor apple',
      async () => {},
    )
    await sign({ app: '/a.app', optionsForFile: () => ({ hardenedRuntime: true }) })
    expect(seen).toHaveLength(2)
    for (const options of seen) {
      expect(options.optionsForFile?.('/a.app')).toEqual({
        hardenedRuntime: true,
        requirements: '=designated => anchor apple',
      })
      expect(options.optionsForFile?.('/a.app/Contents/MacOS/a')).toEqual({
        hardenedRuntime: true,
        requirements: undefined,
      })
    }
  })

  it('reaches electron-builder’s own @electron/osx-sign (loaded, never called here)', () => {
    expect(typeof nodeDeps.loadSignAsync()).toBe('function')
  })

  it('reads out/main as every .js file under it, joined, or null without an index.js', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sa-bundle-'))
    try {
      expect(readBundle(dir)).toBeNull()
      mkdirSync(join(dir, 'chunks'))
      writeFileSync(join(dir, 'index.js'), 'index')
      writeFileSync(join(dir, 'chunks', 'a.js'), 'chunk')
      writeFileSync(join(dir, 'chunks', 'a.js.map'), 'map')
      expect(readBundle(dir)).toBe('chunk\nindex')
      expect(typeof nodeDeps.readMainBundle()).toMatch(/string|object/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the entitlements files', () => {
  function entitlements(path: string): Record<string, string> {
    const text = readFileSync(resolve(APP_DIR, path), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const dict = /<dict>([\s\S]*)<\/dict>/.exec(text)?.[1] ?? ''
    const entries: Record<string, string> = {}
    const pattern = /<key>([^<]*)<\/key>\s*<([a-z]+)\s*\/>/g
    for (const match of dict.matchAll(pattern)) entries[match[1] as string] = match[2] as string
    // Every <key> must have been read as a boolean entry: nothing hidden in another shape.
    expect(dict.match(/<key>/g)?.length ?? 0).toBe(Object.keys(entries).length)
    return entries
  }

  for (const path of [ENTITLEMENTS_PATH, ENTITLEMENTS_INHERIT_PATH]) {
    it(`${path} holds allow-jit and nothing else`, () => {
      const found = entitlements(path)
      expect(found).toEqual({ 'com.apple.security.cs.allow-jit': 'true' })
      for (const key of Object.keys(found)) expect(ALLOWED_ENTITLEMENTS).toContain(key)
      for (const forbidden of FORBIDDEN_ENTITLEMENTS) expect(found).not.toHaveProperty(forbidden)
      expect(found).not.toHaveProperty('com.apple.security.app-sandbox')
    })
  }
})

describe('scripts/make-feed.mjs', () => {
  it('checks zips against the same release bundle ID as the config', () => {
    expect(SCRIPT_RELEASE_APP_ID).toBe(RELEASE_APP_ID)
  })
})

describe('docs/release-and-updates.md', () => {
  it('names the config file, both bundle IDs and the environment variables the config reads', () => {
    for (const text of [
      'electron-builder.config.ts',
      RELEASE_APP_ID,
      DEV_APP_ID,
      'VALET_RELEASE',
      'VALET_TEAM_ID',
      'VALET_UPDATE_URL',
      'CSC_IDENTITY_AUTO_DISCOVERY=false',
      'scripts/make-feed.mjs',
    ]) {
      expect(DOC).toContain(text)
    }
  })

  it('shows every fuse with the value the config sets', () => {
    for (const [fuse, value] of Object.entries(ELECTRON_FUSES)) {
      expect(DOC).toMatch(new RegExp(`${fuse}: ${value}\\b`))
    }
  })
})
