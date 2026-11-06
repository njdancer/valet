// electron-builder configuration for the macOS app. Everything that decides the app's identity is
// here, in one place: the bundle IDs, product names, signing, the designated requirement, the fuses,
// the entitlements files and the update feed. docs/release-and-updates.md explains the choices and
// test/updater/packaging.test.ts holds them in place.
//
//   Development build, unsigned (works with no Apple account at all):
//     CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --dir --config electron-builder.config.ts
//   Release build (the release script sets these; signing keys never live in the repo):
//     SITEADAPTER_RELEASE=1 SITEADAPTER_TEAM_ID=… SITEADAPTER_UPDATE_URL=https://…/mac/ \
//     CSC_NAME="Developer ID Application: … (TEAMID)" APPLE_KEYCHAIN_PROFILE=siteadapter-notary \
//     electron-builder --mac --config electron-builder.config.ts --publish never
//
// Development builds get their own bundle ID and product name, so they never share Keychain items,
// userData, cookie-encryption keys or Full Disk Access grants with the release app.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Configuration } from 'electron-builder'
import { validateFeedUrl } from './src/main/updater/feed-url'

/** The release bundle ID. D1 (the product name) is pending; this is the only place it is written. */
export const RELEASE_APP_ID = 'me.dncr.siteadapter'
export const DEV_APP_ID = `${RELEASE_APP_ID}.dev`
export const RELEASE_PRODUCT_NAME = 'siteadapter'
export const DEV_PRODUCT_NAME = 'siteadapter-dev'

/**
 * Electron fuses, flipped in the Electron binary before signing. With these off, no local process can
 * run its own JavaScript with the app's signature (and so its Keychain access): not through
 * ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect or SIGUSR1, nor by putting an app/ folder or a
 * different app.asar beside the signed one.
 */
export const ELECTRON_FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  /**
   * Decision, one-way: cookies at rest (the auth: and tool: partitions' live site sessions) are
   * encrypted with a key in a Keychain item named after the app, instead of sitting in plaintext
   * SQLite under userData. Turning this off later makes the existing cookie store unreadable, so it
   * is on from the first build that holds a real session. See docs/release-and-updates.md.
   */
  enableCookieEncryption: true,
  /** The renderer is loaded from the asar; it needs no file:// privileges beyond a browser's. */
  grantFileProtocolExtraPrivileges: false,
  loadBrowserProcessSpecificV8Snapshot: false,
} as const

/** The only entitlement either plist may hold. */
export const ALLOWED_ENTITLEMENTS = ['com.apple.security.cs.allow-jit'] as const

/** Each of these lets other code run as the app, which would make the designated requirement moot. */
export const FORBIDDEN_ENTITLEMENTS = [
  'com.apple.security.cs.disable-library-validation',
  'com.apple.security.cs.allow-dyld-environment-variables',
  'com.apple.security.get-task-allow',
  'com.apple.security.cs.debugger',
  'com.apple.security.cs.disable-executable-page-protection',
] as const

export const ENTITLEMENTS_PATH = 'build/entitlements.mac.plist'
export const ENTITLEMENTS_INHERIT_PATH = 'build/entitlements.mac.inherit.plist'
export const RELEASE_REQUIREMENT_TEMPLATE = 'designated-requirement.txt'
export const DEV_REQUIREMENT_TEMPLATE = 'designated-requirement.dev.txt'

/** The environment the config reads. The named variables are the ones it acts on. */
export interface BuildEnv {
  readonly SITEADAPTER_RELEASE?: string
  readonly SITEADAPTER_TEAM_ID?: string
  readonly SITEADAPTER_UPDATE_URL?: string
  readonly CSC_NAME?: string
  readonly CSC_LINK?: string
  readonly CSC_IDENTITY_AUTO_DISCOVERY?: string
  readonly APPLE_ID?: string
  readonly APPLE_APP_SPECIFIC_PASSWORD?: string
  readonly APPLE_API_KEY?: string
  readonly APPLE_API_KEY_ID?: string
  readonly APPLE_API_ISSUER?: string
  readonly APPLE_KEYCHAIN_PROFILE?: string
  readonly [name: string]: string | undefined
}

/** A build configuration refused before electron-builder runs. The message names the variable. */
export class BuildConfigError extends Error {
  override name = 'BuildConfigError'
}

/** The part of @electron/osx-sign's signAsync the sign wrapper calls. */
export type SignAsync = (options: SignOptionsLike) => Promise<void>

