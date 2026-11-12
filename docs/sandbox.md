# The adapter sandbox and its exceptions

Design for workstream I of [plan-agent-run.md](plan-agent-run.md): adapter tool code runs in a
sandbox by default, and reaches local data only through exceptions its manifest declares and the
person approves (D73). It builds on B's contract (`packages/core/src/sandbox.ts`,
[agent-run-security.md](agent-run-security.md#sandbox-exceptions)) and C's packages
([adapter-packages.md](adapter-packages.md)), and follows the boundary recommended in
[registry-and-sandbox.md](registry-and-sandbox.md#the-sandbox).

Status: built (2026-11-12). An adversarial review of the design found 15 problems, three of them
critical; each is answered in [What the design review changed](#what-the-design-review-changed).
B accepted the contract changes that came out of it. A red-team pass on the code followed; its
results are in [Red team](#red-team).

## What changes, in one paragraph

Before this, every adapter's tool code ran in a `node:vm` context inside an Electron utility
process: a full Node process, so one escape from `vm` (which is not a security boundary) reached
everything Valet can. Now tool code runs in **QuickJS compiled to WebAssembly, inside a sandboxed,
hidden Chromium window** with no Node, no storage that outlives it, and a session that refuses
every request. The only things tool code can call are the capabilities the runtime injects: the
page, the session, confirm, and, for each exception the manifest declares, one more capability the
main process enforces (`ctx.local`: a file reader limited to the declared paths, an HTTPS client
limited to the declared hosts, and so on). An adapter that declares `unsandboxed` keeps the utility
process, and its approval says so in the strongest words Valet has. Since describing a draft now
runs in the sandbox, C's guard against installing drafts is gone.

## Goals and non-goals

- **Goals:** tool code can't read a file, start a process, reach the network or touch another
  adapter's state except through an injected capability; an escape from the interpreter lands in a
  process that can do nothing either; exceptions are flexible enough for local-data adapters
  (Nick, 2026-11-12); each is enforced in the main process and shown in the permission diff; the
  Woolworths MVP path behaves exactly as before.
- **Non-goals:** `page.evaluate` source, which already runs in the tool partition's isolated world
  under Chromium's renderer sandbox and the egress allowlist (unchanged); the authoring tools (F);
  the approval card itself (D builds it from the lines computed here); the auth flow, which runs no
  adapter code.

## The journeys it serves

- **J3, an agent writes an adapter:** a draft's schemas are described, and its input checked, in a
  sandbox window of its own, so nothing nobody has approved runs anywhere that matters.
- **J5, repair:** the same, for a replacement version.
- **Local data** (Nick's "expose local data too"): an adapter declares, say, read access to
  `~/Documents/Receipts/**`; the review shows "Read ~/Documents/Receipts/**" with the author's
  reason; once approved, tool code reads those files through `ctx.local.files`, and nothing else.
  The example is [`examples/local-portfolio`](../examples/local-portfolio).

## Options considered

The full comparison is in [registry-and-sandbox.md](registry-and-sandbox.md#options):

| Option                                  | Why not on its own                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `node:vm` in a utility process (before) | Not a boundary; the process is full Node and Electron ignores `--permission` there.                        |
| isolated-vm                             | In-process native addon: an escape lands in the main process; rebuilt per Electron ABI.                    |
| SES / Hardened JS                       | Discipline inside one realm, not a boundary.                                                               |
| Sandboxed hidden renderer alone         | Starts with the whole web platform (storage, workers, iframes, timers); closing it is deny-by-enumeration. |
| QuickJS in WebAssembly alone, in main   | Deny-by-construction, but an interpreter bug lands in the main process.                                    |
| **QuickJS inside a sandboxed renderer** | **Chosen.** Each covers the other's gap.                                                                   |

QuickJS build: **quickjs-ng** through `quickjs-emscripten-core` 0.32.0 and
`@jitl/quickjs-ng-wasmfile-release-sync` 0.32.0 (published 2026-02-16; MIT). The sync build is
enough: capability calls are messages, so nothing inside QuickJS ever blocks on the host. The real
Woolworths tool script (836 kB, zod included) evaluates in about 150 ms and describes in 20 ms, and
the three built-ins describe exactly as they do in `vm` (a test pins it).

## The boundary

```
main process (trusted)                         sandbox window, one per adapter version
┌───────────────────────────┐  MessagePort     ┌─────────────────────────────────────────────┐
│ ToolHost / runIsolated    │◀────────────────▶│ preload (isolated world)                     │
│  capability dispatch:     │  JSON only,      │   QuickJS-ng: a fresh wasm instance and      │
│   page.*, session, confirm│  one port per run│   runtime per run: prelude, tool script,     │
│   local.* (exceptions)    │                  │   bootstrap; `send` the only host function   │
│  isPlainJson, size caps   │                  │   heap limit, slice deadline                 │
│  ping watchdog            │                  │                                              │
└───────────────────────────┘                  └─────────────────────────────────────────────┘
                                                session `sandbox:<key>`: in memory, every
                                                request cancelled, deny-all egress proxy behind
                                                that, WebRTC proxied only, no permissions
```

### Inside QuickJS

- The same prelude, tool script and bootstrap as the `vm` worker (now in
  `packages/runtime/src/isolation/bootstrap.ts`), so a tool behaves the same in both, and the
  in-context test helper keeps matching what runs. The bootstrap gains `ctx.local` (below).
- QuickJS has no `require`, `process`, `import()` of anything (no module loader is installed),
  `fetch`, timers, `WebAssembly` or DOM. quickjs-ng's own extras (`performance`, `navigator`,
  `queueMicrotask`, `gc` and the rest) are deleted before the script runs.
- **String compilation is off, as in the `vm` worker:** `eval` and every function constructor
  (plain, async, generator, async generator) throw `EvalError`. Compiling QuickJS code would reach
  nothing more, but a tool (or a zod version) that works here must also work in tests and in the
  unsandboxed path. zod falls back to its non-JIT path, as it does in `vm`.
- `Date` and `Math.random` stay real: zod and adapters use them. The injected clock in
  registry-and-sandbox.md is superseded (B agreed: determinism was never a security property).
- **A fresh WebAssembly instance, with its own linear memory, per run** (and per describe or
  check). The module is compiled once per window; instantiating it is cheap. So no run, even one
  that broke out of QuickJS, finds bytes an earlier run left in the heap.
- **Limits:** a 128 MB heap (`setMemoryLimit`), a 256 kB QuickJS stack (below the WebAssembly
  host's own, so a deep recursion is a `RangeError` tool code can catch rather than a trap), and an
  interrupt handler that stops any one synchronous slice (handling a message and draining the jobs
  it queues) after 5 s. An interrupted run ends as `tool-run/internal` and its window is destroyed.
  Running out of heap is an `InternalError` inside QuickJS; the run fails as `internal` and the
  heap stays capped.
- **Messages out** are JSON text; the preload parses them before posting, so what reaches the port
  is plain data, never a QuickJS handle.

### The window around it

- `BrowserWindow`, never shown, `sandbox: true`, `contextIsolation: true`, no Node anywhere
  (`nodeIntegration`, in workers and subframes, all off), `webSecurity`, no `webviewTag`, no
  devtools, spellcheck, images, WebGL or dialogs, `backgroundThrottling: false`.
- It loads a `data:` page with the CSP `default-src 'none'; script-src 'wasm-unsafe-eval'`. The
  page's CSP governs WebAssembly compilation in the preload's world too (found by trying it on
  Electron 44: with `default-src 'none'` alone, QuickJS doesn't compile). `'wasm-unsafe-eval'`
  allows that and no script of any kind, so the main world stays empty.
- **Its session is `sandbox:<key>`, without `persist:`,** so nothing is written to disk (an e2e
  test checks `Partitions/`). `webRequest.onBeforeRequest` cancels everything but the page itself,
  the session's proxy is a deny-all `egress-proxy.ts` instance (the tested mechanism, not a closed
  port), permission requests and checks and device permissions are refused, downloads are
  prevented, `setWindowOpenHandler` denies, navigation and redirects are prevented, and WebRTC is
  `disable_non_proxied_udp`. The process-wide DNS-prefetch switch already applies.
- **The wasm bytes** come from the main process (`out/preload/quickjs.wasm`, copied by the build),
  sent once when the window starts: a sandboxed preload can't read files. The preload is bundled
  separately (`out/preload/sandbox.cjs`) with the browser build of QuickJS's Emscripten glue.
- **Pooling.** One window per adapter version (`adapter:<hash>`), started on first use and closed
  after 60 s idle; at most 6 at once, the least recently used idle one closing first. Describe and
  check of anything being installed get a window of their own (`one-shot`), closed when that run
  ends, so no two packages being installed share one. Between runs the session's storage is
  cleared, though nothing should be in it.
- **The watchdog is in the main process.** While a run waits, the main process pings the window
  every second; no answer within 3 s (a C-level operation QuickJS's interrupt can't reach, such as
  a pathological regular expression) destroys the window. So do a crash, `unresponsive`, and a
  run that reports it broke. Every run in a destroyed window ends as `tool-run/internal`, and the
  next run starts a fresh window. Calls to one adapter are serialised by the runtime, so usually
  one run is affected.

### What an escape reaches

An escape from QuickJS lands in the preload's isolated world of a sandboxed renderer. From there:
no Node, no files (Seatbelt), no network (`webRequest` cancels, the proxy refuses, UDP is proxied
only), no other adapter's state (its own in-memory session and process), no Valet data. It could
send the main process anything over its port, which is why the main process treats every message
as hostile (`isPlainJson`, size caps, the capability list, in-flight caps), as before. It could ask
for the capabilities its adapter has, which is no more than the adapter has anyway. The e2e suite
`apps/desktop/e2e/sandbox.spec.ts` runs such a script in both worlds of a sandbox window and
checks each of these.

## Exceptions: capabilities, enforced in main

Each exception kind in B's contract becomes capabilities under `ctx.local`
(`packages/core/src/local-access.ts`), built per adapter by `createLocalAccess`
(`packages/sandbox/src/local/`). `ctx.local` always exists; a call for a kind the manifest didn't
declare is refused as `tool-run/not-granted`. Tool code never gets a handle, a descriptor or a
socket: each call is one request and one JSON answer. Each call is audited as `local-access` with
its capability and outcome (never its path or body), is refused once the call is over, and the call
waits for it.

| Kind            | In tool code                                                                                                                                | Enforced in main                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`         | `files.list(dir)`, `.stat(path)`, `.read(path, { encoding })`; with `read-write` also `.write(path, text, { encoding })` and `.mkdir(dir)`. | Below. There is no delete: the contract has none.                                                                                                                                                                                                                                                                                                                                                                                |
| `network`       | `fetch(url, { method, headers, body })` → `{ status, headers, body }`                                                                       | `https:` on 443 only, no credentials in the URL, no IP literals, host matched against the declared patterns. The name is resolved once and **every** answer must be public (no loopback, private, link-local, CGNAT, ULA, NAT64, IPv4-mapped forms of any of those); the socket dials the checked address. Host, cookie, proxy, hop-by-hop and `sec-` headers are refused. Redirects come back, unfollowed. 30 s; 4 MB each way. |
| `local-service` | `service(port, path, { method, headers, body })`                                                                                            | `http://127.0.0.1:<declared port><path>` only; never a name. **Never a port Valet listens on** (every Node server in the main process is recorded as it starts listening, plus Chromium's debugging port if a switch opened one), checked at each call. Same header, time and size rules.                                                                                                                                        |
| `command`       | `run(args, { program, stdin })` → `{ exitCode, stdout, stderr }`                                                                            | The declared program only, `execFile` with no shell, its real path checked again before each run (not a shell or interpreter, not in a folder the person can write to), env of `PATH` and `LANG` only, a fresh temp folder as working folder, 60 s, 4 MB of output. **Under a Seatbelt profile** (below). macOS only: elsewhere `unavailable`.                                                                                   |
| `app`           | `appleScript(bundleId, source)`                                                                                                             | **Refused**, at install and at run time. See [Apple Events, deferred](#apple-events-deferred).                                                                                                                                                                                                                                                                                                                                   |

### Files, in detail

For every call:

1. The path tool code passes must be a valid pattern with no wildcard: absolute or `~/`, no `.` or
   `..`, no doubled slash, no control characters, NFC. `~` expands to the person's home.
2. **It must sit within a declared pattern**, compared by segment in NFC with case folded (what
   APFS treats as the same name): an exact pattern matches only itself, `dir/*` the folder and its
   direct children, `dir/**` the folder and everything below. Writes need a `read-write` pattern.
3. **Its real path** (`realpath`; for a write, of the parent plus the new name) must still sit
   within one of those patterns, by the pattern's root as named or as resolved (so `~/Documents`
   in iCloud Drive still matches), must not `touchesForbiddenPath`, and for a write must be
   `isWritablePath`. A symlink in an allowed folder that points outside it fails here.
4. **Only a regular file is opened**, without following its last component (`O_NOFOLLOW`) and
   non-blocking (`O_NONBLOCK`, so a FIFO swapped in can't hang the open); then its device and inode
   are compared with an `lstat` of the real path, so a swap between 3 and 4 fails. A file with more
   than one hard link is refused: a second name is one the forbidden check never saw.
5. **Caps:** 16 MB per read and per write, 1,000 entries per `list`. A write goes to a new temp file
   in the same folder (mode 0600, `O_EXCL`), the folder's real path is checked again, then it's
   renamed over the target, so a crash never leaves a half-written file.
6. `list` returns name, kind (`file`, `directory`, `other`), size and modified time for the entries
   the patterns cover, leaving out names that aren't NFC. Symlinks are `other` and never followed.

Errors are `ValetError('tool-run', …)` classes only: `not-granted` (outside the patterns),
`denied-path` (forbidden, a symlink escape, a hard link, not a regular file), `not-found`,
`invalid` (a bad argument, too big). Never the OS's words or the path.

**Residual:** step 4 checks the last component only. A symlink swapped into a _parent_ folder
between steps 3 and 4 would be followed by the open and the check alike. Tool code can't create
symlinks (there is no such capability), so this needs another process on the Mac racing the call;
`openat`-style resolution isn't available from Node.

### The command profile

A program is as broad as what it does with its arguments (`/bin/cp` reads anything), so `command`
runs it as `sandbox-exec -p <profile> <program> <args>`, with this profile
(`commandProfile` in `packages/sandbox/src/local/command.ts`):

```
(version 1)
(allow default)
(deny network*)
(deny appleevent-send)
(deny process-exec)
(allow process-exec (literal "<the program's real path>"))
(deny file-write*)
(allow file-write* (subpath "<its temp folder>") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd")
                  (global-name "com.apple.coreservices.appleevents")
                  (global-name-regex #"^com\.apple\.pasteboard"))
(deny file-read* file-write* (subpath "<each never-grantable place under the home, as named and resolved>"))
```

So a declared program can read the person's ordinary files (the card says "which can read your
files"), but not Valet's data, keychains, credential stores, browser profiles or shell startup
files; it can write only in its own temp folder; it can't reach the network, send Apple Events,
open URLs, read the pasteboard or run anything else. `sandbox-exec` is deprecated but works on
every current macOS; the macOS CI tests pin the profile's behaviour, and if Apple removes it,
`command` becomes `unavailable` rather than running unconfined.

### Apple Events, deferred

The review showed the contract's premise for `app` false. Free-form AppleScript gets `run script`
and scripting additions that run in the sender's own process (reading any file, the clipboard), and
every app on the old allow-list can exfiltrate or run code (Calendar and Reminders alarms that send
mail or open files; Notes, Numbers and Photos save and export anywhere). No OS jail around
`osascript` constrains what the target app does with an event. So `ALLOWED_APPS` is now empty in the
contract (B, PR #82), the manifest schema refuses every `app` exception, `PackageManager.prepare`
refuses one too, and `ctx.local.appleScript` is always `not-granted`. It comes back as typed,
per-app operations (most likely EventKit and Contacts through a Swift helper, with alarms,
attachments and file operations left out), as a contract change with its own review.

### Unsandboxed adapters

`mode: 'unsandboxed'` keeps the utility process with the `vm` context, so tool code that escapes
`vm` has all of Node. It also gets `ctx.local` with no declared patterns: any path not forbidden,
any public HTTPS host, any local port Valet doesn't use, any program not forbidden (Seatbelt still
applies). The hard limits protect Valet and the person's credentials from honest-but-buggy code;
a hostile unsandboxed adapter isn't stopped by them, which is what its review says: "Runs without
the sandbox: it can reach anything you can on this Mac." Its one diff line is the critical
`sandbox-mode` line; it's Mac only (B).

### Drafts and trials

`createLocalAccess(declaration, 'none', …)` refuses everything. Describe and check of any package
being installed run in a one-shot sandbox window with no capabilities at all. F's test runs and
trials of drafts must use the sandbox with `'none'`: only an approved version gets its exceptions.

## Which process runs what

| Source and mode            | describe and check | runs                                      |
| -------------------------- | ------------------ | ----------------------------------------- |
| any source, sandboxed      | one-shot window    | the version's window, with its exceptions |
| any source, `unsandboxed`  | one-shot window    | utility process (`vm`), open `local`      |
| draft not yet approved (F) | one-shot window    | a sandbox window, no exceptions           |

The three built-ins declare nothing, so they run sandboxed with no exceptions. The Woolworths
journey e2e suite (14 tests: approval, grants, login with SMS code, cart changes, the breaker,
the audit chain) passes unchanged with tool code in the sandbox.

## The permission diff

`sandboxPermissionChanges(previous, next)` (`packages/core/src/sandbox-diff.ts`) gives D's card its
lines: becoming unsandboxed is one `sandbox-mode` / `critical` line, "Runs without the sandbox";
going back is `narrowed` / `low`; each added exception is a `sandbox-exception` line at
`exceptionRisk`, in the app's words ("Read ~/Documents/Receipts/**", "HTTPS from tool code to
api.example.com", "This Mac's service on port 11434", "Run /usr/bin/sips, which can read your
files"); each removed one is `low`.

The review screen's `PermissionDiff` has a `sandbox` section (`sandboxDiff` in
`permission-diff.ts`): whether the version is unsandboxed and became so, the author's reason, and
each exception added, removed or kept with the author's purpose beside it. The screen leads with a
danger banner for an unsandboxed version, lists "On this Mac" when there are exceptions, and counts
new ones in "This update asks for more". Where a version came from no longer decides whether it's
called unsandboxed: its manifest does.

## Lifting C's guard

`PackageManager.prepare` and `AdapterStore.put` no longer refuse `draft`; the store's
`draft-unsandboxed` problem is gone. The app's `runtime.start` is the sandbox pool's one-shot
factory, so describing anything, built-ins included, runs in the sandbox. A test pins that a draft
is described through the factory it's given and installs.

## Failure cases

| What happens                                     | Result                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| The wasm file is missing or doesn't compile      | The window reports not ready and is destroyed; every sandboxed run fails `tool-run/internal`. |
| A window crashes, or doesn't answer the ping     | Its runs fail `tool-run/internal`; it's destroyed; the next run starts a new one.             |
| A slice runs past 5 s                            | The run fails `tool-run/internal`; the window is destroyed.                                   |
| Tool code floods `send`                          | Messages over `MAX_MESSAGE_CHARS` or calls beyond `MAX_IN_FLIGHT` end the run as `invalid`.   |
| A call for an undeclared kind                    | `tool-run/not-granted`; the run continues (tool code may handle it).                          |
| A path outside the patterns, or a symlink escape | `not-granted` or `denied-path`, audited as `local-access` with that class.                    |
| The app quits mid-run                            | Windows close with the app; nothing on disk to clean.                                         |

There is deliberately no fallback from the sandbox to the utility process for a sandboxed adapter.

## What the design review changed

A fresh adversarial reviewer read the first draft of this document against the code. Its findings
and what became of each:

| #   | Finding                                                                               | Severity | Now                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | AppleScript under `sandbox-exec` still reads any file and the target app can run code | critical | `app` refused everywhere until typed per-app operations exist; `ALLOWED_APPS` emptied (B).                                                         |
| 2   | `command` bypasses the files rules (`/bin/cp` reads keychains)                        | critical | Seatbelt profile around every command; card says it can read files.                                                                                |
| 3   | `default-src 'none'` blocks WebAssembly                                               | critical | Confirmed on Electron 44; CSP is `default-src 'none'; script-src 'wasm-unsafe-eval'`.                                                              |
| 4   | DNS rebinding unless the checked address is the one dialled                           | high     | One lookup, every answer checked, that address dialled; IPv4-mapped and NAT64 forms unwrapped.                                                     |
| 5   | `local-service` could drive Valet's own endpoints                                     | high     | Every port Valet listens on is refused, checked at each call.                                                                                      |
| 6   | A fresh QuickJS runtime still shares wasm linear memory                               | high     | A fresh wasm instance per run.                                                                                                                     |
| 7   | Parent-folder symlink swap between check and open                                     | medium   | Residual, documented: tool code can't make symlinks.                                                                                               |
| 8   | NFKC doesn't match APFS; firmlinks                                                    | medium   | Allow-matching uses NFC + case fold; the forbidden check keeps NFKC (only refuses more). Node's `realpath` doesn't surface `/System/Volumes/Data`. |
| 9   | Seatbelt profile under-specified                                                      | medium   | Specified above and in the contract (B); tested on macOS CI.                                                                                       |
| 10  | Determinism and `eval` differ from `vm`                                               | medium   | Real clock kept (B agreed); `eval` and `Function` disabled to match `vm`.                                                                          |
| 11  | Unsandboxed adapters with top-level Node use can't be described                       | medium   | Not a change: the `vm` context has no Node either, so such a script fails there too.                                                               |
| 12  | No cap on sandbox windows                                                             | medium   | At most 6, least recently used idle one closed first.                                                                                              |
| 13  | C-level operations aren't interruptible                                               | medium   | Main-process ping watchdog destroys a window that stops answering.                                                                                 |
| 14  | Proxy specified two ways                                                              | low      | The deny-all egress proxy.                                                                                                                         |
| 15  | Unsandboxed `local` is implicit                                                       | low      | Stated above; its review banner says it can reach anything.                                                                                        |

## Red team

To be filled in from the red-team pass on the code.

## Proving it

- `packages/sandbox/test/quickjs.test.ts`: the runtime's honest and hostile tools in QuickJS
  (globals, constructors, imports, capability errors, prototype pollution, odd arguments, floods,
  cyclic output, a run's state looked for by the next), plus QuickJS's own extras, string
  compilation, never-yielding loops and promise chains at the slice deadline, a memory bomb at the
  heap limit, a stack bomb, and the built-ins describing as in `vm`.
- `local-files.test.ts`: patterns, climbing, Unicode and case, symlinks out of and into allowed
  folders, a symlinked root, hard links, FIFOs, size caps, error wording, writes through symlinks,
  the open reach, and a raced swap.
- `local-net.test.ts`: declared and undeclared hosts, URLs, IP literals in every spelling, DNS
  answers with any non-public address, redirects, refused headers, size caps, the public-address
  ranges, local-service ports and Valet's own.
- `local-command.test.ts`: no shell, empty environment, undeclared programs, shells, a link to a
  shell, a program in a writable folder, arguments, deadline, the profile's text, and on macOS the
  profile keeping a program out of `~/.ssh`, off the network and out of `~/Documents`.
- `example-adapter.test.ts`: the example package loads and runs through its one exception.
- `apps/desktop/e2e/sandbox.spec.ts`: the second layer, in a real sandbox window.

## The example local-data adapter

[`examples/local-portfolio`](../examples/local-portfolio): reads holdings from
`~/Documents/Valet/portfolio.csv` (a `files` read exception on that one file) and values them at
Yahoo Finance's latest prices through the page, as the built-in adapter does. It installs from a
folder in development builds. It shows the shape an agent's local-data adapter should take: the
narrowest path that works, and a purpose that says why.

## What this needs from other streams

- **B:** done in PR #82 (`ALLOWED_APPS` emptied, the Seatbelt rules and Valet's own ports in the
  contract).
- **D:** build the `adapter-install` card's `changes` from `sandboxPermissionChanges`, set
  `unsandboxed` from the manifest rather than the origin, and word a `command` line as reading
  files.
- **F:** describe, tests and trials of drafts go through the sandbox with `createLocalAccess(…,
  'none', …)`.
