# Adapters installed at runtime

Design for workstream C of [plan-agent-run.md](plan-agent-run.md): adapters become packages that
Valet compiles, stores by hash and loads at run time, instead of code compiled into the app. It
answers [D11](plan.md#d11-adapter-package-format) (Nick, 2026-11-12: adapters must be installable
after the app is built). The sandbox is workstream I and is not here; the approval broker is D;
drafts written by agents are F. This document is what those streams build on.

Status: built (2026-11-12). Reviewed by the security-design thread (B) before it was built, with
its six points folded in (/mnt/project-files/reviews/2026-11-12-b-review-of-c-packages.md), and by
an adversarial review of the design, whose findings are folded in below (schema patterns, the swap
race, rollback eligibility, pruning, checking input before anything waits), and by an adversarial
review of the code, whose fixes are noted where they apply.

## What changes, in one paragraph

Today each built-in adapter is TypeScript the app's bundler compiles twice: into the main process
(manifest and zod schemas) and into a tool script the isolated tool process runs. After this
change, an adapter is a **package**: a manifest plus TypeScript sources. Valet stores the package
under its content hash, compiles the sources itself with a bundler it ships, and runs the result
in the tool process. The main process never imports adapter code: it reads the manifest as data
and validates inputs and outputs against JSON Schemas the tool process derives from the adapter's
own zod schemas. The three built-in adapters ship as packages and go through exactly the same
path.

## Goals and non-goals

- **Goals:** packages that can be added, updated and rolled back without rebuilding the app; the
  hash the person approves covers exactly the code that runs; a package tampered with on disk is
  refused; the built-ins on the same path; the Woolworths MVP path unchanged, including Nick's
  existing approvals and grants.
- **Non-goals:** the sandbox (I), installing from a URL or anyone else's file (never, D75),
  signatures and publishers (dropped with the marketplace, D83), drafts and the authoring tools
  (F), and the agent-facing install and approval tools (E, D).

## The package

