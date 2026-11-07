// electron-builder configuration for the macOS app. Everything that decides the app's identity is
// here, in one place: the bundle IDs, product names, signing, the designated requirement, the fuses,
// the entitlements files and the update feed. docs/release-and-updates.md explains the choices and
// test/updater/packaging.test.ts holds them in place.
//
//   Development build, unsigned (works with no Apple account at all):
//     CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --dir --config electron-builder.config.ts
//   Release build (the release script sets these; signing keys never live in the repo):
//     VALET_RELEASE=1 VALET_TEAM_ID=… VALET_UPDATE_URL=https://…/mac/ \
//     CSC_NAME="<name> (TEAMID)" APPLE_KEYCHAIN_PROFILE=valet-notary \
//     electron-builder --mac --config electron-builder.config.ts --publish never
//
// Development builds get their own bundle ID and product name, so they never share Keychain items,
// userData, cookie-encryption keys or Full Disk Access grants with the release app.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signAsync } from '@electron/osx-sign'
import type { Configuration } from 'electron-builder'
import { SMOKE_BUILD_MARKER } from './src/main/core/smoke'
import { validateFeedUrl } from './src/main/updater/feed-url'

/** The release bundle ID. D1 settled the name (Valet); this is the only place it is written. */
export const RELEASE_APP_ID = 'me.dncr.valet'
export const DEV_APP_ID = `${RELEASE_APP_ID}.dev`
export const RELEASE_PRODUCT_NAME = 'Valet'
export const DEV_PRODUCT_NAME = 'Valet Dev'

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
  /**
   * Off: file:// pages get no more than a browser gives them. That stops Vite's module scripts
   * running from a file:// page (verified on Electron 44: `<script type="module">` never runs), so
   * the renderer must not be loaded with loadFile. It is served from the privileged app:// scheme
   * instead (src/main/core/app-scheme.ts), which scripts/package-smoke.mjs checks in a packaged
   * window.
   */
  grantFileProtocolExtraPrivileges: false,
  loadBrowserProcessSpecificV8Snapshot: false,
} as const

/**
 * The only node_modules the packaged app carries: what the main bundle keeps external
 * (electron.vite.config.ts). Every workspace package and npm dependency is bundled into out/main,
 * so electron-builder's copy of the production dependencies is dropped but for these. The SDK is
 * loaded lazily, by the service-account provider, and reads its wasm from beside itself (Electron's
 * fs reads it inside app.asar).
 */
export const PACKAGED_NODE_MODULES = ['@1password/sdk', '@1password/sdk-core'] as const

/**
 * The Swift stdio bridge (D60, swift-bridge/), built universal for both architectures:
 * `swift build -c release --arch arm64 --arch x86_64 --package-path swift-bridge`. It ships beside
 * the app's own executable, so the app's signature covers it and client snippets can name its path.
 */
export const SWIFT_BRIDGE_BUILD = '../../swift-bridge/.build/apple/Products/Release/valet-bridge'
export const BRIDGE_EXECUTABLE = 'valet-bridge'

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
  readonly VALET_RELEASE?: string
  readonly VALET_TEAM_ID?: string
  readonly VALET_UPDATE_URL?: string
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
  /** @electron/osx-sign's signAsync, asked for only when a signed build actually signs. */
  readonly loadSignAsync: () => SignAsync
  /** Waits between signing attempts. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * The built main process (every .js under out/main, joined), or null when there is none. Read for
   * a release only, to check it was built for this release.
   */
  readonly readMainBundle: () => string | null
  /** Whether the Swift bridge has been built at SWIFT_BRIDGE_BUILD. */
  readonly bridgeBuilt: () => boolean
}

/**
 * A release packages whatever out/ holds, and the feed is compiled in by a separate `electron-vite
 * build`. So the release refuses an out/main that wasn't built as this release's: it must hold the
 * same feed URL electron-builder publishes to, and a feed public key, and must not be a smoke build.
 * Without this, a release built from an out/ made without the feed variables would ship with an
 * app-update.yml but an updater that says 'not-configured'.
 */
export function checkReleaseBundle(bundle: string | null, feedUrl: string): void {
  if (bundle === null)
    throw new BuildConfigError(
      'a release packages out/: run `electron-vite build` with VALET_RELEASE=1 first',
    )
  if (!bundle.includes(JSON.stringify(feedUrl)))
    throw new BuildConfigError(
      'out/main was not built with this VALET_UPDATE_URL: rebuild it with VALET_RELEASE=1 and the same feed variables',
    )
  if (!bundle.includes('-----BEGIN PUBLIC KEY-----'))
    throw new BuildConfigError('out/main has no feed public key: rebuild it with VALET_FEED_PUBLIC_KEY_FILE')
  if (bundle.includes(SMOKE_BUILD_MARKER))
    throw new BuildConfigError('out/main is a smoke build: rebuild it with a plain `electron-vite build`')
}

