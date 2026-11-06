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
  - An explicit designated requirement on the outer bundle only, using the earlier app's `sign`
    wrapper.

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
    allows.
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

`apps/desktop/electron-builder.config.mjs`, modelled on the earlier app's:

```js
// Release builds only; `pnpm build:dev` uses the .dev identity (see "Identity").
import { signAsync } from '@electron/osx-sign'

export const designatedRequirementPath = 'build/designated-requirement.txt'

export default {
  appId: 'me.dncr.siteadapter',
  productName: 'siteadapter',
  copyright: 'Copyright © 2026 <owner>',
  directories: { output: 'dist', buildResources: 'build' },
  // electron-vite's output only. No source maps, tests or fixtures in the package.
  files: ['out/**/*', 'package.json', '!**/*.map'],
  asar: true,
  forceCodeSigning: true, // an unsigned build fails rather than shipping
  electronFuses: {
    runAsNode: false, // ELECTRON_RUN_AS_NODE would run any script as the signed app
    enableNodeOptionsEnvironmentVariable: false, // NODE_OPTIONS=--require …
    enableNodeCliInspectArguments: false, // --inspect, and SIGUSR1 opening the inspector
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true, // with the above: no app/ folder swapped in beside the asar
    enableCookieEncryption: true, // cookies at rest encrypted with a Keychain key; one-way
    grantFileProtocolExtraPrivileges: false,
    loadBrowserProcessSpecificV8Snapshot: false,
  },
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] }, // Squirrel.Mac updates from the zip, never the DMG
    ],
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    preAutoEntitlements: false, // the signed entitlements are exactly the files above
    requirements: designatedRequirementPath,
    // electron-builder gives mac.requirements to every nested binary, whose own identifier can't
    // satisfy it. Keep it on the app bundle only (the earlier app's fix).
    sign: (opts) =>
      signAsync({
        ...opts,
        optionsForFile: (file) => ({
          ...opts.optionsForFile(file),
          ...(file === opts.app ? {} : { requirements: undefined }),
        }),
      }),
    notarize: true, // credentials from the environment; see "Notarisation"
    gatekeeperAssess: false, // the release script runs spctl itself, after stapling
    extendInfo: {
      LSUIElement: true, // menu-bar app: no Dock icon
    },
  },
  dmg: { sign: false }, // signed, notarised and stapled by the release script
  publish: [{ provider: 'generic', url: 'https://updates.example.invalid/mac/', channel: 'latest' }],
  generateUpdatesFilesForAllChannels: true, // so beta users are offered newer stable releases
}
```

Notes on choices that aren't obvious:

- **arm64 only** until the release is public. electron-updater picks per-architecture files
  itself (`MacUpdater.filterFilesForArch`), so adding `x64` later is a config change, not an
  updater change. A universal build doubles every download for no one's benefit.
- **`enableCookieEncryption`.** Without it, the `auth:` and `tool:` partitions' cookies (live
  site sessions) sit in plaintext SQLite under `userData`. Any process running as the person can
  read and replay them. With it, Chromium encrypts them with a key in a Keychain item named after
  the app, whose ACL is the app's designated requirement. That's one more reason the requirement
  must be stable. It is **one-way**: turning it off later makes the existing store unreadable.
  Turn it on before the first real session exists.
- **`preAutoEntitlements: false`.** `@electron/osx-sign` can add entitlements on its own. The
  release check compares the signed entitlements with the files anyway; this makes them agree.

## Entitlements

`build/entitlements.mac.plist`, and the same for `entitlements.mac.inherit.plist` (the helpers:
renderer, GPU, plugin):

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

A plain-Node test in `apps/desktop/test` should parse the config and both plists and fail if:

- a forbidden entitlement appears;
- a fuse in the list above is missing or flipped;
- `hardenedRuntime`, `forceCodeSigning` or `notarize` is turned off;
- main's first statement isn't the command-line check ([below](#command-line-switches)).

It's cheap and it runs in `pnpm check`, which is where a "temporary" entitlement would otherwise
slip in.

## The designated requirement

`build/designated-requirement.txt`:

```
designated => identifier "me.dncr.siteadapter" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "<TEAM_ID>"
```

It says: this bundle ID, chained to Apple, with a Developer ID intermediate and a Developer ID
Application leaf, issued to this team.

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
- Reuse the earlier app's `scripts/require-signing-identity.ts` and `src/signing-identity.ts`, which
  derive the Team ID from the signing identity and write this file before each build, so the
  Team ID isn't hand-copied.

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

1. Set the version, write the designated-requirement file, build with electron-vite, then
   `electron-builder --mac --config electron-builder.config.mjs --publish never`.
2. **Verify the app before anything leaves the machine:**

   ```bash
   APP=dist/mac-arm64/siteadapter.app
   codesign --verify --deep --strict --verbose=2 "$APP"
   codesign -d -r- "$APP"                       # same requirement as the requirement file
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
  [D15](plan.md#d15-telemetry)'s "no phoning home".

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

A sketch, in the repo's style. electron-updater exports `Provider` from its entry point, and its
`parseUpdateInfo` and `resolveFiles` helpers are reachable at `electron-updater/out/providers/Provider`
(the package has no `exports` map).

**One source for the feed URL: a constant compiled into the asar.** At start-up the app calls
`autoUpdater.setFeedURL({ provider: 'custom', updateProvider: SignedFeedProvider })`. Given
options, electron-updater 6.8.11 builds the provider from them and never reads the provider
settings in `app-update.yml` (`AppUpdater.setFeedURL` sets `clientPromise` directly). The
provider ignores its `options` and uses `FEED_BASE_URL`, so nothing outside the asar can name a
feed. electron-builder still writes `app-update.yml` from `publish` (electron-updater reads its
cache directory name from it), and the release check asserts its `url` equals `FEED_BASE_URL`, so
the two can't drift into telling different stories.

```ts
// The update feed, verified. electron-updater authenticates nothing about versions: this provider
// refuses metadata not signed by the feed key, or that would move the install backwards. The yml
// is fetched once and the bytes that were checked are the bytes that are parsed. It also drops
// the per-install staging id electron-updater sends with every request.

export class SignedFeedProvider extends Provider<UpdateInfo> {
  constructor(
    _options: CustomPublishOptions, // ignored: the feed is FEED_BASE_URL, compiled in
    private readonly updater: AppUpdater,
    runtime: ProviderRuntimeOptions,
  ) {
    super(runtime)
  }

  override setRequestHeaders(headers: OutgoingHttpHeaders | null): void {
    const { 'x-user-staging-id': _dropped, ...rest } = headers ?? {}
    super.setRequestHeaders(rest)
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const channel = this.updater.channel ?? 'latest'
    const url = (name: string) => new URL(`${channel}-mac.${name}`, FEED_BASE_URL)
    const yml = await this.httpRequest(url('yml'))
    const envelope = await this.httpRequest(url('envelope.json'))
    const signature = await this.httpRequest(url('envelope.json.sig'))
    const verdict = verifyFeed(
      { yml, envelope, signature },
      { publicKey: FEED_PUBLIC_KEY, channel, now: deps.clock.now(), floor: deps.versions.highestRun() },
    )
    // A fixed reason, never the server's text: the error reaches logs and the tray.
    if (!verdict.ok) throw new UpdateRejected(verdict.reason)
    return parseUpdateInfo(yml, `${channel}-mac.yml`, url('yml'))
  }

  resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveFiles(info, FEED_BASE_URL)
  }
}
```

`verifyFeed` is a pure function and is where the tests aim. electron-updater constructs the
provider itself with a fixed signature, so `deps` (the injected clock and the record of the
highest version run) is bound in a factory around the class. `UpdateRejected` is local to the
desktop app until core has an `'update'` stage ([Core changes](#core-changes)). The envelope must
be ASCII, so the bytes signed and the string `httpRequest` returns can't differ by encoding.

### When updates happen

- Check at launch and every six hours, plus upward-only jitter. Download in the background.
- **Never restart mid-run.** Installing means quitting. The tray offers "Restart to update", and
  the app also installs on its next quit. Either way it first waits for every adapter lock to be
  free. A restart mid-login would leave the durable attempt marker set, which by design stops
  further logins until the person clears it.
- Main sets `process.env.PATH` to the system default at start-up. electron-updater runs `uname` and
  `sysctl` by name to detect the architecture; the credentials package already uses an absolute
  path to `security` for the same reason.

## Channels

- **`latest`** (stable) and **`beta`.**
  - A version like `1.4.0-beta.2` is published to `beta` (electron-builder infers the channel from
    the prerelease tag).
  - `generateUpdatesFilesForAllChannels` makes every stable release also write `beta-mac.yml`, so
    beta users move on to the next stable release once it overtakes their beta.
- **Switching to beta** sets `autoUpdater.channel = 'beta'`. electron-updater then **silently sets
  `allowDowngrade = true`** (it's in `AppUpdater`'s channel setter). Set it back to `false`
  straight after. The envelope's version floor is the backstop.
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

The update controller sits behind an interface, like everything else:

```ts
interface Updater {
  check(): Promise<void>
  quitAndInstall(): void
  on(event: 'available' | 'downloaded' | 'error', listener: (info?: unknown) => void): void
}
```

Its policy is tested with fakes and an injected clock:

- envelope verification;
- the version floor;
- the channel and `allowDowngrade` fix-up;
- waiting for adapter locks before installing;
- the crash counter;
- dropping the staging header.

The envelope verifier gets the adversarial treatment the guards do, one test per attempt:

- a signature by another key;
- a valid signature over different bytes;
- an expired envelope;
- an envelope for the other channel;
- a yml whose hash differs by one byte;
- a yml whose version differs from the envelope's;
- a version equal to the current one;
- a version lower than the highest ever run;
- an envelope with extra or duplicate keys;
- a signature file that's empty, too long, or not base64.

### The fake update server

`fakes/update-server`: a `node:http` server on `127.0.0.1`, port 0, like the fake site.

- It serves a directory of artifacts, records every request (path, headers, timing), and can be
  told to misbehave:
  - serve a different file under a name;
  - stall;
  - drop the connection halfway;
  - redirect to another host;
  - return 404 for the envelope.
- The recorded headers are how a test asserts that `x-user-staging-id` never leaves.

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

- The final bundle ID and display name (D1). Everything above uses `me.dncr.siteadapter`.
- Whether Squirrel.Mac in Electron 44 still verifies the update against the running app's
  designated requirement: the first two E2E attack rows answer it.
- Whether Developer ID's default requirement equals the explicit one exactly.
- `electron-fuses` comes from `@electron/fuses`, which electron-builder already installs, but it
  isn't a direct dependency of `apps/desktop`, so `pnpm exec` won't find it. Add it as a direct
  devDependency at M3, or have the release check call the package's `getCurrentFuseWire` from
  a script; and parse its output rather than eyeballing it.
- Whether enabling cookie encryption prompts for Keychain access on first run, and what the
  prompt names.
- **For Nick: bridge mode instead of WS9's signed helper.** [The stdio bridge](#the-stdio-bridge)
  departs from WS9. Accept it, or say which cost of a helper you'd rather pay.
- **For Nick: where the Developer ID key lives.** A separate release keychain is the minimum;
  a hardware token is better if `codesign` works with it. Until one of them is in place, any
  process running as Nick can sign a build that passes the release requirement.
- In Electron 44: whether the `--remote-debugging-port` listener opens before main's first
  statement runs, which `ELECTRON_*` environment variables are read at start-up, and whether
  LaunchServices still adds a `-psn_…` argument.