export interface SignOptionsLike {
  readonly app: string
  readonly optionsForFile?: (filePath: string) => Readonly<Record<string, unknown>> | null | undefined
}

export interface ConfigDeps {
  /** Reads a requirement template from build/. */
  readonly readTemplate: (name: string) => string
  /** @electron/osx-sign's signAsync, loaded only when a signed build actually signs. */
  readonly loadSignAsync: () => SignAsync
}

const TEAM_ID = /^[A-Z0-9]{10}$/
const SHA1_IDENTITY = /^[0-9A-F]{40}$/

function set(env: BuildEnv, name: string): boolean {
  const value = env[name]
  return value !== undefined && value !== ''
}

/**
 * Fills a requirement template and returns codesign's inline form ("=designated => …"), with the
 * template's comments and line breaks removed.
 */
export function renderRequirement(template: string, values: { appId: string; teamId: string }): string {
  if (!TEAM_ID.test(values.teamId))
    throw new BuildConfigError('SITEADAPTER_TEAM_ID must be 10 letters or digits')
  if (!/^[A-Za-z0-9.-]+$/.test(values.appId))
    throw new BuildConfigError('bundle ID has unexpected characters')
  const text = template
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll('__BUNDLE_ID__', values.appId)
    .replaceAll('__TEAM_ID__', values.teamId)
    .replace(/\s+/g, ' ')
    .trim()
  if (!text.startsWith('designated => ') || text.includes('__') || text.includes('/*')) {
    throw new BuildConfigError('requirement template is malformed')
  }
  return `=${text}`
}

/**
 * A sign function for electron-builder that adds the designated requirement to the outer app bundle
 * only. electron-builder's own `mac.requirements` gives it to every nested binary too, whose
 * identifiers can't satisfy it.
 */
export function signWithRequirement(loadSignAsync: () => SignAsync, requirement: string) {
  return async (options: SignOptionsLike): Promise<void> => {
    const signAsync = loadSignAsync()
    await signAsync({
      ...options,
      optionsForFile: (filePath: string) => {
        const base = options.optionsForFile?.(filePath) ?? {}
        return filePath === options.app
          ? { ...base, requirements: requirement }
          : { ...base, requirements: undefined }
      },
    })
  }
}

function notarisationCredentials(env: BuildEnv): boolean {
  if (set(env, 'APPLE_ID') || set(env, 'APPLE_APP_SPECIFIC_PASSWORD')) {
    // electron-builder prefers the Apple ID route over an API key when both are present.
    throw new BuildConfigError('notarise with an App Store Connect API key, not an Apple ID: unset APPLE_ID')
  }
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].filter((name) => set(env, name))
  if (apiKey.length > 0 && apiKey.length < 3) {
    throw new BuildConfigError('set all of APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or none')
  }
  return apiKey.length === 3 || set(env, 'APPLE_KEYCHAIN_PROFILE')
}