/**
 * electron-builder's default signing retries (macCodeSign.sign: retry with retries 3, interval and
 * backoff 5000 ms); a custom `mac.sign` replaces that, so the wrapper retries the same way. One
 * timestamp-server hiccup during `codesign --timestamp` of any nested binary would otherwise fail
 * the release.
 */
export const SIGN_RETRIES = 3
export const SIGN_RETRY_INTERVAL_MS = 5000
export const SIGN_RETRY_BACKOFF_MS = 5000

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

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
  if (!TEAM_ID.test(values.teamId)) throw new BuildConfigError('VALET_TEAM_ID must be 10 letters or digits')
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
export function signWithRequirement(
  loadSignAsync: () => SignAsync,
  requirement: string,
  sleep: (ms: number) => Promise<void> = realSleep,
) {
  return async (options: SignOptionsLike): Promise<void> => {
    const signAsync = loadSignAsync()
    const signOptions = {
      ...options,
      optionsForFile: (filePath: string) => {
        const base = options.optionsForFile?.(filePath) ?? {}
        return filePath === options.app
          ? { ...base, requirements: requirement }
          : { ...base, requirements: undefined }
      },
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await signAsync(signOptions)
        return
      } catch (error) {
        if (attempt >= SIGN_RETRIES) throw error
        await sleep(SIGN_RETRY_INTERVAL_MS + attempt * SIGN_RETRY_BACKOFF_MS)
      }
    }
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
  const releaseFlag = env.VALET_RELEASE
  if (releaseFlag !== undefined && releaseFlag !== '' && releaseFlag !== '0' && releaseFlag !== '1') {
    throw new BuildConfigError('VALET_RELEASE must be 1 for a release build, or unset')
  }
  const release = releaseFlag === '1'
  const appId = release ? RELEASE_APP_ID : DEV_APP_ID
  const productName = release ? RELEASE_PRODUCT_NAME : DEV_PRODUCT_NAME
  // File and package names: no capitals or spaces.
  const slug = release ? 'valet' : 'valet-dev'
  const identityGiven = set(env, 'CSC_NAME') || set(env, 'CSC_LINK')
  const canNotarise = notarisationCredentials(env)
  const teamId = env.VALET_TEAM_ID
  if (teamId !== undefined && teamId !== '' && !TEAM_ID.test(teamId)) {
    throw new BuildConfigError('VALET_TEAM_ID must be 10 letters or digits')
  }

  const rawFeed = env.VALET_UPDATE_URL
  const feedUrl =
    rawFeed === undefined || rawFeed === ''
      ? null
      : validateFeedUrl(rawFeed, { allowLoopbackHttp: !release, requirePublicHost: release })
  if (rawFeed !== undefined && rawFeed !== '' && feedUrl === null) {
    throw new BuildConfigError(
      release
        ? 'VALET_UPDATE_URL must be an https directory URL ending in "/" on a public host name (no IP, localhost or single label), with no query, fragment or credentials'
        : 'VALET_UPDATE_URL must be an https directory URL ending in "/", with no query, fragment or credentials',
    )
  }

  let requirement: string | null = null
  if (release) {
    if (!set(env, 'VALET_TEAM_ID')) throw new BuildConfigError('a release build needs VALET_TEAM_ID')
    if (feedUrl === null) throw new BuildConfigError('a release build needs VALET_UPDATE_URL')
    checkReleaseBundle(deps.readMainBundle(), feedUrl)
    if (!identityGiven) throw new BuildConfigError('a release build needs CSC_NAME or CSC_LINK')
    if (env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
      throw new BuildConfigError('a release build is signed: unset CSC_IDENTITY_AUTO_DISCOVERY=false')
    }
    // electron-builder takes the name without its "Developer ID Application: " prefix (it refuses
    // the prefix and searches Developer ID Application certificates only for a release), so the
    // name must be "<name> (<TEAM_ID>)" for the same team as the requirement, or a SHA-1.
    const name = env.CSC_NAME
    if (name !== undefined && name !== '' && !SHA1_IDENTITY.test(name)) {
      if (name.includes(':') || !name.endsWith(` (${teamId})`) || name.length <= ` (${teamId})`.length) {
        throw new BuildConfigError('CSC_NAME must be "<name> (VALET_TEAM_ID)", without a prefix, or a SHA-1')
      }
    }
    if (!canNotarise) {
      throw new BuildConfigError(
        'a release build is notarised: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER, or APPLE_KEYCHAIN_PROFILE',
      )
    }
    if (!deps.bridgeBuilt()) {
      throw new BuildConfigError(
        'a release ships the stdio bridge: run `swift build -c release --arch arm64 --arch x86_64 --package-path swift-bridge` first',
      )
    }
    requirement = renderRequirement(deps.readTemplate(RELEASE_REQUIREMENT_TEMPLATE), {
      appId,
      teamId: teamId as string,
    })
  } else if (identityGiven) {
    // For a non-MAS development build electron-builder searches both "Mac Developer" and "Developer
    // ID Application" certificates for a CSC_NAME (MacTargetHelper.getCertificateTypes), so a name
    // would find the Developer ID key, and a .dev bundle would carry the release signature. Only a
    // SHA-1 picks one certificate; a .p12 from CSC_LINK can't be checked, so it isn't accepted.
    if (set(env, 'CSC_LINK')) {
      throw new BuildConfigError(
        'a development build is signed from the keychain: unset CSC_LINK, set CSC_NAME',
      )
    }
    if (!SHA1_IDENTITY.test(env.CSC_NAME ?? '')) {
      throw new BuildConfigError(
        'a development build takes CSC_NAME as the SHA-1 of an Apple Development identity (security find-identity -v -p codesigning)',
      )
    }
    if (teamId !== undefined && teamId !== '') {
      requirement = renderRequirement(deps.readTemplate(DEV_REQUIREMENT_TEMPLATE), { appId, teamId })
    }
  }

  // A dev build without an explicit identity is never signed, rather than electron-builder finding
  // the Developer ID key in the login keychain by itself. The fuse flip then re-signs it ad hoc,
  // which Apple silicon needs to run a modified binary at all.
  const signs = release || identityGiven

  return {
    appId,
    productName,
    directories: { output: 'dist', buildResources: 'build' },
    // electron-vite's output, and the external modules it loads. No source maps, tests, fixtures,
    // scripts or bundled dependencies in the package.
    files: [
      'out/main/**/*',
      'out/preload/**/*',
      'out/renderer/**/*',
      'package.json',
      '!**/*.map',
      '!node_modules/**/*',
      ...PACKAGED_NODE_MODULES.map((name) => `node_modules/${name}/**/*`),
    ],
    // The packaged package.json names the app, which sets userData, the cookie-encryption Keychain
    // item, the single-instance lock and electron-updater's cache directory: dev and release must
    // differ there too.
    extraMetadata: { name: slug, productName },
    // Into Contents/MacOS, signed with the app. A development build without it shows no snippets.
    extraFiles: deps.bridgeBuilt() ? [{ from: SWIFT_BRIDGE_BUILD, to: `MacOS/${BRIDGE_EXECUTABLE}` }] : [],
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
      // The escaped ${...} are electron-builder's own macros.
      artifactName: `${slug}-\${version}-\${arch}.\${ext}`,
      ...(signs ? {} : { identity: null }),
      type: release ? 'distribution' : 'development',
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS_PATH,
      entitlementsInherit: ENTITLEMENTS_INHERIT_PATH,
      // The signed entitlements are exactly the files above.
      preAutoEntitlements: false,
      ...(requirement === null
        ? {}
        : { sign: signWithRequirement(deps.loadSignAsync, requirement, deps.sleep) }),
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

/**
 * The real effects: templates from build/, and @electron/osx-sign (a direct devDependency, the same
 * version electron-builder's default signing uses: one copy in the lockfile).
 */
export const nodeDeps: ConfigDeps = {
  readTemplate: (name) => readFileSync(join(here, 'build', name), 'utf8'),
  loadSignAsync: () => signAsync as unknown as SignAsync,
  readMainBundle: () => readBundle(join(here, 'out', 'main')),
  bridgeBuilt: () => existsSync(join(here, SWIFT_BRIDGE_BUILD)),
}

/** Every .js file under `dir`, joined, or null when `dir` has no index.js. */
export function readBundle(dir: string): string | null {
  if (!existsSync(join(dir, 'index.js'))) return null
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

export default function config(): Configuration {
  return createBuilderConfig(process.env, nodeDeps)
}
