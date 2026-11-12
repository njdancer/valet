# The adapter sandbox and its exceptions

Design for workstream I of [plan-agent-run.md](plan-agent-run.md): adapter tool code runs in a
sandbox by default, and reaches local data only through exceptions its manifest declares and the
person approves (D73). It builds on B's contract (`packages/core/src/sandbox.ts`,
[agent-run-security.md](agent-run-security.md#sandbox-exceptions)) and C's packages
([adapter-packages.md](adapter-packages.md)), and follows the boundary recommended in
[registry-and-sandbox.md](registry-and-sandbox.md#the-sandbox).

Status: draft for review, 2026-11-12.

## What changes, in one paragraph

Today every adapter's tool code runs in a `node:vm` context inside an Electron utility process: a
full Node process, so one escape from `vm` (which is not a security boundary) reaches everything
Valet can. After this change, tool code runs in **QuickJS compiled to WebAssembly, inside a
sandboxed, hidden Chromium renderer** with no Node, no storage that outlives a run, and a session
that cancels every request. The only things tool code can call are the capabilities the runtime
injects: the page, the session, confirm, and, for each exception the manifest declares, one more
capability the main process enforces (a file reader limited to the declared paths, an HTTPS client
limited to the declared hosts, and so on). An adapter that declares `unsandboxed` keeps today's
utility process, and its approval says so in the strongest words Valet has. With the sandbox real,
drafts can be described and installed, so C's guard comes off.

## Goals and non-goals

- **Goals:** tool code can't read a file, start a process, reach the network or touch another
  adapter's state except through an injected capability; an escape from the interpreter lands in a
  process that can do nothing either; exceptions are flexible enough for local-data adapters
  (Nick, 2026-11-12) and each is enforced in the main process; every exception shows in the
  permission diff; the Woolworths MVP path is unchanged in behaviour.
- **Non-goals:** `page.evaluate` source, which already runs in the tool partition's isolated world
  under Chromium's renderer sandbox and the egress allowlist (unchanged); the authoring tools (F);
  the approval card itself (D builds it from the lines this stream computes); a sandbox for the
  auth flow, which runs no adapter code.

## The journeys it serves

- **J3, an agent writes an adapter:** a draft's schemas are described, and its tests run, in the
  sandbox with no exceptions, so nothing runs before anyone approves it with more than a scratch
  page.
- **J5, repair:** the same, for a replacement version.
- **Local data** (Nick's "expose local data too"): an adapter declares, say, read access to
  `~/Documents/Receipts/**`; the card says "Can read ~/Documents/Receipts/ on your Mac"; once
  approved, tool code reads those files through `ctx.local.files`, and nothing else.

## Options considered

The full comparison is in [registry-and-sandbox.md](registry-and-sandbox.md#options); the
short version, checked again on 2026-11-12:

| Option                                  | Why not on its own                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `node:vm` in a utility process (today)  | Not a boundary; the process is full Node and Electron ignores `--permission` there.                        |
| isolated-vm                             | In-process native addon: an escape lands in the main process; rebuilt per Electron ABI.                    |
| SES / Hardened JS                       | Discipline inside one realm, not a boundary.                                                               |
| Sandboxed hidden renderer alone         | Starts with the whole web platform (storage, workers, iframes, timers); closing it is deny-by-enumeration. |
| QuickJS in WebAssembly alone, in main   | Deny-by-construction, but an interpreter bug lands in the main process.                                    |
| **QuickJS inside a sandboxed renderer** | **Chosen.** Each covers the other's gap.                                                                   |

QuickJS build: **quickjs-ng** through `quickjs-emscripten-core` 0.32.0 and
`@jitl/quickjs-ng-wasmfile-release-sync` 0.32.0 (published 2026-02-16; MIT). The sync build is
enough: capability calls are messages, so nothing inside QuickJS ever blocks on the host. A spike
on 2026-11-12 ran the real Woolworths tool script (836 kB, zod included) under it: evaluated in
144 ms, `describe` in 20 ms, and `search_products` made its first `page.fetch` call as in `vm`.

## The boundary

```
main process (trusted)                         sandbox renderer, one per adapter hash
┌───────────────────────────┐  MessagePort     ┌─────────────────────────────────────────────┐
│ ToolHost / runIsolated    │◀────────────────▶│ preload (isolated world)                     │
│  capability dispatch:     │  JSON only,      │   QuickJS-ng (wasm), a fresh runtime per run │
│   page.*, session, confirm│  one port per run│     prelude, tool script, bootstrap          │
│   local.* (exceptions)    │                  │     `send` is the only host function         │
│  isPlainJson, size caps   │                  │   memory limit, interrupt deadline           │
└───────────────────────────┘                  └─────────────────────────────────────────────┘
                                                session `sandbox:<hash>`: in memory, every
                                                request cancelled, proxy to a deny-all port,
                                                WebRTC proxied only, no permissions
```

### Inside QuickJS

- The same prelude, tool script and bootstrap as the `vm` worker (`worker.ts`), so a tool behaves
  the same in both, and the in-context test helper keeps matching what runs. The bootstrap gains
  `ctx.local` (below).
- QuickJS has no `require`, `process`, `import()` of anything (no module loader is installed),
  `fetch`, timers, `WebAssembly`, `SharedArrayBuffer` or DOM. `eval` and `Function` exist but only
  compile more QuickJS code, which reaches nothing more. `Date` and `Math.random` stay: zod and
  adapter code use them, and with no shared memory and no clock finer than a millisecond there's
  little to time.
- **One QuickJS runtime per run** (and per describe or check), disposed when it ends, so no two
  calls share a heap, even of the same adapter.
- **Limits:** a 128 MB heap limit per runtime (`setMemoryLimit`), a 1 MB stack limit, and an
  interrupt handler that stops any single synchronous slice (handling one message and draining the
  job queue) after 5 s of wall time. A run that is interrupted or out of memory ends as
  `tool-run/internal`. The host's own deadline (the call's abort) kills the run regardless.
- **Messages out** are JSON text; the preload parses them before posting, so what reaches the port
  is plain data, never a QuickJS handle. Messages in are delivered as JSON text.

### The renderer around it

- `BrowserWindow`, never shown, `sandbox: true`, `contextIsolation: true`, `nodeIntegration:
false`, `webSecurity: true`, no `webviewTag`, spellcheck off, `backgroundThrottling: false`.
- It loads `about:blank`-equivalent HTML (a `data:` URL with a `default-src 'none'` CSP), so the
  main world has nothing in it. The preload runs QuickJS in the isolated world.
- **Session `sandbox:<adapterHash>`, without `persist:`**, so nothing is written to disk and no two
  adapter versions share one. Its `webRequest.onBeforeRequest` cancels everything (the `data:`
  page itself excepted), its proxy is `127.0.0.1:9` with no bypass (a closed port: anything that
  slips past `webRequest` goes nowhere), `setPermissionRequestHandler` and
  `setPermissionCheckHandler` refuse everything, and WebRTC is `disable_non_proxied_udp`.
  `setWindowOpenHandler` denies, `will-navigate` is prevented. The process-wide DNS-prefetch switch
  already applies.
- **The WebAssembly bytes** come from the main process, sent once when the renderer starts, from
  the file the app ships. The preload can't read files (sandboxed), and this keeps a 3 MB base64
  copy out of the bundle.
- **Pooling.** One renderer per adapter hash, started on first use and closed after 60 s idle.
  Each run gets its own `MessageChannelMain` port and its own QuickJS runtime. A run's `kill`
  disposes its runtime and closes its port. If the renderer crashes, hangs (no answer to a ping in
  2 s while a run waits), or a run's slice is interrupted, the whole renderer is destroyed: every
  run in it fails as `tool-run/internal`, and the next run starts a fresh one. Because calls to one
  adapter are serialised by the runtime anyway, there's usually one run per renderer.
- **Between runs** the session's storage and cache are cleared. There's nothing in them to clear
  (the main world runs nothing and every request is cancelled), but it's cheap and it covers a
  second-layer escape that wrote something.

### What an escape reaches

An escape from QuickJS lands in the preload's isolated world of a sandboxed renderer. From there:
no Node, no files (Seatbelt), no network (`webRequest` cancels, the proxy is closed, UDP is
proxied only), no other adapter's state (its own in-memory session, its own process), no Valet
data. It could send the main process anything over its port, which is why the main process treats
every message as hostile (`isPlainJson`, size caps, the capability list, in-flight caps) exactly as
it does today. It could ask for the capabilities its adapter has, which is no more than the
adapter has anyway.

## Exceptions: capabilities, enforced in main

Each exception kind in B's contract becomes one capability under `ctx.local`. The bootstrap always
defines `ctx.local`; a call to a kind the manifest didn't declare is refused by the main process as
`tool-run/not-granted`. Tool code never gets a handle, a file descriptor or a socket: each call is
one request and one JSON answer.

| Kind            | In tool code                                                                                                                                                                                                                     | Enforced in main                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`         | `ctx.local.files.list(dir)`, `.stat(path)`, `.read(path, { encoding: 'utf8' \| 'base64' })`, and with `read-write`, `.write(path, text, { encoding })`, `.mkdir(dir)`. `.remove` is not offered: deleting isn't in the contract. | Below.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `network`       | `ctx.local.fetch(url, { method, headers, body })` → `{ status, headers, body }`                                                                                                                                                  | `https:` only, port 443, host matched against the declared patterns; no credentials, cookies or proxy-auth headers sent; redirects not followed (the 3xx comes back); the name must resolve to public addresses only (no loopback, private, link-local, CGNAT, ULA; the same list as relay.md), checked on the address actually dialled; 30 s timeout; 4 MB body cap; text or base64 body.                            |
| `local-service` | `ctx.local.service(port, path, { method, headers, body })`                                                                                                                                                                       | `http://127.0.0.1:<declared port><path>` only, path must start with `/`; same header, timeout and size rules; never another port, never a name (so no DNS).                                                                                                                                                                                                                                                           |
| `command`       | `ctx.local.run(args, { stdin })` → `{ exitCode, stdout, stderr }`                                                                                                                                                                | The declared program only, `execFile` with no shell, its real path re-checked before each run (still not forbidden, still not user-writable), an empty environment apart from `PATH=/usr/bin:/bin` and `LANG`, working folder a fresh empty temp folder, 60 s timeout, 4 MB output cap, at most 100 args of 4 kB.                                                                                                     |
| `app`           | `ctx.local.appleScript(source)` → the result as text                                                                                                                                                                             | Run as `osascript -e 'tell application id "<bundle>"' … ` under `sandbox-exec` with a Seatbelt profile that allows Apple Events **only to that bundle id** and denies process execution, network and file writes; the source is length-capped (20 kB). So `do shell script`, other apps, and `run script` reach nothing, enforced by the OS, not by parsing the script. macOS only; elsewhere `tool-run/unavailable`. |

### Files, in detail

The contract says paths are resolved with `realpath` and the opened file re-checked. Concretely,
for every call:

1. The path tool code passes must itself satisfy `isPathPattern` minus wildcards: absolute or
   `~/`, no `.` or `..`, no control characters, NFC. `~` expands to the person's home.
2. **Matched against the declared patterns** by segment: an exact pattern matches that path only;
   `dir/*` matches direct children of `dir`; `dir/**` matches anything below `dir` (and `dir`
   itself for `list` and `stat`). Matching is on folded (NFKC, case) segments, like the
   forbidden-path check. Read-write patterns allow writes; read patterns don't.
3. **`realpath`** of the target (for a write to a new file, of its parent, plus the new name). The
   real path must still match a declared pattern **after resolving the pattern's own root with
   `realpath`** (so `~/Documents` living in iCloud Drive still matches), and must not
   `touchesForbiddenPath(real, home)`. A symlink inside an allowed folder that points outside it
   therefore fails.
4. **Open without following** the last component (`O_NOFOLLOW`), then `fstat` the descriptor and
   compare device and inode with an `lstat` of the real path: a swap between steps 3 and 4 fails.
   Regular files only (no devices, FIFOs or sockets). A file with more than one hard link is
   refused, since a hard link is a second name the forbidden check can't see.
5. **Caps:** 16 MB per read, 16 MB per write, 1,000 entries per `list`. Writes go to a temp file in
   the same folder, then `rename`, so a crash never leaves a half-written file; mode 0600 for new
   files.
6. `list` returns name, kind (`file`, `directory`, `other`), size and modified time, and leaves out
   entries whose names aren't valid NFC text. Symlinks are listed as `other` and never followed.

Errors cross as `ValetError('tool-run', …)` classes only: `not-granted` (outside the declared
patterns, or a kind not declared), `denied-path` (forbidden, a symlink escape, a hard link),
`not-found`, `invalid` (bad argument, too big). Never the OS message, never the path.

### Unsandboxed adapters

`mode: 'unsandboxed'` keeps today's utility process with the `vm` context, so tool code that
escapes `vm` has all of Node. It also gets `ctx.local` with **no declared patterns**: any path not
forbidden, any public HTTPS host, any local port, any program not forbidden, any app on
`ALLOWED_APPS`. The hard limits (`FORBIDDEN_PATHS`, forbidden commands, writable roots for writes)
still apply, because they protect Valet and the person's credentials from honest-but-buggy code as
much as from hostile code; a hostile unsandboxed adapter isn't stopped by them, which is exactly
what its card says: "Runs without the sandbox: it can reach anything you can on this Mac." Critical
and Mac only, per B.

### Drafts and trials

Before approval nothing about a draft is trusted. Describe, check and test runs of a `draft` source
run in the sandbox **with no exceptions**, whatever the manifest declares, and an unsandboxed
draft is described in the sandbox too (describe needs no capabilities). F's live trials pass the
same: `ctx.local` refuses every call with `not-granted`. Only an approved version gets its
exceptions.

## Which process runs what

| Source and mode            | describe and check | runs                                  |
| -------------------------- | ------------------ | ------------------------------------- |
| built-in, sandboxed        | sandbox            | sandbox, with its declared exceptions |
| folder or draft, sandboxed | sandbox            | sandbox, with its declared exceptions |
| any source, `unsandboxed`  | sandbox            | utility process (`vm`), open `local`  |
| draft not yet approved (F) | sandbox            | sandbox, no exceptions                |

All three built-ins declare nothing, so they run sandboxed with no exceptions. The MVP path
(Woolworths) changes process, not behaviour; the e2e suite runs it through the sandbox.

## The permission diff

`sandboxPermissionChanges(previous, next)` in core turns `sandboxWidening` into
`PermissionChange` lines for D's card:

- becoming unsandboxed: `sandbox-mode` / `added` / `critical`, item "Runs without the sandbox";
  becoming sandboxed again: `sandbox-mode` / `narrowed` / `low`;
- each added exception: `sandbox-exception` / `added`, at `exceptionRisk`, items in the app's
  words ("Read ~/Documents/Receipts/**", "Write ~/Documents/Exports/*", "Apple Events to
  com.apple.reminders", "HTTPS to api.example.com", "127.0.0.1 port 11434", "Run /usr/bin/sips");
- each removed exception: `removed`, `low`.

The review screen (`PermissionDiff` in `shared/api.ts`) gains a `sandbox` section with the mode on
each side and the exceptions added, removed and unchanged, each with its purpose shown as the
author's claim. `origin !== 'builtin'` no longer means unsandboxed: the `unsandboxed` flag comes
from the manifest.

## Lifting C's guard

`PackageManager.prepare` and `AdapterStore.put` stop refusing `draft`. Describe for every source
goes through the sandbox (`runtime.start` is the sandbox factory). The store's
`draft-unsandboxed` error stays in the union for old callers but is no longer raised. A test pins
that a draft's describe runs in the sandbox factory and never in the utility process.

## Failure cases

| What happens                                     | Result                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| The wasm file is missing or doesn't compile      | Every sandboxed run fails `tool-run/internal`; logged once; nothing falls back to the `vm` path. |
| Renderer crashes, or doesn't answer the ping     | Its runs fail `tool-run/internal`; the renderer is destroyed; the next run starts a new one.     |
| A run's slice exceeds 5 s, or its heap 128 MB    | That renderer is destroyed (its QuickJS state is suspect); the run fails `tool-run/internal`.    |
| Tool code floods `send`                          | Messages over `MAX_MESSAGE_CHARS` or calls beyond `MAX_IN_FLIGHT` end the run as `invalid`.      |
| A capability call for an undeclared kind         | `tool-run/not-granted`; the run continues (tool code may handle it).                             |
| A path outside the patterns, or a symlink escape | `not-granted` or `denied-path`; audited as the call's error class like any other.                |
| The app quits mid-run                            | Renderers close with the app; no state on disk to clean.                                         |

There is deliberately no fallback from the sandbox to the utility process for a sandboxed adapter.

## Proving it (the hostile suite)

Unit tests in `packages/sandbox` run QuickJS in Node, through the same evaluator the preload uses,
with every hostile tool from `runtime/test/isolation/hostile-tools.ts` plus QuickJS-specific ones:
`require`, `process`, `import()`, `globalThis.constructor.constructor`, `fetch`, `WebAssembly`,
`SharedArrayBuffer`, `Atomics`, `std`/`os` modules, an infinite loop, a memory bomb, a stack bomb,
an unbounded promise chain, 10,000 capability calls, a cyclic or huge message, a reply with a
prototype on the way in, a run that keeps going after `kill`, and state left by one run looked for
by the next. The exception capabilities get their own suite: `..` and `~` tricks, Unicode and case
folding, symlinks out of an allowed folder, a symlink swapped in after the check, hard links, FIFOs,
over-size reads and writes, forbidden paths under allowed-looking names, DNS answers that point at
loopback or private ranges, redirects, a local-service call to another port, a command whose real
path is a shell, and an AppleScript that tries `do shell script` (macOS CI).

Electron e2e (macOS CI and Linux under xvfb) covers the second layer: a script run directly in the
sandbox renderer, as if QuickJS had been broken, must fail to make any request (`fetch`,
WebSocket, WebRTC, `<link rel=dns-prefetch>`, checked against a fake site's counters), reach Node,
or find another adapter's or an earlier run's storage; and after the runs, nothing under
`userData/Partitions` belongs to a `sandbox:` partition. And the built-in adapters' e2e runs pass
through the sandbox unchanged.

Then a red-team agent, given this document and the code but not the tests, tries to get tool code
to read a file it didn't declare, reach a host it didn't declare, or affect another adapter.

## The example local-data adapter

`examples/adapters/portfolio`: reads holdings from `~/Documents/Valet/portfolio.csv` (a `files`
read exception on that one path) and values them with Yahoo Finance's public chart API. It installs
from a folder in development builds; its tests run it in the sandbox against a temp home with a
fake site. It shows the shape an agent's local-data adapter should take: the narrowest path that
works, a purpose that says why.

## What this needs from other streams

- **B:** two additive contract changes: `ToolContext.local` (the capability shapes above) and
  `sandboxPermissionChanges`. No change to `sandbox.ts`'s schema.
- **C:** none beyond lifting the guard, done here.
- **D:** build the `adapter-install` card's `changes` from `sandboxPermissionChanges` and set
  `unsandboxed` from the manifest, not from the origin.
- **F:** describe, tests and trials of drafts go through the sandbox factory with exceptions off
  (`exceptions: 'none'`).