/** The configuration for the given environment. Pure apart from deps; throws BuildConfigError. */
export function createBuilderConfig(env: BuildEnv, deps: ConfigDeps): Configuration {
  const releaseFlag = env.SITEADAPTER_RELEASE
  if (releaseFlag !== undefined && releaseFlag !== '' && releaseFlag !== '0' && releaseFlag !== '1') {
    throw new BuildConfigError('SITEADAPTER_RELEASE must be 1 for a release build, or unset')
  }
  const release = releaseFlag === '1'
  const appId = release ? RELEASE_APP_ID : DEV_APP_ID
  const productName = release ? RELEASE_PRODUCT_NAME : DEV_PRODUCT_NAME
  const identityGiven = set(env, 'CSC_NAME') || set(env, 'CSC_LINK')
  const canNotarise = notarisationCredentials(env)
  const teamId = env.SITEADAPTER_TEAM_ID
  if (teamId !== undefined && teamId !== '' && !TEAM_ID.test(teamId)) {
    throw new BuildConfigError('SITEADAPTER_TEAM_ID must be 10 letters or digits')
  }

  const rawFeed = env.SITEADAPTER_UPDATE_URL
  const feedUrl =
    rawFeed === undefined || rawFeed === '' ? null : validateFeedUrl(rawFeed, { allowLoopbackHttp: !release })
  if (rawFeed !== undefined && rawFeed !== '' && feedUrl === null) {
    throw new BuildConfigError(
      'SITEADAPTER_UPDATE_URL must be an https directory URL ending in "/", with no query, fragment or credentials',
    )
  }

  let requirement: string | null = null
  if (release) {
    if (!set(env, 'SITEADAPTER_TEAM_ID'))
      throw new BuildConfigError('a release build needs SITEADAPTER_TEAM_ID')
    if (feedUrl === null) throw new BuildConfigError('a release build needs SITEADAPTER_UPDATE_URL')
    if (!identityGiven) throw new BuildConfigError('a release build needs CSC_NAME or CSC_LINK')
    if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
      throw new BuildConfigError('a release build is signed: unset CSC_IDENTITY_AUTO_DISCOVERY=false')
    }
    const name = env.CSC_NAME
    if (name !== undefined && name !== '' && !SHA1_IDENTITY.test(name)) {
      if (!name.startsWith('Developer ID Application: ') || !name.endsWith(` (${teamId})`)) {
        throw new BuildConfigError(
          'CSC_NAME must be a "Developer ID Application: … (SITEADAPTER_TEAM_ID)" identity or its SHA-1',
        )
      }
    }
    if (!canNotarise) {
      throw new BuildConfigError(
        'a release build is notarised: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE',
      )
    }
    requirement = renderRequirement(deps.readTemplate(RELEASE_REQUIREMENT_TEMPLATE), {
      appId,
      teamId: teamId as string,
    })
  } else if (identityGiven && teamId !== undefined && teamId !== '') {
    requirement = renderRequirement(deps.readTemplate(DEV_REQUIREMENT_TEMPLATE), { appId, teamId })
  }

  // A dev build without an explicit identity is never signed, rather than electron-builder finding
  // the Developer ID key in the login keychain by itself. The fuse flip then re-signs it ad hoc,
  // which Apple silicon needs to run a modified binary at all.
  const signs = release || identityGiven

  return {
    appId,
    productName,
    directories: { output: 'dist', buildResources: 'build' },
    // electron-vite's output only. No source maps, tests, fixtures or scripts in the package.
    files: ['out/**/*', 'package.json', '!**/*.map'],
    // The packaged package.json names the app, which sets userData, the cookie-encryption Keychain
    // item and the single-instance lock: dev and release must differ there too.
    extraMetadata: { productName },
    asar: true,
    npmRebuild: false,
    forceCodeSigning: release,
    electronFuses: { ...ELECTRON_FUSES, resetAdHocDarwinSignature: !signs },
    mac: {
      category: 'public.app-category.productivity',
      target: [
        { target: 'dmg', arch: ['arm64', 'x64'] },
        // Squirrel.Mac updates from the zip, never the DMG.
        { target: 'zip', arch: ['arm64', 'x64'] },
      ],
      // electron-updater picks the zip for the machine by "arm64" in its name.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own macros
      artifactName: '${productName}-${version}-${arch}.${ext}',
      ...(signs ? {} : { identity: null }),
      type: release ? 'distribution' : 'development',
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS_PATH,
      entitlementsInherit: ENTITLEMENTS_INHERIT_PATH,
      // The signed entitlements are exactly the files above.
      preAutoEntitlements: false,
      ...(requirement === null ? {} : { sign: signWithRequirement(deps.loadSignAsync, requirement) }),
      notarize: release,
      // The release script assesses with spctl itself, after stapling.
      gatekeeperAssess: false,
      extendInfo: {
        // A menu-bar app: no Dock icon, no app menu.
        LSUIElement: true,
      },
    },
    // Signed, notarised and stapled by the release script, after electron-builder.
    dmg: { sign: false },
    // No channel here: electron-builder takes it from the version (1.3.0-beta.1 publishes to beta),
    // and every stable release also writes beta-mac.yml so beta installs move on to it.
    publish: feedUrl === null ? null : [{ provider: 'generic', url: feedUrl }],
    generateUpdatesFilesForAllChannels: true,
  }
}

const here = fileURLToPath(new URL('.', import.meta.url))

/** The real effects: templates from build/, and the osx-sign electron-builder itself uses. */
export const nodeDeps: ConfigDeps = {
  readTemplate: (name) => readFileSync(join(here, 'build', name), 'utf8'),
  loadSignAsync: () => {
    // @electron/osx-sign isn't a dependency of this package; take electron-builder's own copy, the
    // version its default signing would use.
    const fromHere = createRequire(join(here, 'package.json'))
    const fromBuilder = createRequire(fromHere.resolve('electron-builder'))
    const fromLib = createRequire(fromBuilder.resolve('app-builder-lib'))
    return (fromLib('@electron/osx-sign') as { signAsync: SignAsync }).signAsync
  },
}

export default function config(): Configuration {
  return createBuilderConfig(process.env, nodeDeps)
}
