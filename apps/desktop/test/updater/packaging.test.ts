// @vitest-environment node
// The packaging configuration, held in place: identity, signing, fuses, entitlements and the feed.
// Each refusal has a test that tries to get a weaker build out of the config.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ENTITLEMENTS,
  BuildConfigError,
  type BuildEnv,
  type ConfigDeps,
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
  renderRequirement,
  type SignOptionsLike,
  signWithRequirement,
} from '../../electron-builder.config'

const APP_DIR = resolve(import.meta.dirname, '../..')
const DOC = readFileSync(resolve(APP_DIR, '../../docs/release-and-updates.md'), 'utf8')

const RELEASE_ENV: BuildEnv = {
  SITEADAPTER_RELEASE: '1',
  SITEADAPTER_TEAM_ID: 'ABCDE12345',
  SITEADAPTER_UPDATE_URL: 'https://updates.example.com/mac/',
  CSC_NAME: 'Example Person (ABCDE12345)',
  APPLE_KEYCHAIN_PROFILE: 'siteadapter-notary',
}

const signCalls: SignOptionsLike[] = []
const DEPS: ConfigDeps = {
  readTemplate: nodeDeps.readTemplate,
  loadSignAsync: () => async (options) => {
    signCalls.push(options)
  },
}

// The config's nested option types are electron-builder's unions; tests read them loosely.
const config = (env: BuildEnv): any => createBuilderConfig(env, DEPS)

const RELEASE_REQUIREMENT =
  '=designated => identifier "me.dncr.siteadapter" and anchor apple generic and ' +
  'certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and ' +
  'certificate leaf[subject.OU] = "ABCDE12345"'

describe('a release build', () => {
  it('has the release identity, is signed with the hardened runtime and notarised', () => {
    const c = config(RELEASE_ENV)
    expect(c.appId).toBe(RELEASE_APP_ID)
    expect(c.appId).toBe('me.dncr.siteadapter')
    expect(c.productName).toBe('siteadapter')
    expect(c.extraMetadata).toEqual({ name: RELEASE_PRODUCT_NAME, productName: RELEASE_PRODUCT_NAME })
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
    expect(c.mac.artifactName).toBe('${productName}-${version}-${arch}.${ext}')
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
    const app = '/dist/mac-arm64/siteadapter.app'
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
    expect(options.optionsForFile?.(`${app}/Contents/Frameworks/siteadapter Helper.app`)).toEqual({
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
    expect(c.files).toEqual(['out/**/*', 'package.json', '!**/*.map'])
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
    refuses({ ...RELEASE_ENV, SITEADAPTER_TEAM_ID: undefined }, 'SITEADAPTER_TEAM_ID')
    refuses({ ...RELEASE_ENV, SITEADAPTER_TEAM_ID: '' }, 'SITEADAPTER_TEAM_ID')
    for (const teamId of [
      'abcde12345',
      'ABCDE1234',
      'ABCDE123456',
      'ABCDE12345" or anchor apple',
      'ABCDE 2345',
    ]) {
      refuses({ ...RELEASE_ENV, SITEADAPTER_TEAM_ID: teamId }, 'SITEADAPTER_TEAM_ID')
    }
  })

  it('without an https feed, or with a token in it', () => {
    refuses({ ...RELEASE_ENV, SITEADAPTER_UPDATE_URL: undefined }, 'SITEADAPTER_UPDATE_URL')
    for (const url of [
      'http://updates.example.com/mac/',
      'http://127.0.0.1:4555/',
      'https://updates.example.com/mac/?token=abc',
      'https://user:pw@updates.example.com/mac/',
      'https://updates.example.com/mac',
    ]) {
      refuses({ ...RELEASE_ENV, SITEADAPTER_UPDATE_URL: url }, 'SITEADAPTER_UPDATE_URL')
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

  it('when the release flag is anything but 1', () => {
    for (const flag of ['true', 'yes', '2', 'release']) {
      refuses({ ...RELEASE_ENV, SITEADAPTER_RELEASE: flag }, 'SITEADAPTER_RELEASE')
    }
  })
})

describe('a development build', () => {
  it('has its own bundle ID and name, so it shares no Keychain items or userData with release', () => {
    const c = config({})
    expect(c.appId).toBe(DEV_APP_ID)
    expect(c.appId).toBe('me.dncr.siteadapter.dev')
    expect(c.productName).toBe(DEV_PRODUCT_NAME)
    expect(c.extraMetadata).toEqual({ name: 'siteadapter-dev', productName: 'siteadapter-dev' })
    expect(config({ SITEADAPTER_RELEASE: '0' }).appId).toBe(DEV_APP_ID)
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
      APPLE_KEYCHAIN_PROFILE: 'siteadapter-notary',
      CSC_NAME: 'Apple Development: X (ABCDE12345)',
    })
    expect(c.mac.notarize).toBe(false)
    expect(c.mac.type).toBe('development')
  })

  it('pins a signed dev build to the team with the Apple Development requirement, for the .dev ID', async () => {
    const c = config({ CSC_NAME: 'Apple Development: X (ABCDE12345)', SITEADAPTER_TEAM_ID: 'ABCDE12345' })
    expect('identity' in c.mac).toBe(false)
    expect(c.electronFuses.resetAdHocDarwinSignature).toBe(false)
    signCalls.length = 0
    await c.mac.sign({ app: '/x/siteadapter-dev.app', optionsForFile: () => ({}) })
    expect(signCalls[0]?.optionsForFile?.('/x/siteadapter-dev.app')).toEqual({
      requirements:
        '=designated => identifier "me.dncr.siteadapter.dev" and anchor apple generic and ' +
        'certificate 1[field.1.2.840.113635.100.6.2.1] and certificate leaf[subject.OU] = "ABCDE12345"',
    })
  })

  it('signs without a requirement when no Team ID is given', () => {
    const c = config({ CSC_NAME: 'Apple Development: X (ABCDE12345)' })
    expect(c.mac.sign).toBeUndefined()
  })

  it('may point at a local feed, and has none by default', () => {
    expect(config({}).publish).toBeNull()
    expect(config({ SITEADAPTER_UPDATE_URL: 'http://127.0.0.1:4555/' }).publish).toEqual([
      { provider: 'generic', url: 'http://127.0.0.1:4555/' },
    ])
    expect(() => config({ SITEADAPTER_UPDATE_URL: 'http://updates.example.com/' })).toThrow(BuildConfigError)
    expect(() => config({ SITEADAPTER_TEAM_ID: 'nope' })).toThrow(BuildConfigError)
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

  it('reaches electron-builder’s own @electron/osx-sign (loaded, never called here)', () => {
    expect(typeof nodeDeps.loadSignAsync()).toBe('function')
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

describe('docs/release-and-updates.md', () => {
  it('names the config file, both bundle IDs and the environment variables the config reads', () => {
    for (const text of [
      'electron-builder.config.ts',
      RELEASE_APP_ID,
      DEV_APP_ID,
      'SITEADAPTER_RELEASE',
      'SITEADAPTER_TEAM_ID',
      'SITEADAPTER_UPDATE_URL',
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
