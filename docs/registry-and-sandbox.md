# Sharing adapters: bundles, signing, the registry and the sandbox

Draft. This covers how adapters written by someone other than the person running them could be
packaged, signed, installed, updated and contained. It answers [D11](plan.md#d11-adapter-package-format)
and [D12](plan.md#d12-sandbox-technology), and shapes [M7](plan.md#m7-sandbox-and-adapter-packages),
[M10](plan.md#m10-registry-or-marketplace-exploratory) and [WS11](plan.md#ws11-registry-and-marketplace).
The guarantees it must keep are in [security-model.md](security-model.md).

Facts about third-party projects and terms (QuickJS builds, isolated-vm's status, Sigstore,
Woolworths' and banks' terms) are from memory as of November 2026 and were not re-checked for this
draft. Each one marked _verify_ must be confirmed first. Nothing here is legal advice.

## Summary

- **Bundle:** a `.siteadapter` file with a fixed layout: a manifest, one built tool module,
  JSON Schemas for tool inputs and outputs, tests, fixtures and a bundle descriptor. Two hashes:
  - the **adapter hash** covers only what runs, and is what approvals and grants key on;
  - the **package hash** covers everything, and is what signatures cover.
- **Signing:** Ed25519 publisher keys in minisign's format, verified with `node:crypto` (no new
  dependency). Sigstore later, for build provenance, not identity.
- **Trust:**
  - a signature says who published a bundle, never that it's safe;
  - the person approves exact hashes, and a new publisher key for an adapter id is a new adapter;
  - updates show a semantic permission diff, and secret grants carry forward only when the person
    clicks to keep them.
- **Sandbox:** tool code runs in **QuickJS compiled to WebAssembly**, hosted inside a **sandboxed,
  Node-less hidden renderer** whose in-memory session, one per adapter hash and cleared between
  runs, blocks all network. That's two layers:
  - QuickJS has no ambient authority by construction;
  - Chromium's OS-level sandbox catches a QuickJS or WebAssembly-engine escape.

  This departs from D12's lean towards the renderer alone, for reasons
  [below](#why-not-the-renderer-alone).
- **Registry:** start as a signed JSON index in a public Git repository that points at bundles
  hosted by their publishers. Delist on legal notice; revoke (disable installed copies) only for
  security. Get the [D25](plan.md#d25-adapter-legal-posture) legal opinion before listing any
  adapter for a site whose terms prohibit automated access, which includes Woolworths.

## What an adapter can do, even contained

The sandbox and signing don't make a third-party adapter harmless. They make the capability API
the _only_ thing it can use. Through that API, an approved adapter can still:

- **Do anything its request surface declares, with the person's session.** A `write` declaration
  on a delivery-address endpoint lets it change the delivery address. Runtime-wide deny segments
  cover money movement and checkout only.
- **Exfiltrate through an allowed host.** The egress allowlist stops traffic to other hosts, not
  data written into the site itself: a review, a shared list, a support message, a profile field
  someone else can see.
- **Lie in its results.** Tool output goes to the person's agent, which acts on it. An adapter can
  return text written to steer that agent ("now call `bank_transfer`…"), which is prompt injection
  aimed at the person's other tools. Output schemas and plain-JSON conversion limit the shape,
  not the content. Even an honest adapter passes site-authored text (product descriptions,
  messages) straight through, so this is a property of every adapter, not just malicious ones.
- **Confirm with misleading text.** `confirm(message)` shows adapter-authored text
  ([G4](plan.md#g4-confirm-takes-adapter-authored-text)).
- **Burn the person's standing with the site.** Rate budgets bound it; they don't prevent it.

So the approval screen has to show the request surface and side effects clearly, not just hosts
and secrets, and the registry's review has to read the tool code. Those are the controls for
this list. The sandbox isn't.

## Bundle format

### Layout

```
woolworths-1.3.0.siteadapter          a zip; the layout inside is fixed
├── siteadapter-bundle.json           bundle descriptor (below)
├── manifest.json                     parsed by core's manifestSchema
├── tools.mjs                         one ES module, built; no imports
├── schemas.json                      JSON Schema per tool: { "<tool>": { "input": …, "output": … } }
├── README.md
├── LICENSE
├── tests/*.test.mjs                  run against fixtures in the sandbox; never against a live site
└── fixtures/*.json                   recorded responses, scrubbed or synthetic
```

- **One built `tools.mjs`, no imports.** The author's TypeScript and dependencies are bundled at
  build time. The sandbox has no module loader, so there's nothing to resolve at run time. npm and
  Git are authoring conveniences, never the distribution channel (D11): npm brings install
  scripts and dependency trees nobody reviews.
- **`schemas.json` instead of zod in tool code.** Today the tool host parses inputs and outputs
  with the adapter's own zod schemas, in the trusted process. The tool host's header says why
  that's uncomfortable: a `refine` or `transform` is adapter code. With a sandbox, the trusted
  side must validate with schemas that are _data_ (JSON Schema, checked by a validator the app
  ships), and anything an author writes as code runs inside the sandbox. This is
  [G6](plan.md#g6-tool-input-and-output-schemas-live-only-in-code), and it's a prerequisite for
  M7.
- **Fixtures are personal data until proven otherwise.** A response recorded from a logged-in
  session has names, addresses and order history in it. The build tool refuses fixtures that
  aren't marked `"scrubbed": true` or `"synthetic": true`, and the registry's checks scan for
  emails, phone numbers, street addresses and token-shaped strings.

### The container is not trusted

The zip is parsed by the app before any signature or hash is checked, so parsing is attack
surface. The reader refuses, before extracting anything:

- absolute paths, `..` segments, backslashes, drive letters, and paths not in Unicode NFC;
- two entries that differ only by case or normalisation (APFS is case-insensitive by default);
- symlinks, directories outside the fixed layout, and any file not in the layout;
- more than 200 entries, any file over 5 MiB, more than 20 MiB uncompressed in total, or a
  compression ratio over 100 (zip bombs);
- duplicate entry names, and central-directory entries that disagree with local headers.

Files are read into memory and hashed. Nothing is written to disk under a name taken from the
archive. The installed form is the in-memory file map, stored under the app's own content-hashed
name.

### Two hashes

Both use core's `bundleHash` (a sorted, length-prefixed map of path to bytes), over different file
sets:

| Hash             | Covers                                        | Used for                                               |
| ---------------- | --------------------------------------------- | ------------------------------------------------------ |
| **adapter hash** | `manifest.json`, `tools.mjs`, `schemas.json`  | Approvals and grants (what `Grant.adapterHash` stores) |
| **package hash** | every file in the bundle, descriptor excluded | Signatures, the registry index, download integrity     |

Why two:

- If tests or fixtures were in the adapter hash, fixing a typo in a fixture would drop every
  secret grant.
- Tests and fixtures never run with a real session, so they don't need to be in what the person
  approves.
- The descriptor lists every file's own SHA-256 as well, so a reviewer can see exactly which file
  changed between versions.

### The descriptor

`siteadapter-bundle.json`. It's separate from the manifest, so core's strict `manifestSchema`
doesn't have to grow distribution fields:

```json
{
  "format": 1,
  "adapterId": "woolworths",
  "version": "1.3.0",
  "adapterHash": "9f2c…64 hex",
  "packageHash": "41ab…64 hex",
  "files": {
    "manifest.json": "sha256:…",
    "tools.mjs": "sha256:…",
    "schemas.json": "sha256:…",
    "README.md": "sha256:…",
    "LICENSE": "sha256:…",
    "tests/cart.test.mjs": "sha256:…",
    "fixtures/trolley.json": "sha256:…"
  },
  "publisher": { "name": "Example Publisher", "key": "RW… (minisign public key, base64)" },
  "source": { "repository": "https://github.com/example/siteadapter-woolworths", "commit": "40 hex" },
  "license": "Apache-2.0",
  "build": { "tool": "siteadapter-build", "toolVersion": "1.0.0", "reproducible": true }
}
```

The app recomputes both hashes from the files and refuses the bundle if either differs from the
descriptor. `manifest.json`'s `id` and `version` must match the descriptor's.

**Reproducible builds** make `source.commit` meaningful. `siteadapter-build` pins the bundler,
sorts inputs, strips timestamps and fixes line endings, so anyone can rebuild `tools.mjs` from the
commit and compare hashes. The registry's checks do exactly that. A bundle that doesn't
reproduce can still be installed from a file, but can't be listed.

## Signing

### Options

|                         | None (hash only)                         | minisign-format Ed25519                                                      | Sigstore (keyless)                                                                                    |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| What it proves          | The bytes are the bytes                  | The holder of key K signed these bytes                                       | An OIDC identity (a GitHub workflow, an email) signed these bytes at a time, recorded in a public log |
| Identity                | None                                     | A key; meaning comes from wherever the key was published                     | A GitHub repo and workflow, or an email                                                               |
| Update continuity       | None: every update looks like a stranger | Same key, same publisher                                                     | Same identity, same publisher; identities can be renamed or transferred                               |
| Revocation              | n/a                                      | None built in; the registry index's key list is the revocation channel       | Short-lived certificates; compromise shows in the transparency log                                    |
| Transparency            | None                                     | None                                                                         | Rekor log; detectable, not preventable                                                                |
| Verification in the app | `node:crypto` SHA-256                    | `node:crypto` Ed25519 (and BLAKE2b-512 for prehashed signatures); ~100 lines | The `sigstore` npm package plus a trust root kept current through TUF; a large dependency             |
| Works offline           | Yes                                      | Yes                                                                          | With a bundled trust root, until it goes stale                                                        |
| Privacy for authors     | n/a                                      | Fine                                                                         | Keyless signing with a personal account publishes that email in a public log                          |
| Cost to authors         | None                                     | Keep a key safe                                                              | None locally; needs CI or a browser login                                                             |

### Recommendation

- **Publishers sign the package hash with an Ed25519 key in minisign's format.** Authors can use
  the `minisign` tool they may already have. The app verifies with `node:crypto` alone, so no
  dependency request.
- **Trust on first use, per adapter id.** The first install of `woolworths` from key K pins K.
  An update signed by any other key is presented as a _different adapter_: fresh approval, no
  grants carried, and a warning that the publisher changed. While ids aren't namespaced, it
  replaces the old adapter rather than sitting beside it ([Trust model](#trust-model)). Key
  rotation is a signed statement by the old key naming the new one, published in the registry
  index.
- **The registry index is signed with the registry's own key**, embedded in the app. The index is
  how a key is revoked: a listing marks a key as revoked, and the app stops accepting new bundles
  signed by it.
- **Sigstore is for provenance, later.** A Sigstore attestation that "the GitHub workflow in repo
  R built this bundle from commit C" is worth having once there's a registry with real
  publishers. The registry's checks can verify it server-side. The app doesn't need to.
- **Unsigned bundles still install from a file**, with a plain warning and no updates. That's the
  "I wrote it myself" and "my agent wrote it" path, and it's what M5's IDE produces.

## Trust model

What each layer means, and what it doesn't:

| Layer                      | Means                                                                                        | Doesn't mean                                              |
| -------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Adapter hash approval      | The person approved exactly these runtime bytes and this manifest                            | That anyone read the code                                 |
| Secret grant               | This secret may be filled on these origins, for this adapter hash                            | That the adapter's other requests are benign              |
| Publisher signature        | The holder of key K published this, and it's the same K as before                            | That K is who they say they are, or that K is trustworthy |
| Listed in the registry     | It reproduces from public source, passed automated checks, and its tests pass in the sandbox | That it's safe, or that the site permits it               |
| "Reviewed" badge (if ever) | A named reviewer read this version's code and manifest diff                                  | A guarantee; reviewers miss things                        |

Rules that follow:

- **Ids are not names.** Two publishers can both ship an adapter with id `woolworths`.
  - Core keys everything on the bare `adapterId`: `Grant.adapterId`, `GrantStore.find` and
    `revoke(adapterId, secret)`, every `AuditEvent`, and the approval store. Two installed
    adapters with one id would make a revocation or an audit entry ambiguous.
  - So until core has a namespaced identity, the app **refuses to install a second adapter whose
    id is already in use**, whoever published it. An update signed by a different key (the
    TOFU case below) is installable only after the person removes the existing adapter, which
    revokes its grants and drops its approval; it's then a fresh install.
  - The namespaced identity (`<publisher key fingerprint>/<id>`) is in
    [Core changes](#core-changes), for when two same-id adapters side by side are wanted.
  - The MCP endpoint already withholds colliding tool names rather than letting one adapter
    shadow another (`packages/mcp-server/src/tool-names.ts`).
  - The registry namespaces listings as `<publisher>/<id>`.
- **Show the site, not the name.** The approval screen leads with the registrable domains
  (eTLD+1) of `navigation`, `egress` and the secret origins, so a lookalike is visible. Examples:
  `auth.woolworths.com.au.example.net` is shown as `example.net`; a mixed-script hostname is
  flagged.
- **"From the registry" never skips approval.** Every install and every update is approved by the
  person, on the Mac.

## Permission diff on install and update

### Install

The approval screen, top to bottom, in order of how much each item can hurt:

1. **Secrets:** each requested secret, its fields, and the origins it may be typed on. Grouped by
   registrable domain.
2. **Irreversible and write tools:** each tool with its side effect, and the request declarations
   with that purpose (`POST /api/v3/ui/trolley/update — write`).
3. **Where it can send traffic:** `egress` hosts by registrable domain, with wildcard patterns
   called out (`*.woolworths.com.au` is wider than it looks).
4. **Session copying:** cookie domains, and any web-storage keys copied from auth to tool. A
   storage-token adapter gets a warning, because exact-match redaction is weaker there (R9).
5. **Read tools and read requests**, collapsed.
6. **The auth flow** as readable steps (`go to …`, `type password into #password`), collapsed
   unless it touches a secret.
7. **Publisher, source commit, reproducibility**, and the README.

### Update

The diff is computed on the **parsed** manifests and schemas, not their text, so reordering keys
or reformatting shows nothing. Each item is marked added, removed, changed or unchanged:

```
woolworths 1.2.0 → 1.3.0   publisher unchanged (key RWQ…7GFO)   reproducible ✓

  + egress            cdn1.woolworths.media
  + request  write    DELETE /api/v3/ui/trolley/items/:stockcode
  ~ auth flow         step 4: waitFor #password → waitFor input[name=password]   (touches a secret fill)
  ~ tool              set_cart_quantity: input schema gains "substitute": boolean
  = secrets           login (username, password) on https://auth.woolworths.com.au
  = 14 read requests, 5 read tools                                           [show]

  tools.mjs changed (+212 −40)                                               [show code diff]

  Secret grants can't carry forward: egress widened, a write request was added, and an auth
  step that fills a secret changed.

  [ Approve, re-grant secrets ]   [ Stay on 1.2.0 ]
```

- **Additions to secrets, write or irreversible tools and requests, egress or session copying are
  highlighted.** Removals and unchanged items aren't.
- **Changes to auth steps that touch a secret fill are always highlighted**, even when no
  permission widens. They're the steps that decide where a password is typed.
- **Grants never carry forward silently.** The security model says a changed adapter doesn't
  inherit a grant, and that stays true by default. "Approve and keep secret grants" is offered
  only when all of these hold:
  - the publisher key is unchanged;
  - no secret's origins or fields widened;
  - no auth step touching a secret changed;
  - no egress host was added and no wildcard widened;
  - no cookie domain or web-storage key was added to session copying;
  - no `write` or `irreversible` request declaration or tool was added, and none was widened
    (a broader path pattern, another method).

  The last three matter because a secret's real product is the session it logs into, and
  [guarantee 2](security-model.md#what-we-protect-against) is about where that session can go.
  An update that keeps the login steps but adds a host to send traffic to, or copies another
  cookie, changes what the granted password buys.

  Even when every condition holds it's a click, never automatic. Otherwise the person re-binds
  each secret in the grant picker. The example above fails three of them, so it offers only
  "Approve, re-grant secrets".
- **No automatic updates of adapters in v1.** The app may download and verify updates in the
  background, and show a badge. Applying one is always the person's action. Revisit only with
  evidence that the diff screen is being read and the friction is real.
- The code diff is available, pretty-printed, but isn't the primary view. Most people won't read
  it, and pretending they will is worse than admitting it.

## The sandbox

### What it must guarantee

Tool code (the orchestration in `tools.mjs`) must not be able to:

- read or write any file, including the 1Password token's Keychain item, other adapters' data and
  the audit log;
- start a process, load native code, or reach the network by any route other than the capability
  API;
- read the trusted process's memory, where secrets pass through briefly;
- outlive its deadline or exhaust memory;
- tamper with another call's state, or with the capability objects the runtime gave it.

What it doesn't cover:

- **`page.evaluate(source)` runs adapter JS in the tool partition's page**, in an isolated world.
  That is Chromium's renderer sandbox plus the tool partition's egress allowlist, request surface
  and redaction. The tool sandbox doesn't add to it.
- **The capability API itself.** Everything in [What an adapter can do](#what-an-adapter-can-do-even-contained)
  remains.

### Options

|                                    | QuickJS → WebAssembly                                                                          | isolated-vm                                                       | `utilityProcess` (Node)                                                                                                      | Sandboxed hidden renderer                                                                                                                 | SES / Hardened JS                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Kind of boundary                   | Language VM inside WebAssembly linear memory                                                   | Separate V8 isolate, same process                                 | Separate OS process with Node                                                                                                | Separate OS process under Chromium's sandbox (Seatbelt on macOS), no Node                                                                 | Frozen intrinsics and compartments in the same realm                               |
| Ambient authority                  | **None by construction.** Only injected host functions exist.                                  | None in the isolate; host references are explicit                 | **All of Node** (fs, `child_process`, net) unless stripped; Node's permission model is documented as not a security boundary | The **whole web platform**: `fetch`, WebSocket, WebRTC, workers, `about:blank` iframes with fresh globals. Must be closed by enumeration. | Whatever the realm has; SES removes nothing by itself                              |
| An escape lands in                 | The host process (if in-process)                                                               | **The host process**                                              | Already there                                                                                                                | A sandboxed renderer: no files, no Node, network through a session that blocks everything                                                 | The host realm                                                                     |
| CPU and memory limits              | Interrupt handler for a deadline; heap limit                                                   | Timeouts and heap limits                                          | Kill the process                                                                                                             | Kill the renderer                                                                                                                         | None                                                                               |
| Async (capability calls are async) | Needs promise plumbing across the boundary, or the asyncify build                              | Supported, with care                                              | Native                                                                                                                       | Native                                                                                                                                    | Native                                                                             |
| Maintenance                        | quickjs-ng and quickjs-emscripten are active (_verify_)                                        | Its README has said maintenance mode (_verify_)                   | Electron                                                                                                                     | Electron                                                                                                                                  | Agoric/Endo, active                                                                |
| Upgrade cost                       | None per Electron version; WebAssembly is stable                                               | Native addon: rebuild per Electron and Node ABI                   | None                                                                                                                         | None                                                                                                                                      | None                                                                               |
| Speed                              | Slow interpreter; irrelevant for capability orchestration                                      | Fast                                                              | Fast                                                                                                                         | Fast                                                                                                                                      | Fast                                                                               |
| Precedent                          | Figma moved its plugins to QuickJS-in-WebAssembly after a realm-shim escape (_verify_ details) | Used by several plugin hosts                                      | —                                                                                                                            | Chromium's own isolation; Electron's recommended renderer setup                                                                           | MetaMask Snaps runs SES inside iframes or workers, with the iframe as the boundary |
| Verdict                            | **Boundary of choice**                                                                         | No: in-process native addon, upgrade friction, maintenance doubts | No: not a boundary (what v0 has)                                                                                             | **Second layer**                                                                                                                          | Discipline, not a boundary                                                         |

On the brief's "Electron `utilityProcess` with no Node": as far as we know there's no such
option. A utility process forked with `utilityProcess.fork` runs Node and isn't sandboxed
(_verify_ against Electron 44). The Node-less, sandboxed process Electron offers is a renderer,
which is the fourth column.

### Why not the renderer alone

D12 leaned towards a sandboxed hidden renderer: no dependency, and Chromium's sandbox is
battle-tested. The network side of that is already solved in this repo, so it isn't the
argument:

- The tool partition already sends every connection through `egress-proxy.ts`, with WebRTC
  limited to proxied traffic (`setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`), so
  WebRTC's TURN-over-TCP and WebTransport's QUIC reach nothing undeclared. The e2e suite proves
  it (`packages/browser-electron/e2e/driver.spec.ts`, "WebRTC and WebTransport reach no
  undeclared host from the tool partition").
- The DNS-prefetch switch in `process-hardening.ts` is process-wide (`blink-settings` applies to
  every renderer), so it already covers a sandbox renderer too.
- A sandbox renderer's session could use the same proxy with an empty allow list. Network
  exfiltration from a sandboxed renderer is closable with mechanisms that exist and are tested.

What the renderer alone doesn't give, and QuickJS does:

- **No ambient authority.** A renderer starts with the whole web platform, network aside:
  storage (IndexedDB, Cache Storage, `localStorage`), `BroadcastChannel`, service workers,
  `window.open` and navigation, permission prompts, high-resolution timers and
  `SharedArrayBuffer` for side channels. Each has to be found and closed.
- **Closing them can't be done from inside the page.** Deleting a global doesn't hold: an
  `about:blank` iframe needs no network and hands back fresh globals. So every control has to be
  at the session or process level.
- **The list moves.** It's deny-by-enumeration, and the enumeration has to be redone on every
  Electron upgrade, as new web APIs ship.

QuickJS is deny-by-construction: tool code can call only what the runtime injected. Put QuickJS
_inside_ the sandboxed renderer and each covers the other's gap:

- tool code can't reach the renderer's web APIs, because QuickJS has no access to the host's
  globals;
- a bug that escapes QuickJS or the WebAssembly engine lands in a process with no Node, no file
  access, a session whose `webRequest` cancels every request, and a deny-all egress proxy behind
  that.

### Recommended design

```
main process (trusted)                        sandbox renderer (one per run, or pooled per adapter)
┌──────────────────────────┐   MessagePort   ┌─────────────────────────────────────────────────┐
│ tool host                │◀───────────────▶│ preload: bridges the port to QuickJS            │
│  capability API (page.*, │   structured    │  QuickJS (WebAssembly)                          │
│  session.ensure, confirm)│   clone, JSON   │   tools.mjs, evaluated once per run             │
│  JSON Schema validation  │   only          │   injected: page, session, confirm, signal      │
│  redaction, audit        │                 │   in-sandbox schema code, if the author wrote it│
└──────────────────────────┘                 └─────────────────────────────────────────────────┘
                                              session "sandbox:<adapterHash>" (in memory, no
                                              persist: prefix): webRequest cancels all, proxy
                                              to egress-proxy with an empty allow list, WebRTC
                                              disable_non_proxied_udp, no permissions granted,
                                              sandbox: true, contextIsolation: true,
                                              nodeIntegration: false
```

- **One in-memory session per adapter hash.** The partition is `sandbox:<adapterHash>`, without
  the `persist:` prefix, so Chromium keeps its storage and cache in memory, never on disk, and no
  two adapters ever share one. When a pooled renderer is recycled, and between runs, the runtime
  clears the session's storage and cache (`clearStorageData`, `clearCache`), so a run can't leave
  anything for the next run of the same adapter either.
- **Network, three times over:** `webRequest` cancels everything; the session's proxy is an
  `egress-proxy.ts` instance that allows nothing, which catches the sockets `webRequest` doesn't
  see; and WebRTC is held to proxied traffic. The process-wide DNS-prefetch switch already
  applies. None of this is what keeps tool code in; QuickJS is. It's what an escape runs into.

- **Messages are data.** Every call is `{ id, capability, args }` with JSON-only arguments,
  validated in the main process against the capability's own schema before it does anything.
  Every reply is JSON. No functions, no transferable objects, no `SharedArrayBuffer`.
- **One QuickJS context per tool call**, so calls can't leave state for each other. The renderer
  can be pooled per adapter hash, never across adapters, with its session cleared between runs
  (above).
- **Limits:**
  - a deadline enforced by QuickJS's interrupt handler and, behind it, by killing the renderer;
  - a QuickJS heap limit;
  - a cap on in-flight capability calls;
  - a cap on message size.
- **Determinism:** no `Date.now`, `Math.random` or timers unless injected. The runtime injects a
  clock and a seeded random source, which also makes tests reproducible.
- **Fail closed:** if the renderer crashes or the port closes, the call fails as `tool-run` /
  `internal`, the adapter's lock is released by the existing settle-then-release path, and the
  next call gets a fresh renderer.
- **SES's `lockdown()` in the preload** freezes the renderer's own intrinsics before the bridge is
  set up. It's cheap, and it removes prototype tricks against the bridge code if QuickJS is ever
  escaped. It isn't counted as a boundary.

Cost:

- one dependency (a QuickJS WebAssembly build, roughly 1 MB; request it at M7, not now);
- a few hundred lines of bridge;
- a renderer process per active adapter.

Tool code is mostly awaiting capability calls that take seconds under the rate budget, so
interpreter speed doesn't matter.

### Proving it

M7's hostile-adapter suite gets a sandbox section. Each test is an adapter that tries one escape
and asserts it fails, and that the attempt is visible where it should be:

- `require`, `process`, `import()`, `globalThis.constructor.constructor('return process')()`,
  `fetch`, `WebSocket`, `XMLHttpRequest`, `RTCPeerConnection`, `Worker`, `SharedArrayBuffer`,
  `Atomics.wait`;
- prototype pollution of the injected capability objects, and a capability call with a getter,
  a proxy or a cyclic object as an argument;
- an infinite loop, a memory bomb, an unbounded promise chain, 10,000 concurrent capability calls;
- a capability reply crafted to be a function or a prototype-bearing object on the way back in;
- a tool that keeps running after its deadline, then tries to drive the page under the next call;
- one adapter trying to observe another's state through a pooled renderer.

And for the second layer, a deliberately "escaped" script run directly in the sandbox renderer's
main world (as if QuickJS had been broken) must fail to:

- make any request, by `fetch`, WebSocket, WebRTC (TURN over TCP and UDP), WebTransport, or a
  `<link rel=dns-prefetch>`, each checked against the fake site's request and UDP counters as the
  tool partition's e2e test does;
- read any file or reach Node;
- **see another adapter's state:** it writes a marker to `localStorage`, IndexedDB, Cache Storage
  and a cookie in adapter A's renderer, and the same script in adapter B's renderer must find none
  of them;
- **see an earlier run's state:** the same marker, written in run 1 of adapter A, must be gone in
  run 2 of adapter A in a recycled renderer;
- **find anything on disk:** after the runs, nothing under `userData/Partitions` belongs to a
  `sandbox:` partition.

## Distribution, terms of service and takedowns

### The legal shape, as understood (not advice)

- **Site terms.**
  - Woolworths' website terms, as we understand them, prohibit using robots, spiders, scrapers or
    other automated means to access the site (_verify_ the current wording before relying on it).
  - Coles' and most large retailers' terms are similar.
  - A person running an adapter is a customer automating their own account, at human pace, on
    their own machine. A project _distributing_ an adapter for that site is in a different
    position: it supplies the tool. Where liability for that sits is exactly what
    [D25](plan.md#d25-adapter-legal-posture) asks a lawyer.
- **Bank terms.**
  - Australian banks' terms, and the ePayments Code they subscribe to, put obligations on
    customers not to disclose passcodes. Disclosure can shift liability for unauthorised
    transactions to the customer (_verify_ against the current ePayments Code and the bank's
    terms).
  - siteadapter doesn't disclose the password to a third party. It's filled on the person's own
    machine by software they run, from their own password manager.
  - Some banks' terms also restrict using third-party software to access internet banking. That
    question is open, and it's the person's risk, not something the project can resolve.
  - Australia's Consumer Data Right is the sanctioned route for bank data. A bank adapter should
    point to it.
- **Anti-circumvention.**
  - Bypassing technical access controls has its own liability (DMCA §1201 in the US; the
    technological-protection-measure provisions of Australia's Copyright Act).
  - The bot-detection posture ([D24](plan.md#d24-bot-detection-posture)) matters here as well as
    ethically: adapters that evade bot detection must not be listed, and the registry's checks
    look for the obvious signs (stealth patches, `navigator` overrides, CAPTCHA services in
    egress).
- **Safe harbours.**
  - US DMCA §512 protects a service hosting user content if it registers an agent and runs a
    notice process.
  - Australia's safe harbour is much narrower and doesn't cover a commercial platform run by an
    individual (_verify_).
  - So hosting bundles in Australia under Nick's name is the weakest position.

### Registry policy

- **Host as little as possible.**
  - The registry is a signed index in a public Git repository: publisher keys, listings,
    package hashes, revocations.
  - Bundles are hosted by their publishers (GitHub Releases on the publisher's repository).
  - A takedown aimed at a bundle's content goes to its host, who has a notice process.
  - The registry removes the listing.
- **What's listed:**
  - adapters for sites that permit automation or offer no terms against it;
  - sites the publisher operates;
  - read-only adapters where the D25 opinion says that's acceptable.

  Adapters for sites whose terms prohibit automated access are not listed until D25 says
  otherwise. They can still be installed from a file: the person's own choice, on their own
  machine.
- **Banks:** not listed in the public registry in v1. A bank adapter is the highest-value target
  for a malicious publisher and the clearest terms risk.
- **Labels, not endorsements.** A listing shows: reproducible or not, which permissions,
  `irreversible` tools or not, last verified against fixtures. It doesn't say "safe". Whether to
  show a "site terms restrict automation" label is a D25 question, since a label can also be read
  as knowledge.

### Takedowns and revocation are different things

|                        | Legal notice (a site, a rights holder)                                                    | Security revocation (malicious or compromised bundle)                                 |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| What the registry does | Delists the adapter; keeps a tombstone with the date and the notice's nature              | Marks the package hash, or the publisher key, as revoked in the signed index          |
| Installed copies       | **Keep working.** The person's own use on their own machine is between them and the site. | **Disabled** at the next index refresh, with an explanation, and its grants suspended |
| Updates                | Stop (no listing to update from)                                                          | Stop                                                                                  |
| Notice to users        | Shown in the app's adapter list: "no longer listed"                                       | Shown prominently, with what to check (audit log entries for that adapter)            |

Why the split:

- A remote kill switch for legal reasons turns the registry into a tool sites can direct at every
  user, and invites demands to use it.
- A kill switch for malware is what users would expect, and it can't be abused that way, because
  it's only for code that attacks the people running it.

Process:

- A published contact address and a form for notices.
- Delisting within a stated time.
- Counter-notice handling.
- A public log of delistings and revocations (with names of complainants, where the law allows).

**Index refresh** is a plain fetch of the whole signed index on a schedule, with no identifiers
sent. The app never asks the registry about a specific adapter, so the registry learns nothing
about what a person has installed ([D15](plan.md#d15-telemetry)).

## Phasing

1. **M5:** the IDE saves a bundle in this layout, unsigned, adapter hash only. No sharing.
2. **M7:**
   - the sandbox, its hostile suite and the external red-team pass;
   - the bundle reader with its container rules;
   - install from a file;
   - publisher signatures, TOFU and the update diff.

   Gate: nothing third-party runs before this.
3. **M8:** the reference adapter on a fake site, published as a signed bundle; the build tool
   public.
4. **M10:** the signed index, only after outside authors exist and D25 is answered. Paid adapters,
   reviews and verification badges are later still, and mostly moderation and liability work,
   not code.

## Core changes

None needed for M5. For M7:

- Tool input and output schemas as data in the bundle (`schemas.json`), with the runtime
  validating against them instead of adapter zod ([G6](plan.md#g6-tool-input-and-output-schemas-live-only-in-code)).
  This touches `ToolImplementation` and the tool host.
- A `PublisherKey` and bundle-descriptor type, probably in a new `packages/bundle`, not core.
- `confirm()` taking structured content rendered by the runtime rather than free adapter text
  ([G4](plan.md#g4-confirm-takes-adapter-authored-text)). More pressing with third-party adapters.
- Audit events for install, update (with old and new hashes) and revocation.
- A namespaced adapter identity, `<publisher key fingerprint>/<id>` (or a structured
  `{ publisher, id }`), in `Grant`, `GrantStore.find` and `revoke`, every `AuditEvent` that
  carries `adapterId`, and the approval store. Until then the app refuses a second adapter with
  an id already in use ([Trust model](#trust-model)); with it, two publishers' `woolworths` can
  be installed side by side and revoked or audited separately. Unsigned bundles need a stand-in
  publisher (`local`).

## Open questions

- Whether the QuickJS-in-renderer layering costs too much memory per active adapter on an 8 GB
  Mac. Measure in the M7 spike.
- How QuickJS's async bridge behaves under cancellation, when `signal` aborts mid-await.
- Whether the registry's reproducibility check can run on free CI (it needs only Node), and who
  reviews listings.
- Whether a "verified against fixtures" date is meaningful, given fixtures are recorded by the
  publisher.
