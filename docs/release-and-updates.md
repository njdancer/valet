# Releases, signing and updates

Draft. How the macOS app is built, signed, notarised, published and updated. It covers
[WS9](plan.md#ws9-packaging-and-updates), answers [D23](plan.md#d23-update-feed-host), and is what
M3's "a release is one command" and M4's auto-update need. The security rules it has to keep are
in [security-model.md](security-model.md).

Versions checked against the lockfile: electron 44.10.2, electron-builder 26.18.0 (with
`@electron/osx-sign` 1.3.3 and `@electron/notarize` 2.5.0), electron-updater 6.8.11. Behaviour
quoted from those packages was read from their installed source. Apple tooling behaviour is from
memory as of November 2026; anything marked _verify_ must be checked on the first real build.

## Summary

- **Identity first.** The bundle ID and Team ID are what Keychain items, Full Disk Access and the
  updater's signature check are tied to. Fix the bundle ID before the first signed build
  ([D1](plan.md#d1-product-name)). Development builds get a _different_ bundle ID and different
  Keychain service names, so an honest dev build never asks for the production 1Password token.
  Against a dev build an agent has changed on purpose, the control is access to the signing key,
  not the bundle ID ([Identity](#identity)).
- **Signing:**
  - Developer ID, hardened runtime, and one entitlement (`allow-jit`).
  - Electron fuses that turn off the Node-level ways of running other code as the app
    (`runAsNode`, `NODE_OPTIONS`, `--inspect`).
  - A strict command-line allowlist, first thing in main, for the Chromium and Electron switches
    no fuse covers (`--remote-debugging-port`, `--host-resolver-rules`, …). Not built yet; see
    [Command-line switches](#command-line-switches).
  - An explicit designated requirement on the outer bundle only, through a `sign` wrapper like
    the earlier app's.

  Without the fuses and the switch allowlist, the designated requirement protects little: any
  local process could run JavaScript _as_ siteadapter, or drive its renderers over the DevTools
  protocol, and read what the app can read.
- **Notarisation:** `notarytool` with an App Store Connect API key. Locally it's a `notarytool`
  Keychain profile on Nick's Mac; in CI, the key comes from the environment. The release script
  also notarises and staples the DMG.
- **Updates:**
  - electron-updater against a static feed on a domain Nick controls (R2 behind
    `updates.<domain>`), not GitHub Releases, before and after the repo goes public.
  - Squirrel.Mac should refuse an update not signed with the same designated requirement. That's
    its documented behaviour, but it's _verify_ for Electron 44, and the updater E2E test's first
    two attack rows are what confirm it.
  - On top of that, the feed's metadata is signed with an offline Ed25519 key and carries an
    expiry and a version floor, which stops downgrade and freeze attacks the stock updater
    allows. The controller refuses to enable updates without the feed key, and every request
    electron-updater makes, redirect hops included, is confined to the feed base.
- **Channels:** `latest` and `beta`. Rollback means rolling forward.
- **Updater test:** end to end against a local fake update server, including the attacks.

## Identity

| Identity                  | Release builds                              | Development builds                                     |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| Bundle ID                 | `me.dncr.siteadapter` (D1)                  | `me.dncr.siteadapter.dev`                              |
| Signing certificate       | Developer ID Application                    | Apple Development, or ad hoc                           |
| Keychain service names    | `siteadapter.*`                             | `siteadapter-dev.*`                                    |
| `userData` and partitions | `~/Library/Application Support/siteadapter` | `…/siteadapter-dev`                                    |
| 1Password vault           | `siteadapter`                               | a separate vault with test items, or the fake provider |

Why separate: an honest local build, including code an agent changed on a `wip/*` branch, then
never touches production data by accident. What actually keeps a _dishonest_ build away from the
production token is different, and depends on where the token is read:

- **In v0**, the token is read through `/usr/bin/security`
  ([security-model.md](security-model.md#the-service-account-token)), so the Keychain sees Apple's
  tool, not the app, and the bundle ID plays no part. What keeps a dev build away from the
  production item is only that it asks for `siteadapter-dev.*`, not `siteadapter.*`. An agent's
  change can rename that back, and the resulting prompt names `security` either way. So in v0
  there is no technical control: allow the prompt only when you've just started the release app
  yourself, and deny one you didn't expect.
- **Once the read moves in process**, the item's ACL is the release designated requirement. A
  changed build satisfies it only if it has the release bundle ID _and_ a Developer ID signature
  from Nick's team. An agent can set the bundle ID back to `me.dncr.siteadapter` in one line. So
  the real control is **access to the Developer ID private key**: if `codesign` can use it without
  asking, any process running as Nick can sign a build that passes.

So the signing material needs per-use approval, not "Always Allow":

- **Developer ID private key:** not in the login keychain. Keep it in a separate keychain that is
  locked except during a release (with a short auto-lock), or on a hardware token (a smart card or
  YubiKey identity via CryptoTokenKit; _verify_ that `codesign` signs with one cleanly). Never
  click "Always Allow" for `codesign` on it.
- **The feed key** ([Signed feed metadata](#signed-feed-metadata)): a passphrase-protected file
  or a hardware key, never stored unlocked.
- **The notary profile and the R2 upload token:** the same separate release keychain, not the
  login keychain. Neither can sign an app, but the R2 token can replace the feed and the notary
  key can get anything notarised under the team's name.

The release script unlocks the release keychain at the start and locks it again on exit, success
or failure.

Changing either the bundle ID or the Team ID after release orphans every Keychain item and Full
Disk Access grant ([R12](plan.md#risk-register)).

## electron-builder

The configuration is [`apps/desktop/electron-builder.config.ts`](../apps/desktop/electron-builder.config.ts)
(electron-builder loads a TypeScript config through jiti when it is named with `--config`). It is
the one place the app's identity is written: the bundle IDs, product names, signing, the
designated requirement, the fuses, the entitlements files and the feed. It exports
`createBuilderConfig(env, deps)`, a pure function of the environment that throws `BuildConfigError`
before electron-builder runs if a release would come out weaker than intended, and
`test/updater/packaging.test.ts` holds every choice below in place.

```bash
# Development build, unsigned: works with no Apple account at all.
CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac --dir --config electron-builder.config.ts

# Release build (the release script sets these; no key is in the repo or the environment file).
SITEADAPTER_RELEASE=1 SITEADAPTER_TEAM_ID=<TEAM_ID> SITEADAPTER_UPDATE_URL=https://updates.<domain>/mac/ \
CSC_NAME="<name> (<TEAM_ID>)" APPLE_KEYCHAIN_PROFILE=siteadapter-notary \
electron-builder --mac --config electron-builder.config.ts --publish never
```

What the environment decides:

| Variable                                                | Release (`SITEADAPTER_RELEASE=1`)                                                                                                                                                    | Development (unset or `0`)                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle ID, product name                                 | `me.dncr.siteadapter`, `siteadapter`                                                                                                                                                 | `me.dncr.siteadapter.dev`, `siteadapter-dev`                                                                                                              |
| `SITEADAPTER_TEAM_ID`                                   | Required, 10 letters or digits; fills the designated requirement                                                                                                                     | Optional; with an identity, fills the dev requirement                                                                                                     |
| `SITEADAPTER_UPDATE_URL`                                | Required: https to a public host name (no IP literal, `localhost`, single label or `.local`/`.internal`-style name), a directory (`/` at the end), no query, fragment or credentials | Optional; http to `127.0.0.1` also allowed, for a local feed                                                                                              |
| `CSC_NAME` or `CSC_LINK`                                | Required. `CSC_NAME` must be `<name> (<TEAM_ID>)` (no prefix) or a SHA-1                                                                                                             | Optional. `CSC_NAME` only, as the SHA-1 of an Apple Development identity; `CSC_LINK` refused. Without one the build is unsigned: `mac.identity` is `null` |
| `CSC_IDENTITY_AUTO_DISCOVERY=false`                     | Refused                                                                                                                                                                              | Allowed (and has the same effect as naming no identity)                                                                                                   |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | All three, or `APPLE_KEYCHAIN_PROFILE`, required: release builds are notarised                                                                                                       | Ignored: development builds are never notarised                                                                                                           |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`               | Refused (electron-builder would prefer the Apple ID over an API key)                                                                                                                 | Refused                                                                                                                                                   |

The parts of the configuration that matter, as `createBuilderConfig` returns them for a release:

```js
{
  appId: 'me.dncr.siteadapter', // RELEASE_APP_ID; D1 pending
  productName: 'siteadapter',
  extraMetadata: { name: 'siteadapter', productName: 'siteadapter' }, // app.getName(), userData, updater cache
  directories: { output: 'dist', buildResources: 'build' },
  files: ['out/**/*', 'package.json', '!**/*.map'], // electron-vite's output only
  asar: true,
  npmRebuild: false,
  forceCodeSigning: true, // release only: an unsigned release fails rather than shipping
  electronFuses: {
    runAsNode: false, // ELECTRON_RUN_AS_NODE would run any script as the signed app
    enableNodeOptionsEnvironmentVariable: false, // NODE_OPTIONS=--require …
    enableNodeCliInspectArguments: false, // --inspect, and SIGUSR1 opening the inspector
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true, // with the above: no app/ folder swapped in beside the asar
    enableCookieEncryption: true, // cookies at rest encrypted with a Keychain key; one-way
    grantFileProtocolExtraPrivileges: false, // so the renderer is served from app://, never loadFile
    loadBrowserProcessSpecificV8Snapshot: false,
    resetAdHocDarwinSignature: false, // true only for an unsigned development build
  },
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }, // Squirrel.Mac updates from the zip, never the DMG
    ],
    artifactName: '${productName}-${version}-${arch}.${ext}', // "arm64" in the name picks the zip
    type: 'distribution',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    preAutoEntitlements: false, // the signed entitlements are exactly the files above
    sign: signWithRequirement(…), // the designated requirement on the outer bundle only; see below
    notarize: true, // credentials from the environment; see "Notarisation"
    gatekeeperAssess: false, // the release script runs spctl itself, after stapling
    extendInfo: { LSUIElement: true }, // menu-bar app: no Dock icon
  },
  dmg: { sign: false }, // signed, notarised and stapled by the release script
  publish: [{ provider: 'generic', url: SITEADAPTER_UPDATE_URL }], // no channel: see "Channels"
  generateUpdatesFilesForAllChannels: true, // so beta users are offered newer stable releases
}
```

Notes on choices that aren't obvious:

- **arm64 and x64.** Both zips go in one `latest-mac.yml`; electron-updater picks the one for the
  machine by whether its name contains `arm64` (`MacUpdater.filterFilesForArch`), which is why the
  artifact name carries the architecture. A universal build would double every download. x64 isn't
  smoke-tested yet: there is no x64 Electron in the local cache, and fetching one needs the network.
- **No `mac.requirements`.** electron-builder gives `mac.requirements` to every nested binary, whose
  own identifiers can't satisfy it. Instead the config's `signWithRequirement` wraps the
  `@electron/osx-sign` that electron-builder itself uses and passes the requirement inline
  (`-r=designated => …`) for the outer `.app` only. No requirement file is written to disk.
  `@electron/osx-sign` isn't a dependency of `apps/desktop`, so the wrapper reaches electron-builder's
  own copy through `createRequire`; making it a direct devDependency would be cleaner. A custom
  `mac.sign` replaces electron-builder's default signing, retries included, so the wrapper retries
  the same way (three retries, 5 s apart plus 5 s of backoff each time): one timestamp-server
  hiccup during `codesign --timestamp` of any of the nested binaries would otherwise fail the
  release.
- **No channel in `publish`.** electron-builder takes the channel from the version
  (`1.3.0-beta.1` publishes to `beta`). A `channel: 'latest'` there would publish betas to stable.
- **Development builds.** A different bundle ID and product name (so a different `userData`,
  cookie-encryption Keychain item, single-instance lock and Full Disk Access grant). Without an
  explicit `CSC_NAME`/`CSC_LINK` they are never signed, rather than electron-builder finding the
  Developer ID key in the login keychain on its own, and `resetAdHocDarwinSignature` re-signs the
  bundle ad hoc after the fuse flip, because Apple silicon refuses to run a modified binary with a
  broken signature. A dev build signed with an Apple Development identity and `SITEADAPTER_TEAM_ID`
  gets `build/designated-requirement.dev.txt`, which pins the team and the WWDR intermediate for the
  `.dev` bundle ID.
- **A dev build's identity is a SHA-1, never a name.** For a non-MAS `type: 'development'` build,
  electron-builder searches both "Mac Developer" and "Developer ID Application" certificates for
  `CSC_NAME` (`MacTargetHelper.getCertificateTypes`), so a name in the release's
  `<name> (<TEAM_ID>)` form would find the Developer ID key, and the `.dev` bundle would carry the
  release key's signature (or, with `SITEADAPTER_TEAM_ID`, fail at verify against the dev
  requirement). The config takes a dev `CSC_NAME` only as the 40-character SHA-1 of an Apple
  Development identity (`security find-identity -v -p codesigning`), and refuses `CSC_LINK` for
  dev builds, since what a `.p12` holds can't be checked before electron-builder imports it.
- **`grantFileProtocolExtraPrivileges` off, so no `loadFile`.** With the fuse off, a `file://`
  page gets only what a browser gives it, and Vite's `<script type="module">` never runs there
  (checked on Electron 44.10.2 with only this fuse flipped; dropping `crossorigin` doesn't help).
  The renderer is served from a privileged custom scheme instead,
  [`src/main/updater/app-scheme.ts`](../apps/desktop/src/main/updater/app-scheme.ts) (in the
  packaging unit's directory for now; the main process adopts it):
  `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])`
  before `ready`, then `protocol.handle('app', createAppSchemeHandler({ root: <appPath>/out/renderer, readFile }))`
  and `loadURL('app://renderer/index.html')`. The handler answers only `app://renderer/…`, only
  GET and HEAD, only files under the root with an extension the build emits (no `.map`), with a
  fixed `content-type` and `nosniff`, and 404s anything else: other hosts, query strings, dot,
  hidden or encoded-separator segments. The renderer's CSP `'self'` is then `app://renderer`.
- **`enableCookieEncryption`: decided on, and one-way.** Without it, the `auth:` and `tool:`
  partitions' cookies (live site sessions) sit in plaintext SQLite under `userData`, readable and
  replayable by any process running as the person. With it, Chromium encrypts them with a key in a
  Keychain item named after the app (`siteadapter Safe Storage`, `siteadapter-dev Safe Storage`),
  whose ACL is the app's designated requirement: one more reason the requirement must be stable.
  Turning it off later makes the existing store unreadable, so it is on from the first build. Nick
  can still reverse this before any real session exists ([Open questions](#open-questions)).
- **`preAutoEntitlements: false`.** `@electron/osx-sign` can add entitlements on its own. The
  release check compares the signed entitlements with the files anyway; this makes them agree.
- **`files` and `main`.** Only `out/**` and `package.json` are packaged. The packaged
  `package.json` needs a `main` pointing at electron-vite's main bundle; `apps/desktop/package.json`
  doesn't have one yet (the main process is being written). The workspace packages export
  TypeScript source, which Electron won't load from `node_modules`, so the main build must bundle
  them; electron-builder still copies production `dependencies` into the asar unless the main build
  makes them unnecessary and `files` says so. The main process bundles everything except Electron,
  Node built-ins and `@1password/sdk` (loaded lazily, with a wasm file beside it), so `files` can't
  simply exclude `node_modules`; narrowing it to the SDK needs a real build of the main process to
  check, and none has been packaged yet.
- **Typechecking.** `tsc --noEmit -p apps/desktop/src/main/updater` checks the updater, the app://
  scheme and `electron-builder.config.ts` in plain Node, with no DOM; `-p apps/desktop` reaches
  them too, through the tests.

### What a development build looks like

`node scripts/package-smoke.mjs [--target zip]` packages a placeholder main process with this
config, unsigned, in a temporary directory, inspects the result and launches it. It passes none of
the caller's `CSC_*`, `APPLE_*` or `SITEADAPTER_*` variables to electron-builder, launches with a
temporary `--user-data-dir` and Chromium's mock keychain, and deletes everything afterwards, pass
or fail. Every item below is asserted: a mismatch is listed under `failures` and the script's exit
code is 1. It builds from a copy-on-write clone of the installed Electron with `default_app.asar`
removed, because electron-builder skips its own clean-up when given `electronDist`, and the bundle
should match what a release (which downloads Electron) contains. On electron-builder 26.18.0 and
Electron 44.10.2 (arm64), 2026-11-07:

- `siteadapter-dev.app`: `CFBundleIdentifier` `me.dncr.siteadapter.dev`, `LSUIElement` true,
  `ElectronAsarIntegrity` for `Resources/app.asar` only; the asar holds exactly the placeholder's
  `out/**` files and `package.json`, and no source map; no `Resources/app` folder and no
  `default_app.asar`.
- The placeholder's renderer page, a module script that sets the title, in a hidden window:
  served from `app://` through `app-scheme.ts` (the real file, types stripped), the script runs;
  the same page through `loadFile` never runs it.
- The fuse wire in `Electron Framework` reads exactly as configured. Electron 44's wire has a
  ninth fuse that `@electron/fuses` 1.8.0 doesn't name; it is left as Electron ships it (on).
- Signature: ad hoc (`flags=0x2(adhoc)`, no Team ID, no hardened runtime, no entitlements), as an
  unsigned dev build should be. Entitlements and the requirement are only applied by a signed build.
- Launched with `ELECTRON_RUN_AS_NODE=1 … -e <script>`: starts as the app, the script never runs.
  With `NODE_OPTIONS=--require <script>`: the script never runs. With `--inspect=0`: no inspector.
- One byte of the main process's code changed inside `app.asar`: exits 1 at start with an
  integrity error. Integrity is checked per file as it is read, so a change to a file the app never
  reads isn't noticed until it is.
- `app.asar` moved away and an `app/` folder put in its place: exits 1, the folder's code never
  runs.
- `--target zip`: electron-builder writes `latest-mac.yml`, `beta-mac.yml` and `alpha-mac.yml`, and
  its `latest-mac.yml` has the same fields as `scripts/make-feed.mjs` writes for the same zip.
  `app-update.yml` (only written for zip or dmg targets, not `--dir`) holds the feed URL and
  `updaterCacheDirName`.

## Entitlements

[`build/entitlements.mac.plist`](../apps/desktop/build/entitlements.mac.plist), and the same for
`entitlements.mac.inherit.plist` (the helpers: renderer, GPU, plugin). Both, without their header
comments:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- V8 generates code at run time. -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
```

- **Start with `allow-jit` only.** Current Electron needs nothing else under the hardened runtime
  as far as we know (_verify_ on the first signed build). If a helper crashes at launch, add
  `com.apple.security.cs.allow-unsigned-executable-memory` to the inherit file only, and write
  down which helper and why.
- **Never add these.** Each one lets other code run as the app, which defeats the designated
  requirement:
  - `com.apple.security.cs.disable-library-validation`: loads dylibs signed by anyone;
  - `com.apple.security.cs.allow-dyld-environment-variables`: `DYLD_INSERT_LIBRARIES`;
  - `com.apple.security.get-task-allow`: lets a debugger attach;
  - `com.apple.security.cs.debugger`.
- **No App Sandbox.** Electron with child processes, Chromium partitions, the Keychain and a
  Messages helper doesn't fit Apple's app sandbox without a large rework, and the app isn't
  headed for the Mac App Store. The process-level containment that matters is the adapter
  sandbox ([registry-and-sandbox.md](registry-and-sandbox.md#the-sandbox)).
- **Full Disk Access is not an entitlement.** It's a person's grant in System Settings, keyed by
  the designated requirement of the binary that asks. [D8](plan.md#d8-full-disk-access-for-messages)
  recommends a small signed helper that reads Messages, so FDA isn't granted to the whole app.
  Its requirement must be stable across updates too.

`apps/desktop/test/updater/packaging.test.ts` parses the config and both plists in plain Node, and
fails if:

- either plist holds any key but `allow-jit` (so any forbidden entitlement, or the App Sandbox);
- a fuse is missing or flipped, in release or development;
- `hardenedRuntime`, `forceCodeSigning` or `notarize` is turned off for a release;
- a release can be configured without a Team ID, an https feed, a Developer ID identity from that
  team, or notarisation credentials.

Still to add, with the main process: a check that main's first statement is the command-line
check ([below](#command-line-switches)). The test runs in `pnpm check`, which is where a
"temporary" entitlement would otherwise slip in.

## The designated requirement

[`build/designated-requirement.txt`](../apps/desktop/build/designated-requirement.txt) is a
template; the config fills `__BUNDLE_ID__` from `RELEASE_APP_ID` and `__TEAM_ID__` from
`SITEADAPTER_TEAM_ID` (10 letters or digits, so it can't rewrite the requirement), drops the
comments, and hands the result to codesign inline for the outer bundle:

```
designated => identifier "__BUNDLE_ID__" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "__TEAM_ID__"
```

It says: this bundle ID, chained to Apple, with a Developer ID intermediate and a Developer ID
Application leaf, issued to this team. For a release, the config accepts only a `CSC_NAME` of
the form `<name> (<TEAM_ID>)` with the same Team ID (electron-builder adds the certificate type
itself and searches Developer ID Application certificates only), or a SHA-1 hash, so the
requirement and the signature can't name different teams.

**What's honestly new here, and what isn't.**

- For a Developer ID signature, codesign's _default_ designated requirement is, as far as we
  know, already this string (_verify_ with `codesign -d -r-` on the first signed build). So for
  release builds the explicit file mostly makes the requirement visible, reviewed and checked,
  rather than changing it.
- The earlier app needed its file for a different reason. It's signed with an **Apple Development**
  certificate, whose default requirement pins the certificate's common name. Its file pins the
  Team ID and the Apple Worldwide Developer Relations intermediate (`…6.2.1`) instead.
- siteadapter's release file pins the Developer ID intermediate (`…6.2.6`) and leaf (`…6.1.13`).
  That's deliberate: an Apple Development-signed build of the same bundle ID does _not_ satisfy
  it.
- The Team ID comes from `SITEADAPTER_TEAM_ID`, which the release script sets. The earlier app's
  `scripts/require-signing-identity.ts` derives it from the signing identity instead; the release
  script could do the same and export it, so it isn't hand-copied.
- Development builds signed with an Apple Development identity use
  `build/designated-requirement.dev.txt` (the WWDR intermediate `…6.2.1`, the team, the `.dev`
  bundle ID), so their own Keychain items survive certificate renewals too.

**What it buys:**

- Keychain items the app creates trust this requirement, so "Always Allow" survives updates and
  certificate renewals.
- Full Disk Access survives updates too.
- Squirrel.Mac checks every update against the running app's requirement
  ([below](#how-an-update-is-trusted)).

**What it doesn't buy, yet:**

- The v0 token source reads the Keychain through `/usr/bin/security`, so the ACL check is against
  Apple's tool, not this app ([security-model.md](security-model.md#the-service-account-token)).
- The requirement starts protecting the 1Password token only once the read moves in process.
  Until then, never click "Always Allow" on the `security` prompt.

## Command-line switches

The fuses close the Node-level ways in. They don't cover Chromium's or Electron's own
command-line switches: `@electron/fuses` 1.8.0 has fuses only for `RunAsNode`,
`CookieEncryption`, `NodeOptions`, `NodeCliInspect`, `AsarIntegrity`, `OnlyLoadAppFromAsar`,
`V8Snapshot` and `FileProtocol`. Any local process can start the signed app with switches, and
some of them hand it the app's secrets without touching the signature:

| Switch                                                                     | What it gives a local attacker                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--remote-debugging-port`, `--remote-debugging-pipe`                       | The DevTools protocol into every renderer, including the `auth:` page while the password is typed into it, and `Network.getAllCookies` for both partitions (cookie encryption at rest doesn't help: CDP reads them decrypted)                             |
| `--host-resolver-rules`, `--host-rules` with `--ignore-certificate-errors` | `auth.woolworths.com.au` resolved to a server the attacker runs, with its certificate accepted. The page's origin still reads `https://auth.woolworths.com.au`, so the secret-fill origin check passes and the password is typed into the attacker's page |
| `--proxy-server`, `--proxy-pac-url`, `--proxy-*`                           | All traffic through the attacker's proxy (combined with the above, readable)                                                                                                                                                                              |
| `--js-flags`                                                               | V8 flags in every renderer, some of which disable mitigations                                                                                                                                                                                             |
| `--user-data-dir`                                                          | The app running against a profile the attacker prepared                                                                                                                                                                                                   |
| `--inspect*`                                                               | Covered by the `NodeCliInspect` fuse, but refused here as well                                                                                                                                                                                            |

So nothing in the trusted path may depend on argv being benign, and the app must refuse to run
with any switch it didn't expect:

- **An allowlist, not a blocklist.** Main's first statement, before `app` is ready, before the
  single-instance lock, and before the bridge dispatch below, checks `process.argv` against
  exactly two shapes:
  - the executable alone (a normal launch);
  - the executable, `--mcp-bridge`, and one absolute path (`/…`) as a separate argument.

  Anything else exits at once with a fixed message and a non-zero status: an extra argument, a
  switch before or after the path, `--mcp-bridge=<path>`, a relative path, a path starting with
  `-`, a bare `--`, and any other spelling of a switch. Chromium also accepts switches with a
  single `-` prefix, so a blocklist of names would miss `-remote-debugging-port=9222`; an
  allowlist doesn't have to know.
- **A pure function, tested in `pnpm check`.** `classifyArgv(argv)` returns `{ mode: 'app' }`,
  `{ mode: 'bridge', config }` or `{ mode: 'refuse' }`, and the unit tests try to get past it:
  each switch in the table, single-dash and `=value` forms, upper-case `--MCP-BRIDGE`, the bridge
  flag twice, a switch hidden after the config path, an empty string argument, a path containing
  `\0`, and macOS's historical `-psn_…` process-serial argument (_verify_ whether LaunchServices
  still passes it on current macOS; if it does, allow exactly that shape and nothing like it).
- **Relaunches keep the shape.** `app.relaunch()` defaults to the current arguments, which are
  already allowed. Never pass it extra switches.
- **Environment variables too.** Electron reads some `ELECTRON_*` variables at start-up. The two
  that run code are fused off; the check also refuses to start if any `ELECTRON_*` or `NODE_*`
  variable outside a short reviewed list is set (_verify_ the list against Electron 44's docs).

**What the check can't do.** Chromium parses its switches before any JavaScript runs. Some of them
act before main's first line: `--js-flags` is applied as V8 starts, and the DevTools listener for
`--remote-debugging-port` may open during browser start-up (_verify_ the order in Electron 44).
Exiting in main means no window, no partition and no secret ever exists in such a process, which
is what matters, but it is detection plus early exit, not prevention. A `--remote-debugging-*`
listener that is up for a few hundred milliseconds in a process that has loaded nothing is
acceptable; one that's up while a window exists is not.

**Release check.** After the codesign checks, the release script launches the built app once per
row of the table above, plus `--mcp-bridge` with a relative path, and asserts that each exits
non-zero within two seconds without creating a window or a file under `userData`, and that
nothing answers on the requested debugging port. A build that keeps running with any of them
doesn't ship.

Until this exists, the Keychain and designated-requirement story above has a hole: any process
running as the person can drive the signed app, and the app's own code-signature checks don't
see it.

## The stdio bridge

MCP clients launch the bridge (`siteadapter-bridge <config file>`) as a command. The usual Electron
trick is to run the app binary with `ELECTRON_RUN_AS_NODE=1`. That needs the `runAsNode` fuse,
and that fuse lets any process run any script with the app's signature, Keychain access included.
So it stays off. Options:

| Option                                                                                                 | Cost                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bridge mode in the app binary:** `siteadapter --mcp-bridge <config>`, dispatched first thing in main | No new identity, no new runtime. Starts Electron for each client launch (a few hundred ms). Runs only our bridge code, so the fuses still hold. |
| A Node single-executable application, signed as a helper                                               | A second Node runtime in the bundle (about 100 MB), its own identifier and requirement, its own `allow-jit`                                     |
| A small native bridge (Swift)                                                                          | Small and fast, but a second implementation of the MCP client side to maintain                                                                  |

Recommendation: bridge mode in the app binary.

- **This departs from [WS9](plan.md#ws9-packaging-and-updates)**, which says to bundle the stdio
  bridge as a signed helper. A helper is either a second Node runtime (the second row) or needs
  `runAsNode` (which the fuses forbid). Bridge mode keeps one identity and one runtime, at the
  cost of an Electron start per client launch and of making argv part of the trusted path. It's
  listed for Nick in [Open questions](#open-questions).
- The main process dispatches on the result of the command-line check
  ([above](#command-line-switches)), which runs before anything else: before the single-instance
  lock, the tray, or any window. Bridge mode is reached only when argv is exactly
  `--mcp-bridge <absolute path>`.
- In bridge mode it runs `runBridge` and nothing else: no window, no partition, no credential
  code.
- Claude Desktop's config then points at `/Applications/siteadapter.app/Contents/MacOS/siteadapter`
  with those arguments.

Revisit if start-up time annoys in practice.

## Notarisation

electron-builder notarises the app through `@electron/notarize` when `mac.notarize` is true and
one of three sets of environment variables is present (from its schema):

1. `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`;
2. `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`;
3. `APPLE_KEYCHAIN_PROFILE` (and optionally `APPLE_KEYCHAIN`), a profile stored by `notarytool`.

Use an **App Store Connect team API key** with the Developer role, not Nick's Apple ID. The key is
scoped and revocable, and doesn't trip two-factor prompts.

- **On Nick's Mac:** store it once in the Keychain and delete the downloaded file. The release
  script then sets only `APPLE_KEYCHAIN_PROFILE=siteadapter-notary`. Nothing secret is in the repo,
  the shell history or an environment file.

  ```bash
  xcrun notarytool store-credentials siteadapter-notary \
    --key ~/Downloads/AuthKey_ABC123XYZ.p8 --key-id ABC123XYZ --issuer <issuer-uuid>
  rm -P ~/Downloads/AuthKey_ABC123XYZ.p8
  ```

- **In CI (later):** the `.p8` is a secret written to a temporary file; set option 1's variables.
  See [CI](#ci-when-the-repo-is-public).

electron-builder notarises and staples the `.app` before building the DMG and zip. The DMG itself
is left unsigned (its schema warns that `dmg.sign` conflicts with notarisation). The release
script signs, notarises and staples it afterwards, so a DMG opened offline still passes
Gatekeeper:

```bash
codesign --sign "Developer ID Application: <name> (<TEAM_ID>)" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile siteadapter-notary --wait
xcrun stapler staple "$DMG"
```

## The release script

`pnpm release <version>`: one command on Nick's Mac, as M3 requires. It refuses to start unless:

- the working tree is clean;
- it's on `main`;
- the tag doesn't exist yet;
- `pnpm check` passes.

Then, stopping at the first failure:

1. Set the version, build with electron-vite, then, with the release variables above set,
   `electron-builder --mac --config electron-builder.config.ts --publish never`.
2. **Verify the app before anything leaves the machine:**

   ```bash
   APP=dist/mac-arm64/siteadapter.app
   codesign --verify --deep --strict --verbose=2 "$APP"
   codesign -d -r- "$APP"                       # same requirement as the rendered template
   codesign -d --entitlements - --xml "$APP"    # same entitlements as build/entitlements.mac.plist
   pnpm exec electron-fuses read --app "$APP"   # every fuse as configured
   xcrun stapler validate "$APP"
   spctl --assess -vvv --type exec "$APP"       # expect "source=Notarized Developer ID"
   ```

   "Same" means compared after parsing, never byte for byte. The source plist has a comment and
   indentation and codesign's XML has neither, and `codesign -d -r-` prints a `designated =>`
   prefix with its own spacing. So the script:
   - converts both entitlement plists to JSON (`plutil -convert json -o - <file>`, the signed one
     written to a temporary file first) and compares the parsed objects;
   - strips the `designated =>` prefix and `/* … */` comments from both requirement texts,
     collapses runs of whitespace to one space, and compares the results;
   - fails on any difference and prints both sides.

   Then the command-line refusal checks ([Command-line switches](#command-line-switches)).

3. Sign, notarise and staple the DMG (above), then
   `spctl --assess -vvv --type open --context context:primary-signature "$DMG"`.
4. Write and sign the feed envelope ([below](#signed-feed-metadata)).
5. Upload in order:
   1. the zip, blockmap and DMG, under versioned names that are never overwritten;
   2. `latest-mac.yml` (or `beta-mac.yml`);
   3. the signed envelope, last.

   Clients only see the new release once the last file lands, and everything it points at
   already exists. A client that checks between steps 2 and 3 gets a new yml with the old
   envelope, whose hash doesn't match, so that check fails closed and the next one succeeds.
6. Tag the commit and keep the build log.

The upload uses R2's S3-compatible API with a token scoped to the one bucket. That token lives in
the release keychain with the notary profile ([Identity](#identity)), not the login keychain.
Versioned files get `Cache-Control: public, max-age=31536000, immutable`; the yml and envelope
get `no-cache`.

## Auto-update

### Feed host

- **GitHub Releases** needs a public repo. A private repo would need a token inside the app, which
  is unacceptable (D23).
- **A static feed** with electron-updater's `generic` provider works today: R2 (or any static
  host) behind a domain Nick controls, such as `https://updates.<domain>/mac/`.
- Recommendation: **the static feed, on Nick's own domain, permanently.** Going public doesn't
  need a provider change:
  - every installed build has its feed URL compiled into its signed asar (`FEED_BASE_URL`,
    [below](#signed-feed-metadata)), so changing provider means keeping the old feed alive until
    every install has moved;
  - with a domain Nick controls, the host behind it can change without any client knowing;
  - GitHub Releases can still carry the DMG for people downloading by hand.

### How an update is trusted

From electron-updater 6.8.11's source and Squirrel.Mac's documented behaviour:

1. electron-updater fetches `latest-mac.yml` over HTTPS and compares its `version` with the
   running app's. With `allowDowngrade` false (the default), it only accepts a higher version.
2. It downloads the zip and checks its SHA-512 against the yml.
3. It serves the zip to Squirrel.Mac through a temporary `127.0.0.1` server with a random
   basic-auth password and a random path.
4. **Squirrel.Mac checks the new bundle's code signature against the running app's designated
   requirement** before installing it (_verify_ with the negative test below). This is the check
   that makes "the updater refuses an update signed by anyone else" (WS9) true.

Steps 1 and 2 protect against corruption, not an attacker: the yml and the zip come from the same
place. Step 4 is the real authenticity check. **What an attacker who controls the feed (a leaked
bucket token, a hijacked domain) can still do with the stock updater:**

- **Downgrade:** publish a yml claiming version 99.0.0 whose zip is an _old_, genuinely signed
  build with a known hole. Steps 1, 2 and 4 all pass, because the version in the yml isn't
  authenticated and Squirrel.Mac doesn't compare versions.
- **Freeze:** keep serving yesterday's yml forever, so a security fix never arrives.
- **Track:** electron-updater sends an `x-user-staging-id` header, a persistent per-install
  UUID, on every check. The feed host can count and follow installs. That conflicts with
  [D15](plan.md#d15-telemetry)'s "no phoning home". The controller overwrites the header with a
  constant ([When updates happen](#when-updates-happen)).

### Signed feed metadata

A small envelope next to each channel file, signed with an Ed25519 key that is **not** the
Developer ID key and never leaves Nick's Mac (or a hardware key). Signing a malicious update then
needs both keys: the Developer ID certificate _and_ the feed key.

`latest-mac.envelope.json`:

```json
{
  "channel": "latest",
  "version": "1.3.0",
  "ymlSha256": "<sha256 of latest-mac.yml, exact bytes>",
  "minimumVersion": "1.2.4",
  "issuedAt": "2026-11-07T10:00:00Z",
  "expiresAt": "2026-12-07T10:00:00Z"
}
```

with a detached signature `latest-mac.envelope.json.sig` over its exact bytes. The app embeds the
public key and checks, in a custom electron-updater provider:

1. the signature verifies (`node:crypto` Ed25519; no dependency);
2. `channel` is the channel asked for, and `expiresAt` hasn't passed (a stale feed shows "can't
   verify updates" in the tray rather than silently stopping);
3. the yml's SHA-256 matches `ymlSha256`, and the yml's `version` matches `version`;
4. `version` is greater than both the running version and the **highest version this install has
   ever run**, which the app records in `userData`. Reinstalling an old DMG by hand is how the
   person rolls back deliberately; the updater never does it for them.

`minimumVersion` lets a release declare that anything older is unsafe. The tray then says so
plainly instead of waiting for the next scheduled check.

The release script re-signs the envelope monthly even with no release, so `expiresAt` never lapses
for a quiet project. That's a scheduled reminder for Nick, not automation holding the key.

It is built: [`feed-envelope.ts`](../apps/desktop/src/main/updater/feed-envelope.ts) (`verifyFeed`,
pure apart from `node:crypto`) and [`feed-provider.ts`](../apps/desktop/src/main/updater/feed-provider.ts)
(`signedFeedProvider`, the electron-updater provider around it).

**One source for the feed URL: a constant compiled into the asar.** `createUpdater` calls
`autoUpdater.setFeedURL({ provider: 'custom', updateProvider: signedFeedProvider({ baseUrl, publicKey, now, stagingId }) })`.
Given options, electron-updater 6.8.11 builds the provider from them and never reads the provider
settings in `app-update.yml` (`AppUpdater.setFeedURL` sets `clientPromise` directly), so nothing
outside the asar can name a feed. electron-builder still writes `app-update.yml` from `publish`
(electron-updater reads its cache directory name from it), and the release check asserts its `url`
equals `FEED_BASE_URL`, so the two can't drift into telling different stories.

**The precondition.** `createUpdater({ enabled: true })` without `feed: { url, publicKey }` throws
`config: invalid`; so does a key that isn't an Ed25519 SPKI PEM public key (a private key PEM, from
which Node would happily derive the public half, is refused too). A build can't switch updates on
and trust unsigned metadata.

What the provider does for each check:

1. Fetches `<channel>-mac.yml`, `<channel>-mac.envelope.json` and `<channel>-mac.envelope.json.sig`
   from the feed base, with the constant staging id. A 404 for either signing file is
   `feed-unverified`, not an unreachable feed.
2. `verifyFeed` checks, in order, and returns only a fixed reason, never feed text:
   - the signature: base64 of exactly 64 bytes (one trailing newline tolerated), Ed25519 over the
     envelope's exact bytes (`signature-invalid`);
   - the envelope: printable ASCII, at most 1 KiB, and byte-for-byte the canonical JSON (keys in
     `ENVELOPE_KEYS` order, no whitespace, no escapes, so no extra, missing or duplicate keys);
     canonical versions with `minimumVersion` at or below `version`; a lowercase hex SHA-256; ISO
     times (`envelope-invalid`);
   - `channel` is the one asked for (`channel-mismatch`);
   - `now` is before `expiresAt`, `issuedAt` is at most a day ahead of this clock, and the window
     is at most 62 days (`expired`);
   - the yml's SHA-256 matches `ymlSha256`, and only then is the yml parsed, and its `version`
     must equal the envelope's (`yml-mismatch`).
3. Returns the update info parsed from the bytes that were checked, after checking every file URL
   in it resolves under the feed base.

The controller then applies its own forward-only rules ([When updates happen](#when-updates-happen)),
so a replayed, unexpired envelope for an older version is "up to date", never a downgrade. The
refusals map to `feed-unverified` (signature, envelope, channel, yml, a file outside the feed) and
`feed-expired` in `UPDATE_ERROR_REASONS`. `minimumVersion` is checked for consistency but not yet
surfaced: the tray can't say "this version is unsafe" until the renderer contract has a place for
it.

### Redirects

electron-updater's Electron executor follows redirects with no check on scheme or host
(`ElectronHttpExecutor.addRedirectHandlers` calls builder-util-runtime 9.7.0's
`prepareRedirectUrlOptions`, which only strips a few headers on a cross-origin hop and accepts
`http:`). One 30x from the feed host or a CDN to `http://…` would put the yml and the zip within
reach of anyone on the network. All of electron-updater's requests go through the
`electron-updater` session partition, and each redirect hop is a new request there, so main
confines that partition before the first check:

```ts
const guard = confineUpdaterSession(session.fromPartition(UPDATER_PARTITION, { cache: false }), FEED_BASE_URL)
```

[`request-guard.ts`](../apps/desktop/src/main/updater/request-guard.ts) cancels, in
`webRequest.onBeforeRequest`, anything that isn't a GET or HEAD under the feed base: another scheme,
host or port, credentials, a path outside the base after dot-segment resolution, or an encoded
slash or backslash. It counts what it cancels; the controller takes it as `requestGuard` and
reports a check or download that failed after a cancellation as `request-refused`, whatever
Electron's error says.

### When updates happen

The controller is [`apps/desktop/src/main/updater`](../apps/desktop/src/main/updater):
`createUpdater(options)` wraps electron-updater's `autoUpdater`, injected as the `AutoUpdaterLike`
interface (which electron-updater's `AppUpdater` satisfies), with an injected clock, random source
and log, so its policy is tested in plain Node. What the main process wires:

```ts
const updater = createUpdater({
  autoUpdater, // from electron-updater
  enabled: app.isPackaged && signedWithReleaseIdentity, // off: never contacts the feed
  currentVersion: app.getVersion(),
  channel: () => settings.updateChannel, // 'stable' | 'beta', read at every check
  autoInstallOnQuit: () => settings.autoInstallUpdates,
  highestVersionRun: () => versions.highestRun(), // recorded in userData
  whenIdle: () => runtime.drainAdapters(), // resolves when no adapter run or login holds a lock
  feed: { url: FEED_BASE_URL, publicKey: FEED_PUBLIC_KEY }, // required when enabled; compiled in
  requestGuard: guard, // confineUpdaterSession(...), above
  clock,
  random: Math.random,
  log: (entry) => appLog.write('updater', entry),
})
updater.start()

interface Updater {
  start(): void // check now (after startDelayMs), then every 6 hours plus up to 30 minutes
  stop(): void
  checkNow(): Promise<UpdaterStatus> // the tray's "Check now"
  status(): UpdaterStatus // toUpdateStatus(status, signed) gives the renderer's UpdateStatus
  // (signed is forced false while disabled; up-to-date with checkedAt null means never checked)
  onStatus(listener): () => void
  installAndRestart(): Promise<boolean> // the tray's "Restart to update": true once handed over
}
```

- **Check at launch and every six hours**, plus upward-only jitter (up to 30 minutes, drawn afresh
  each time), counted from the end of the last check, including one made on demand. While an
  update is downloading, ready or installing, scheduled checks don't contact the feed.
- **Only forward.** Before downloading, the offered version must parse as canonical SemVer (no
  `v` prefix, no leading zeros, at most 64 characters; it is shown in the UI and the log), be
  newer than the running version and than the highest version this install has run, and on the
  stable channel not be a prerelease. electron-updater's own `allowDowngrade` is set back to
  `false` after every channel assignment. A refusal is the `downgrade-refused` or
  `channel-mismatch` state, and nothing is downloaded.
- **Never restart mid-run.** Installing means quitting. Only `installAndRestart()` calls
  `quitAndInstall`, and it first waits on `whenIdle()`. With "Install updates automatically" on,
  Squirrel.Mac also installs a downloaded update when the app next quits; the quit path itself
  must wait for adapter locks. A restart mid-login would leave the durable attempt marker set,
  which by design stops further logins until the person clears it.
- **Handed over is not quitting.** `installAndRestart()` resolves true once `quitAndInstall` has
  the update. With install-on-quit off, `MacUpdater.quitAndInstall` only then asks Squirrel.Mac to
  fetch the zip from its local proxy, and the app quits once Squirrel.Mac has it. If Squirrel.Mac
  refuses it instead (MacUpdater re-emits nativeUpdater's errors), or `quitAndInstall` throws, the
  status becomes `install-failed` and the schedule that was stopped for the hand-off resumes, so a
  refused update doesn't end checking for the session.
- **Where a Squirrel.Mac refusal lands.** With install-on-quit on, electron-updater 6.8.11
  resolves `downloadUpdate()` on the proxy response's `finish`, once Squirrel.Mac has received the
  bytes but before it has checked their signature, and removes its reject listener. The refusal
  then normally arrives as an `error` event while the update is `ready` (`install-failed`). If it
  lands while the controller is still in `downloading` (before its continuation runs), it is
  remembered, and a download that then resolves is `install-failed` too, never `ready`. A failed
  download rejects as well as emitting `error`, so it is still classified by its rejection.
- **Quiet.** electron-updater's logger is switched off: it logs feed and download URLs, file names
  and the staging id. The controller logs one entry per state change with versions, the channel and
  a reason code (`UPDATE_ERROR_REASONS`), never a URL or an error message. Errors are classified by
  their `code`/`statusCode` and the phase (check, download, install), never by their text.
- **No per-install id.** electron-updater sends a persistent per-install UUID in
  `x-user-staging-id` with every check. The controller overwrites it with the constant `none` (the
  local feed test asserts no request carries the UUID). Staged rollouts still work: electron-updater
  decides those locally from the UUID on disk.
- **The feed URL** is checked by `validateFeedUrl` (also used by the build config): https, a
  directory, no query, fragment or credentials, already canonical, so no token can be in it; and,
  for a release build and an updater not built for the end-to-end test, a public host name (no IP
  literal, `localhost`, single label, or `.local`, `.internal`, `.home.arpa`, `.test` name).
- Main sets `process.env.PATH` to the system default at start-up. electron-updater runs `uname` and
  `sysctl` by name to detect the architecture; the credentials package already uses an absolute
  path to `security` for the same reason.
- **The signed envelope is required** ([Signed feed metadata](#signed-feed-metadata)): a yml
  rewritten to `99.0.0` around a genuine old zip, a feed signed by another key, an unsigned feed and
  a frozen one past its expiry are all refused before any zip is fetched (`feed-server.test.ts`).

## Channels

- **`latest`** (stable) and **`beta`.**
  - A version like `1.4.0-beta.2` is published to `beta` (electron-builder infers the channel from
    the prerelease tag).
  - `generateUpdatesFilesForAllChannels` makes every stable release also write `beta-mac.yml`, so
    beta users move on to the next stable release once it overtakes their beta.
- **Switching to beta** sets `autoUpdater.channel = 'beta'`. electron-updater then **silently sets
  `allowDowngrade = true`** (it's in `AppUpdater`'s channel setter). The controller sets it back to
  `false` straight after, at every check, and refuses a version at or below the running one
  itself. The envelope's version check is the backstop.
- **No channel in the build's `publish`.** electron-builder takes the channel from the version, so
  the config sets none (`channel: 'latest'` there would put betas on stable). The renderer's
  `stable` setting is the feed's `latest` (`FEED_CHANNELS`).
- **Switching back to stable** waits until stable overtakes the beta. "Switch now" means
  downloading the stable DMG by hand, which is an explicit downgrade the person chooses.
- **Staged rollout:** `stagingPercentage` in the yml. electron-updater decides locally from its
  staging id, which still works with the header dropped. Use it for releases that touch the
  auth flow, the credential path or the egress guards: 20% for two days, then everyone. With one
  user before M8 this is moot; it matters after.

## Rollback

Squirrel.Mac replaces the app in place and keeps no previous copy, so:

- **A bad release is fixed by rolling forward.**
  - Publish `1.3.1` built from `1.3.0` with the bad change reverted.
  - The version floor means the updater never offers `1.2.x` to someone on `1.3.0`, and it
    shouldn't: anything the bad version wrote to disk has to be handled by code that knows about
    it.
- **Pulling a release before it spreads:** re-sign the previous envelope (pointing at the
  previous version) with a new `issuedAt`. Installs that haven't updated stay put. Installs that
  have updated wait for the fix.
- **A release that crashes at launch** can't fix itself if the crash comes before the updater
  runs. So:
  - the update check is wired before any adapter, credential or UI start-up;
  - a crash counter in `userData` (three launches in a row that don't reach "ready") starts the
    app in a safe mode: updater and tray only, no adapters, no MCP endpoint;
  - the last resort is the DMG from the website.
- **Data formats move forward only.**
  - Every file under `userData` that the app owns (approvals, grants, the audit log, settings)
    carries a version, as `approvals.json` already does.
  - A build that finds a newer version than it understands refuses to touch the file and says so,
    rather than "repairing" it.
  - Migrations back up the file first. That's what makes a deliberate manual downgrade safe.

## Testing the updater

### In `pnpm check`, plain Node

In `apps/desktop/test/updater`:

- `updater.test.ts`: the controller's policy against a fake `autoUpdater` (whose channel setter
  turns `allowDowngrade` on, as electron-updater's does) and a manual clock: the channel mapping and
  the `allowDowngrade` fix-up; refusing older, equal, below-the-floor, non-canonical and
  prerelease-on-stable versions before any download; the staging-id overwrite; the logger staying
  off; install-on-quit following the setting; one check shared between callers; the schedule and
  its jitter; waiting for `whenIdle()` before `quitAndInstall`, and not quitting when Squirrel.Mac
  reports an error meanwhile; error codes never carrying a message or URL into status or log.
- `version.test.ts`, `feed-url.test.ts`: the strict SemVer parser and the feed URL check, one test
  per loose form or smuggling attempt.
- `feed-server.test.ts`: the controller over **electron-updater's own `AppUpdater`**, run in Node
  against a local static feed (`fake-feed-server.ts`: `node:http` on `127.0.0.1`, port 0, which
  records every request and can answer a path with an HTTP error). electron-updater's code does the
  real work up to Squirrel.Mac: reading `app-update.yml`, the generic provider fetching
  `<channel>-mac.yml`, its version comparison, `MacUpdater.filterFilesForArch`, and the download
  with its SHA-512 check. What `node-updater.ts` replaces: Electron's `net` (a Node `HttpExecutor`
  from electron-updater's own `builder-util-runtime`), the Electron app (an `AppAdapter` over a temp
  directory), and the hand-off to Squirrel.Mac (`quitAndInstall` records). It shows: the arm64 or
  x64 zip downloaded and verified, a zip with one byte changed refused (`checksum-mismatch`), an
  older version left alone on the beta channel where electron-updater by itself would downgrade, a
  version below the floor or a prerelease on stable refused before the zip is fetched, missing and
  garbled channel files, and no request carrying the per-install UUID.
  With the signed provider and the session guard in place: the attacks above, the beta envelope
  served as stable, a signed yml naming a zip on another host, and 302s of the zip to another
  origin, of the yml to https on the same host and of the envelope to another port, each cancelled
  by the guard (`node-updater.ts` shows every request, redirect hops included, to the partition's
  `onBeforeRequest`, as Electron does) and reported as `request-refused`; a redirect within the
  base still works.
- `feed-envelope.test.ts`: `verifyFeed`, one test per way of getting it wrong (below), against
  envelopes written and signed by `make-feed.mjs`. `request-guard.test.ts`: the guard's URL rule.
  `app-scheme.test.ts`: the app:// handler's path rules.
- `make-feed.test.ts`: `scripts/make-feed.mjs` (below), including what it refuses to write.
- `packaging.test.ts`: the build configuration ([electron-builder](#electron-builder),
  [Entitlements](#entitlements)), and that this doc names the config file, both bundle IDs, the
  variables and every fuse with its value.

The verifier's adversarial cases, one test each: a signature by another key; a valid signature over
different bytes; an empty, short, long or non-base64 signature; an expired envelope, one issued too
far ahead and one with too long a window; an envelope for the other channel; a yml whose hash
differs by one byte; a yml rewritten to a higher version; a yml whose version differs from the
envelope's with matching bytes; an envelope with extra, missing, reordered or duplicate keys,
whitespace, escapes or non-ASCII, even when signed. A version equal to the current one is the
controller's "up to date", not a verifier refusal.

And with the main process: the crash counter, and the fake feed's remaining misbehaviours (serve
a different file under a name, stall, drop the connection halfway).

### The channel files

electron-builder writes `latest-mac.yml` (and `beta-mac.yml`, `alpha-mac.yml`) during a build.
`node scripts/make-feed.mjs --version <v> (--signing-key <pem> | --unsigned) [--minimum-version <v>] [--valid-days <n>] [--release-date <iso>] [--out <dir>] <zip>...`
writes them for zips that already exist: for re-issuing a channel file, publishing zips built
earlier, and the tests. A stable version goes to `latest` and `beta`; `1.3.0-beta.N` to `beta`
only; other prerelease tags, non-canonical versions, zip names that don't carry the version or
could escape the feed directory, two zips for one architecture, and malformed digests or dates are
refused. It also:

- reads `Contents/Info.plist` of the one `.app` in each zip (`unzip -Z1`, `unzip -p`, `plutil`;
  nothing extracted) and refuses a zip whose `CFBundleIdentifier` isn't the release bundle ID (a
  dev build) or whose `CFBundleShortVersionString` isn't `--version` (a stale zip renamed);
- leaves `beta-mac.yml` alone when it already names a newer version than the stable release being
  published, so a hotfix (`1.3.1`) doesn't take an in-flight `1.4.0-beta.1` off the beta channel;
- with `--signing-key` (the offline feed key as a PKCS#8 PEM, never the Developer ID key), writes
  each channel's `<channel>-mac.envelope.json` and `.sig`, valid from the release date for
  `--valid-days` (default 30, at most 62). `--unsigned` writes channel files only, which the app
  refuses; one of the two must be given.

The smoke build checks that its output has the same fields as electron-builder's for the same zip.

### End to end, with real signing

This can't run in `pnpm check`: Squirrel.Mac only installs signed apps, and signing needs Nick's
identity. It's a separate command, `pnpm test:updater-e2e`, run on Nick's Mac before each release
that touches the updater, and before the first release.

- **A third identity:** bundle ID `me.dncr.siteadapter.updatetest`, signed with Nick's Developer ID
  but not notarised (an update fetched by the app carries no quarantine flag, so Gatekeeper isn't
  involved; _verify_). It has its own `userData`, Keychain names and requirement file, so the
  test can't touch the real app's data.
- **The feed URL** is the fake server's `http://127.0.0.1:<port>/`, compiled into that build's
  `FEED_BASE_URL` like any other build's. The script picks a free port before building and starts
  the fake server on that port, rather than port 0. There's no environment variable or flag to
  point a release build elsewhere, because that would be a way to point it at an attacker's feed.
- **The envelope** is signed with a test key, which only the test build embeds.
- **A build-time constant** (`__UPDATER_E2E__`) makes the test build check immediately, write each
  updater event as a line of JSON to a file the script names, and install without asking. It's
  compiled out of release builds, and the release check greps the bundle to prove it.

The script:

1. builds `1.0.0` and `1.0.1` of the test identity, plus the attack artifacts below;
2. copies `1.0.0` into a temporary directory (Squirrel.Mac updates in place, wherever the app is);
3. starts the fake server serving `1.0.1`, and launches `1.0.0`;
4. waits for the relaunch, then asserts:
   - `Info.plist` now says `1.0.1`;
   - `codesign -d -r-` still prints the same requirement;
   - the event log shows `available`, then `downloaded`, then a clean restart;
   - the fake server saw no staging id.

Then the same, once per attack. Each must leave the app at `1.0.0`, with an `error` event and the
reason class recorded:

| Attack                                                         | Expected stop                                 |
| -------------------------------------------------------------- | --------------------------------------------- |
| `1.0.1` zip ad-hoc signed                                      | Squirrel.Mac's requirement check              |
| `1.0.1` zip signed by the same team with a different bundle ID | Squirrel.Mac's requirement check              |
| `1.0.1` zip with one byte changed after signing                | SHA-512 mismatch, then the signature          |
| yml says `9.9.9`, zip is a genuine older `0.9.0`               | Envelope: version mismatch or below the floor |
| Envelope signed by another key                                 | Envelope signature                            |
| Envelope expired                                               | Envelope expiry; tray shows "can't verify"    |
| Envelope from `beta` served as `latest`                        | Envelope channel                              |
| Server stalls for 10 minutes                                   | Request timeout; app remains responsive       |
| Server redirects the zip to another host                       | Refused; the feed is same-origin only         |

The first two rows test Squirrel.Mac's behaviour, which this doc otherwise takes on trust. If
either installs, stop: the updater's trust story is wrong, and the release waits.

## CI when the repo is public

- **Tests** (`pnpm check`) on GitHub's macOS runners for every push and pull request, with no
  secrets available to those workflows at all.
- **Signing stays on Nick's Mac** until there's a reason to move it.
  - A compromised CI that can sign can ship a malicious update to every install, and the
    requirement check will accept it.
  - The separate feed key limits that: CI could sign an app but not the envelope.
  - If signing moves to CI, keep the feed key off CI, so a CI compromise alone still can't publish.
- If signing does move to CI:
  - one workflow, triggered only by a signed tag on `main`;
  - running in a protected `release` environment with Nick as required reviewer;
  - actions pinned by commit SHA;
  - the certificate imported from `CSC_LINK` and `CSC_KEY_PASSWORD` (electron-builder makes a
    temporary keychain);
  - the API key from three secrets.

```yaml
# .github/workflows/release.yml (sketch; pin every action by SHA)
on:
  push:
    tags: ["v*"]
jobs:
  release:
    runs-on: macos-15
    environment: release # required reviewer: Nick
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@<sha>
      - uses: jdx/mise-action@<sha>
      - run: mise exec -- pnpm install --frozen-lockfile
      - run: mise exec -- pnpm check
      - name: Build, sign and notarise
        env:
          CSC_LINK: ${{ secrets.DEVELOPER_ID_P12_BASE64 }}
          CSC_KEY_PASSWORD: ${{ secrets.DEVELOPER_ID_P12_PASSWORD }}
          APPLE_API_KEY_P8: ${{ secrets.APPLE_API_KEY_P8 }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
        run: |
          export APPLE_API_KEY="$RUNNER_TEMP/AuthKey.p8"
          printf '%s' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY"
          mise exec -- pnpm --filter @siteadapter/desktop release:build
      # The envelope is signed on Nick's Mac and uploaded by the release script there.
```

What else changes when the repo goes public:

- GitHub Releases carries the DMG, checksums and release notes for people downloading by hand.
  The updater keeps using the static feed.
- Build reproducibility starts to matter, because outsiders will ask whether the binary matches
  the source. Electron apps aren't byte-reproducible without effort (timestamps, signing). Publish
  the exact commit, lockfile and toolchain versions; don't claim reproducibility until it's been
  tested.
- A `SECURITY.md` with a reporting address, and a statement of what the update keys protect.
- x64 builds, if people ask.

## Core changes

- An `'update'` stage in `STAGES`, and error classes for the updater: `signature-invalid`,
  `expired`, `version-rejected` (or a reasoned decision to reuse `invalid` and `not-found`). Until
  then the desktop app can map updater failures to `internal` locally, but the audit log and tray
  would then show less than they should.
- Audit events `update-downloaded` and `update-installed`, with versions, so an update shows up in
  the same hash chain as everything else.

## Open questions

- The final bundle ID and display name (D1). Everything above uses `me.dncr.siteadapter`; the
  config's `RELEASE_APP_ID` is the only place it is written.
- Whether Squirrel.Mac in Electron 44 still verifies the update against the running app's
  designated requirement: the first two E2E attack rows answer it.
- Whether Developer ID's default requirement equals the explicit one exactly.
- `electron-fuses` comes from `@electron/fuses`, which electron-builder already installs, but it
  isn't a direct dependency of `apps/desktop`, so `pnpm exec` won't find it. Add it (and
  `@electron/osx-sign`, which the sign wrapper reaches through electron-builder) as direct
  devDependencies at M3, or have the release check read the wire as `scripts/package-smoke.mjs`
  does; either way, parse it rather than eyeballing it.
- Electron 44's fuse wire has a ninth fuse that `@electron/fuses` 1.8.0 has no name for, left on
  as shipped. Name it (a newer `@electron/fuses`) and decide it explicitly.
- Whether enabling cookie encryption prompts for Keychain access on first run, and what the
  prompt names.
- **For Nick: cookie encryption on.** The config turns `enableCookieEncryption` on for every build,
  as recommended above. It is one-way once a real session exists; say now if you'd rather not.
- The main process still loads the renderer with a `file://` URL. With
  `grantFileProtocolExtraPrivileges` off that leaves the packaged control panel blank; it must
  switch to `app-scheme.ts` (`appPageUrl`, and `isAppPage` comparing against `app://renderer`)
  before the first packaged build. The smoke shows the scheme working in a packaged window.
- Where `FEED_PUBLIC_KEY` comes from at build time (an electron-vite `define` from a file in the
  repo is the obvious choice: it is public), and a release check that the key in the asar is the
  one the release script signs with.
- **For Nick: bridge mode instead of WS9's signed helper.** [The stdio bridge](#the-stdio-bridge)
  departs from WS9. Accept it, or say which cost of a helper you'd rather pay.
- **For Nick: where the Developer ID key lives.** A separate release keychain is the minimum;
  a hardware token is better if `codesign` works with it. Until one of them is in place, any
  process running as Nick can sign a build that passes the release requirement.
- In Electron 44: whether the `--remote-debugging-port` listener opens before main's first
  statement runs, which `ELECTRON_*` environment variables are read at start-up, and whether
  LaunchServices still adds a `-psn_…` argument.