A package is a map from relative path to UTF-8 text. On disk during development it is a folder;
inside Valet it is never written under a name taken from the package (see [Storage](#storage)).

```
manifest.json            the adapter's manifest; core's manifestSchema parses it
src/tools.ts             the entry: exports `tools`, one implementation per declared tool
src/**/*.ts              the rest of the tool code
test/**/*.ts             tests (F runs them against fixtures; the app never runs them)
fixtures/**              recorded or synthetic responses: .json, .html, .txt
README.md                optional
```

### Rules every package must pass

Checked by one function in core (`checkPackage`) before anything is hashed, compiled or stored, on
every path in (folder, built-in, draft):

- **Paths:** segments match `[a-z0-9][a-z0-9._-]*`, joined by `/`; at most 8 segments and 200
  characters. Lowercase ASCII only, so no two paths differ by case or Unicode normalisation (APFS
  is case-insensitive by default). No `.` or `..` segments, no leading `/`, no backslashes.
- **Where files may be:** `manifest.json` and `README.md` at the top; `src/` holds `.ts` files
  only; `test/` holds `.ts` and `.json`; `fixtures/` holds `.json`, `.html` and `.txt`. Nothing
  else, so nothing unexpected (a `.node` binary, a `package.json` with scripts) can ride along.
- **Sizes:** at most 200 files, 1 MiB each, 8 MiB in all. Text must be valid UTF-8 with no NUL.
- **Manifest:** valid JSON, parsed by `manifestSchema`; `src/tools.ts` exists.

Reading a development folder adds: symlinks, devices and anything not a regular file or directory
are refused (checked with `lstat`, not followed); dotfiles and `node_modules` are skipped, since an
adapter folder in this repo has them; the folder's files are read into memory once and only that
copy is checked, hashed and stored.

### What tool code may import

Relative imports inside `src/`, `zod`, and `@valet/core` (its tool-code subset, as today). Any
other import, including Node built-ins and `electron`, fails the compile. There is no package
manager: an adapter with dependencies has to vendor them into `src/`, which keeps every line that
runs inside the hash and inside the review.

## The adapter hash

Unchanged from today's built-ins, on purpose:

```
adapterHash = bundleHash({ ...every file under src/, ":manifest.json": canonicalJson(parsedManifest) })
```

- **Why the same formula.** The three built-ins hash to the same values they do now, so moving
  them onto packages doesn't drop Nick's approvals or his Woolworths secret grant, which are keyed
  by this hash. A test pins that.
- **Why the parsed manifest, canonicalised.** It is what the runtime enforces and what the
  permission diff shows; reformatting `manifest.json` or reordering keys doesn't change the hash,
  and a default the schema fills in is covered. `:manifest.json` can't collide with a source path,
  because no path may start with `:`.
- **What's not covered, and why that's fine.**
  - `test/`, `fixtures/` and `README.md`: they never run with a session. Covering them would make
    a fixture typo drop every grant. They are stored with the version and shown in reviews.
  - The compiler and the two libraries tool code imports (zod, core's tool-code subset): these
    are part of the signed app, like the runtime that enforces the manifest. An app update that
    changes them changes what an approved hash runs, exactly as it can change the runtime today.
    The audit records the app version with every run.
  - The derived JSON Schemas (below): they are a function of covered code, recomputed at every
    load, never stored.
- A **package hash** (the same function over every file in the package) is recorded too, so a
  version whose tests or fixtures changed shows as different in the history. Nothing is keyed by
  it.

## Compiling in the app

- **Bundler:** `esbuild-wasm`, pinned (`COMPILER_VERSION`; a test checks it matches what's
  installed). The app runs its **browser** build in a worker thread of its own: WebAssembly and
  JavaScript only, so the app ships no native binary to sign and notarise, and spawns no process
  (esbuild-wasm's Node API would start `node` from the PATH). The worker gets `browser.js` and
  `esbuild.wasm` as data, which electron-builder packs with the app. The worker is started on first
  use and held open only while a compile waits. A compile has 30 seconds; one that runs over, or
  that breaks esbuild itself rather than failing with a located error (deep nesting can), has
  its worker terminated and the next compile starts a fresh one, so one hostile package can't
  stop every later install. The worker's heap is capped.
- **Input:** only the in-memory files. The browser build has no file system at all; a resolver
  plugin serves relative imports of `.ts` files under `src/` that are in the map, and refuses
  everything else, so a package can't name a file outside itself.
- **Output:** one IIFE script that defines `__valetTools` (`tools`, `ValetError`,
  `NeedsUserError`, and zod's `toJSONSchema` for describe), as the tool process expects. `zod` and `@valet/core` are not bundled
  into each adapter: they resolve to a **library prelude** the app builds once at build time and
  the tool process evaluates in the same fresh `node:vm` context, just before the adapter's
  script. The adapter's compiled script is then only the adapter's own code.
- **When:** at every load, from the stored sources. No compiled output is cached on disk, so there
  is no second artefact that could be swapped for the one the hash names. The compile is
  deterministic (same esbuild, same inputs, sorted), which a test checks.

## Schemas without adapter code in the main process

Today the main process validates every tool input and output with the adapter's zod schemas,
which means adapter code (a `refine`, a `transform`) runs in the trusted process. That is
[G6](plan.md#g6-tool-input-and-output-schemas-live-only-in-code), and packages fix it:

1. **Describe.** At load, Valet starts one tool process for the adapter and sends it `describe`.
   Inside the context, the bootstrap converts each tool's `input` and `output` with zod's
   `toJSONSchema` (input as `io: "input"`, output as `io: "output"`, draft 7) and sends back JSON.
2. **Check.** The main process bounds what came back before using it: at most 64 KiB per schema,
   32 levels deep and 2,000 nodes; no `$ref`, `$defs`, `patternProperties` or `propertyNames`;
   only the keywords zod's `toJSONSchema` emits, each with a value of the right type, and any
   other keyword refuses the schema, so `fromJSONSchema` stays on a known path; reserved property
   names (`__proto__` and the like) are refused; the input schema must be an object schema.
   **`pattern` is stripped** before conversion rather than screened: no regex an adapter wrote ever
   runs in the main process (a catastrophic pattern there would stall every adapter), and the
   tool process's own parse still enforces it. A tool that fails refuses the whole version, as a
   compile error does (below).
3. **Use.** `z.fromJSONSchema` turns each into a zod schema the tool host and MCP server use
   exactly as they used the adapter's own: for `tools/list`, for checking a call's input before
   anything runs, and for checking the output that comes back.
4. **Input checked in the tool process before anything waits.** Right after the main process's
   check, and before the call joins the site's queue, reads settings or asks for confirmation, a
   short-lived tool process parses the input with the adapter's real zod schema (`check`). So a
   pattern or refinement the main process couldn't apply still refuses the call before it costs
   the person a confirmation or a place in the queue. Each call then uses two tool processes; at
   most four checks per adapter run at once (`MAX_INPUT_CHECKS`), and a call past that is told
   to retry, so parallel calls can't start processes without bound.
5. **Authoritative parse at run.** The tool process parses the raw input with the real schema
   again before `run` (so transforms, defaults and refinements behave exactly as written), and
   parses the output with the real output schema before sending it. The main process's check is
   the gate; the tool process's parse is what the code sees.

The derived schemas are recomputed at every load and never stored. An adapter could make them
differ from load to load, but that buys it nothing: an adapter already decides its own schemas.
What protects the person is the manifest (requests, egress, side effects), which is data the main
process parses itself.

## Storage

Under the app's data folder, owner-only like every other state file:

```
adapters/
  <adapter id>/
    state.json
    <adapter hash>.json      one per stored version
```

- **Names on disk** are only the adapter id (the manifest's id rule, `^[a-z][a-z0-9-]{1,63}$`) and
  the 64-hex adapter hash. No path from inside a package is ever used as a file name.
- **A version file** is `{ format: 1, files: { "<path>": "<text>" } }`, written atomically, never
  changed after it's written.
- **`state.json`:** `{ version: 1, active: <hash>, pinned: <boolean>, versions: [{ hash,
  packageHash, version, source, installedAt, app }] }`, where `app` records what the hash doesn't
  cover: the app version, the library prelude's hash and the esbuild version that compiled it. An
  app update that changes what an approved hash runs then shows in the history. `source` is `builtin`, `folder` or (with F)
  `draft`. At most 20 versions are kept per adapter; the oldest is dropped, except that the active
  version, the approved hash and any hash with a grant are never dropped, so a version the person
  could roll back to doesn't vanish under a run of failed installs.
- **Loading a version** reads its file, runs `checkPackage` again, recomputes the adapter hash
  and requires it to equal the file's name and the `state.json` entry, and requires the
  manifest's id to equal the folder's. Any mismatch refuses that version: it is not compiled or
  registered, the audit gets `adapter-refused` with the reason, and the adapter shows a health
  problem. For a built-in, the app's own copy is written back (it's part of the signed app), so a
  corrupted Woolworths file heals at the next launch; for anything else the adapter stays off.
  Only a damaged file (a store error) heals like that: a version that fails to compile or
  describe (describe is tried twice, since a cold launch can be slow) is audited and skipped for
  that launch, the built-in serving in memory, and the person's pinned choice is left as it is.
- **The approval store decides what runs, not `state.json`.** Invariant: an adapter has at most
  one approved hash (`ApprovalStore.approve` replaces the earlier one; a test pins it). The active
  version's tools are listed only if its hash is the approved one. So `state.json`'s `active` is
  a cache of the person's last choice and needs no integrity protection: pointing it at another
  stored version gets an attacker an adapter with no tools.
- **What tampering can and can't do.** Editing a stored version changes its hash, so it is refused
  at load, and even if `state.json` were edited to match, the new hash isn't approved and has no
  grants, so its tools stay hidden. Someone who can write the data folder as Nick can today also
  edit `approvals.json`; B makes approvals and grants trusted stores (signed records with a hash
  anchor in the Keychain, core `trusted-store.ts`, built by D), which closes that gap without any
  change here.

## Install, update and rollback

One code path in the app's `PackageManager` (over `loadPackage` and `AdapterStore.put` in
`@valet/adapter-store`), used by the development folder and (later) drafts; the built-ins use its
steps 1 to 3 at launch. Installs and rollbacks of one adapter run one at a time.

1. `checkPackage`, hash, compile and describe. Any failure ends here with nothing stored.
   **Until workstream I's sandbox exists, `install` refuses the `draft` source** (the package
   manager and the store both refuse it) with a clear
   reason. Describe runs the package's code in the tool process, which is a full Node process
   (`node:vm` is not a boundary), so it must only ever run code the person put there themselves:
   the app's built-ins and a development folder in a development build. F's draft tests and live
   trials fall under the same rule.
2. Swap it into the running tool host (`ToolHost.replace`): take the adapter's lock (a running
   call finishes first; if it doesn't within the wait, the install fails with "busy" and the old
   version keeps serving), close the old driver, register the new one. A call that was queued
   behind the swap finds a different version when it gets the lock and returns busy without
   starting, so no call checked against one version's schemas runs another's code; the same holds
   for a login step. An install is refused while a login handoff is open. Login sessions survive,
   because the browser partitions are named by adapter id, not hash, and the redaction secrets the
   old session learned carry to the new one. The service's own driver map changes only once the
   swap is done, so a login window opened meanwhile belongs to the old version.
3. Only now, with it running: write the version file (always, since the content is fixed by the
   hash, which also repairs a damaged file when the same package is installed again), add it to
   the history and make it active; for `folder` and `draft` it is also pinned (below). So a swap
   that is refused leaves the store and the audit as they were.
4. Audit `adapter-installed` with the hash, version, source, the hash it replaced and the `app`
   record above.

The new hash starts unapproved, so its tools stay hidden until the person approves it on the
existing approval screen, with the permission diff against the last approved snapshot. Secret
grants don't carry to a new hash (security model). This is today's behaviour for a built-in that
changes with an app update, kept as is; whether the old version should keep serving while an
update waits is still Nick's open call from the redesign, and the store now makes either answer a
small change.

**The same id inherits the signed-in session.** Browser partitions are named by adapter id, so a
package with id `woolworths` gets Nick's signed-in Woolworths session once it's approved. Repair
(J5) needs exactly that, but the approval must say so: when the installed version replaces one
from a different source (a folder version replacing the built-in, say) or the adapter has a
session or grants, the review leads with a danger banner saying the code will use the signed-in
session for the site (`takesSession` on the pending review: the adapter logs in and the version
isn't the app's own) and where it came from (`origin`). Until B's approval cards land, every
non-built-in version is marked as running unsandboxed.

**Built-ins.** The app ships each built-in as a package. At launch, a built-in whose hash isn't
stored is installed with source `builtin`, and becomes active unless the adapter is pinned. So an
app update brings a new Woolworths version the same way as today, while a person who rolled back
or installed their own version keeps it.

**Rollback.** From an adapter's Versions tab in the Mac app ("Kept versions"), the person picks
a stored version and clicks Roll back. Only versions whose **latest** decision in the audit log
is `adapter-approved` are offered (and the service refuses any other, and refuses any rollback
while the audit chain doesn't verify, so a line added by hand can't make a version look
approved), so a version rejected after
it was once approved never comes back. The confirmation shows the
target's permission diff against the **active** version, because an older version can have more
egress, requests or secrets than the one it replaces. That click is the approval: a gesture in
the app, audited as `adapter-approved` with the hash it replaces, plus `adapter-activated`
(the approval is audited even when the target was still the approved hash, as when an update was
installed and never approved). The
version is swapped in and pinned. The grants that come back are exactly the ones still in the
grant store for that hash: one the person revoked after moving off that version stays revoked
(tested). Once D lands, rollback becomes one of its `adapter-install` approval requests. A
rollback pins, so a newer built-in in a later app update doesn't replace the person's choice; a
"Use the built-in version" action that unpins is not built yet. No MCP tool can install, activate
or roll back; E and F reach these only through D's approvals.

**What a pinned version doesn't follow.** An app update can change the library prelude and the
compiler under a pinned version, without its hash changing. That is recorded (the `app` record per
version, and the build fields on `adapter-installed`) but not yet shown; telling the person, and
asking again where it matters, belongs with D's approval cards.

**Development folder.** In a development build only (not packaged), Adapters has "Install from
folder…": a folder picker in the main process (the renderer never supplies a path), then the same
install path with source `folder`. This is how anyone works on an adapter before F's drafts exist,
and how the e2e suite installs a test adapter (`e2e/packages.spec.ts`; an e2e launch names the
folder in `VALET_E2E_INSTALL_FOLDER`, since the native picker can't be driven). Successful installs
open the review.

**Demo mode** keeps its own data folder (`valet-demo`), so its Woolworths built-in, whose manifest
names the fake shop's origins and so has a different hash, never meets the real one's store.

## Failure cases

| Case                                                  | What happens                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| A package breaks a rule (path, size, file type)       | Install refused with the rule; nothing stored                                |
| `manifest.json` doesn't parse                         | Install refused; the parse error's first issue is shown                      |
| A source doesn't compile, or imports something banned | Install refused with esbuild's first error                                   |
| Describe fails, hangs (5 s) or a schema fails a bound | Install refused naming the tool; at load, the version is refused and audited |
| A stored version file is changed or corrupted         | Refused at load, audited; a built-in heals from the app's copy               |
| `state.json` is unreadable                            | Built-ins load from the app's copies; other adapters stay off; nothing lost  |
| Install while a call is running                       | The swap waits for the adapter's lock; queued calls return busy, unstarted   |
| The same package installed twice                      | No new version; it just becomes active                                       |
| Two adapters with the same id                         | Same adapter, new version: an id names one adapter on this Mac               |
| Rolling back to a version never approved, or rejected | Not offered; the service refuses it                                          |
| An install from the `draft` source                    | Refused until the sandbox (I) exists                                         |
| `active` in `state.json` edited to another version    | That version loads with no tools: its hash isn't the approved one            |

## Known gaps

- A call's login that carries on after the caller was answered can outlive the adapter's lock, so
  a swap can close the old driver in the middle of it. The login fails and runs again; nothing
  of the new version runs in it.
- The folder reader checks each entry with `lstat` and then reads it, so a file swapped for a
  symlink in between is followed. It reads only a folder the person picked, in a development
  build.
- An adapter whose only stored version fails to load disappears from Sites for that launch, so
  its history isn't reachable from the app until it loads again.

## Options considered

- **Ship built JavaScript instead of TypeScript** (the earlier registry design's `tools.mjs`). It
  makes the app simpler but the hash would cover output nobody reads, and an agent would have to
  run a bundler of its own. Compiling in the app means the approved hash names the sources a
  reviewer (or the person's agent) reads.
- **Store JSON Schemas in the package** (`schemas.json`). Authors would keep two copies of every
  schema in step. Deriving them from the zod the code already uses is one source of truth, and the
  main process still only ever sees data.
- **Native esbuild in the app.** Faster, but a native binary per architecture inside the app, to
  sign and notarise with the app. Not worth it at this size.
- **Bundle zod into every adapter** (today's tool scripts). Wasteful, and it would put zod inside
  every adapter's hash. The prelude keeps adapter scripts to the adapter's own code.
- **A folder per version on disk.** Would mean writing files named by the package. One JSON file
  per version avoids that and is atomic.

## What this needs from other streams

- **B:** reviewed the hash and storage rules (done); its trusted stores close the
  `approvals.json` gap without changes here.
- **D:** later replaces "the click is the approval" for rollback with its own broker, unchanged
  for the person.
- **F:** saves drafts as packages in this format and calls `install(package, "draft")`.
- **I:** replaces the `node:vm` context with the sandbox; the prelude and the script stay the
  same.
