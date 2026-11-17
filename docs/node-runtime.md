# The Node runtime

Status: **Built, not yet used by any adapter.** This is workstream C of
[adapter-kinds.md](adapter-kinds.md) (F3). It gives `raw` adapters a place to run. Workstream F
turns `raw` adapters on and wires this runtime into checks, trials and calls. Workstream A's egress
broker supplies the tunnels. The code is in `packages/node-runtime`.

A `raw` adapter is agent-written code plus real npm packages. So it is treated as hostile, and so
are its dependencies. Three layers stand between it and the Mac. Only the first is the security
boundary:

1. **The Seatbelt profile.** The operating system refuses anything the profile doesn't allow.
2. **Node's permission model** (`--permission`). Node refuses child processes, workers, native
   addons, WASI, the inspector, and files outside the allowed paths.
3. **The network shim.** It exists for compatibility only. It points ordinary npm code at the
   tunnels.

## A call

Each tool call gets its own process. The steps are:

1. Valet makes a fresh temporary folder. It becomes the process's `HOME`, `TMPDIR` and working
   folder.
2. Valet asks the broker for one tunnel per declared endpoint (below).
3. Valet generates the profile for those paths and ports.
4. Valet runs `sandbox-exec -p <profile> <node> --permission … runtime-host.cjs`. The environment
   holds only `HOME`, `TMPDIR` and `LANG`, so `NODE_OPTIONS` and the like never reach it. The
   heap is capped (256 MB by default).
5. On file descriptor 3, Valet sends `boot` (the bootstrap and the tunnel ports), then the same
   messages every isolated runtime speaks (`init`, `run`, `reply`, `abort`, `describe`,
   `check`). `runIsolated`, `describeIsolated` and `checkInputIsolated` in `@valet/runtime` drive
   it, exactly as they drive the `vm` and QuickJS processes. The channel is untrusted.
6. When the call ends, however it ends, Valet kills the process (SIGKILL), closes the tunnels and
   deletes the folder. A lifetime cap (10 minutes) backs up the tool host's own deadline.

The design doc says "one process per adapter hash, killed when idle". This build keeps one process
per call instead. That is stronger: no state carries between calls, and nothing outlives one. Node
starts in well under a second, so the cost is small.

The runtime is macOS only. If `sandbox-exec` is missing, the runtime is `unavailable`. It never
runs unconfined. Tests off macOS pass `withoutSeatbelt`, and the app never sets it.

## The profile

`nodeRuntimeProfile` in `profile.ts` generates it. It denies by default, then allows back only:

- **Running programs:** executing the Node binary itself, which is how `sandbox-exec` starts it.
  No other program can run, and nothing can fork, Node included.
- **Reading:** the Node binary, the host script, the system libraries and frameworks
  (`/usr/lib`, `/System/Library/Frameworks` and `PrivateFrameworks`, the dyld cache), time zone
  data, a few character devices, and the adapter's declared read paths.
- **Folder metadata:** for each folder on the way to an allowed file, so path resolution works.
  These are literals, so a folder can't be listed and nothing inside it can be read.
- **Writing:** the process's temporary folder, and declared read-write paths.
- **Network:** TCP to the tunnels' loopback ports, and nothing else. No DNS, no other loopback
  port (Valet's own and other adapters' tunnels included), no UDP, no Unix sockets.
- **The process itself:** signals and process information for itself only, and a fixed list of
  `sysctl` values (CPU, memory and OS version, but not the process table).

No Mach service is allowed at all. So there is no pasteboard, Keychain, security services, launch
services, Apple Events or directory services. The never-grantable places (`FORBIDDEN_PATHS` under
the home) are denied again as the last rule, so no declared path can reopen them, even through a
link.

Paths are resolved before they go into the profile, and each one is quoted. A path with a control
character is refused. Declared paths are checked against `touchesForbiddenPath` twice: once as
named, and once resolved.

The protocol host (workstream D) runs Valet's own Node code under the same generator, with its own
host script (the `hostScript` input).

## Tunnels

This is the seam with the broker (`tunnels.ts`):
`OpenTunnels = (endpoints) => Promise<{ ports, close }>`.

For each process, the broker opens one listener on `127.0.0.1` per endpoint. Whatever connects to
a listener is carried to that endpoint and nowhere else. The broker applies its own checks to each
connection: the SNI check, pacing and the upload budget.

The tunnels are opened when the process starts and closed when the call ends. So the byte counts
for one connection belong to one call. Endpoints are written `host:port`, lowercased, with IPv6
addresses unbracketed (`parseEndpoint`).

One port per endpoint, rather than one CONNECT port with a token, keeps the shim synchronous and
transparent. Code that goes around the shim can reach the same ports and nothing more.

## The shim

The host script patches two things:

- **`net.Socket.prototype.connect`.** A connection to a declared `host:port` goes to its tunnel
  instead. Everything built on it follows: `tls`, `http`, `https`, and the global `fetch`. Node
  computed SNI, certificate checks and the `Host` header from the real name before the patch
  rewrote the address, so they all use the real host. An undeclared host or port fails with
  `EVALETDENIED` before anything is sent.
- **`dns.lookup`.** Each declared host name gets a fixed address in `198.18.0.0/15`, a range that
  is never routed. A connection to that address and a declared port goes to the right tunnel.
  Any other name fails with `ENOTFOUND`.

## Dependencies

- **The lockfile.** `valet-lock.json` sits at the top of the package (`packages/core/src/dependencies.ts`).
  It lists the direct dependencies with their ranges, and every package by `name@version` with its
  sha512 integrity, tarball URL and resolved dependencies. The schema refuses:
  - a dangling or misnamed reference;
  - a package that nothing reaches;
  - a non-sha512 integrity;
  - a tarball URL that isn't `https`;
  - more than 20 direct dependencies or 300 packages in all.

  Only a `raw` adapter may carry a lockfile.
- **The hash.** The adapter hash covers the lockfile, canonicalised, and so covers every
  dependency's exact code. A package without a lockfile hashes exactly as before.
- **`valet_add_dependency`.** It is for `raw` drafts only. Valet itself asks the npm registry,
  never an agent's URL. It does the following:
  - picks the newest version in the range that has been public for three days, the rule this
    repository's own lockfile follows;
  - fetches the tarball from the registry's own origin only;
  - checks the tarball against its sha512 integrity;
  - unpacks it in memory to check it;
  - does the same for every dependency, peer and optional dependency.

  It refuses:
  - a native addon (`.node`, `binding.gyp`, `gypfile`);
  - a package that can't run on a Mac (an optional one is skipped instead);
  - a git, file or URL dependency.

  Nothing is installed and no install script ever runs. Tarballs are kept by integrity in
  `<userData>/npm-tarballs`, and each one is checked again whenever it is read. A tarball is kept
  only once the whole addition has succeeded. Each agent may add 30 dependencies an hour.
- **Unpacking.** It is done in memory. Only plain files are kept: no links of either kind, devices
  or folders, and no path that is absolute or climbs out of the package. Limits are 20 MB
  compressed, 64 MB unpacked and 5,000 files.
- **Bundling.** `Compiler.compileNode` in `packages/adapter-store` builds the bundle with
  esbuild-wasm in the compile worker, from files in memory only. `npm-resolve.ts` applies Node's
  rules:
  - an import names one of the importer's own lockfile dependencies;
  - inside a package, `exports` and `imports` maps (with conditions and `*` patterns), `main`,
    and extension and index probing apply;
  - nothing resolves outside the listed packages.

  `zod` and `@valet/core` come from the library prelude, as for every adapter. Node's built-ins
  stay as `require` calls. The output is capped at 16 MB.

## What is not built here

- **Shipping the binary.** Packaging the separately signed Node binary into the app is a follow-up
  in this workstream. It needs:
  - the official Node release for both architectures, checked against hashes pinned in the
    repository;
  - its own signing identifier;
  - only the JIT entitlement;
  - a check in the release dry run.
- **Wiring into adapters** is workstream F: `raw` in the manifest, `endpoints`, read paths, and
  `ctx.secrets`.
- **The broker's side of the tunnels** is workstream A.

## Testing

`packages/node-runtime/test` runs real Node processes:

- **`runtime.test.ts`:**
  - each call's process, capability calls, describe and check;
  - no state between calls, and the temporary folder removed;
  - the empty environment;
  - the shim over TCP, `fetch` and `https` with a test certificate;
  - DNS answers, and refused hosts and ports;
  - Node's permission model refusing child processes, workers, addons and files;
  - abort, the lifetime cap, the heap cap, garbage on the channel, and refusing to run without
    Seatbelt.
- **`profile.test.ts`:** the generated text everywhere. On macOS it also runs a probe with no shim
  and without Node's permission model, so each refusal is Seatbelt's alone:
  - other loopback ports, the internet, IPv6, UDP and `mDNSResponder`;
  - the person's files, `~/.ssh`, the Keychains and other users;
  - writes outside the temporary folder;
  - links made in the temporary folder;
  - every other program, another Node included;
  - signals to other processes.

  These tests never skip on macOS, and CI runs them on its macOS runner.
- **`dependencies.test.ts`:** everything above about dependencies, against a fake HTTPS registry
  with hostile packages. It also runs a bundle of real CommonJS and ESM packages in the runtime,
  reaching a fake server through a dependency's own `net` code.
- **`test/redteam/`:** the adversarial pass (below).

## Red team

An adversarial pass looked for ways agent-written code, a hostile npm package or a hand-written
lockfile could get out. Each finding has a test in `test/redteam/escapes.test.ts`, and each was
fixed before this merged:

1. **Memory outside the heap.** `--max-old-space-size` caps V8's heap only. Buffers and
   ArrayBuffers live outside it, so an adapter could take all of the Mac's memory. Valet now samples
   the process's resident memory from outside (`ps`, every half second) and ends it over 1 GB
   (`maxRssMb`).
2. **Ending a call while it starts.** If a call ended while the broker was still opening the
   tunnels, the tunnels and the temporary folder were left behind. The start now cleans up whatever
   it made after the call ended.
3. **A lockfile that lies about names.** The store is keyed by integrity alone, and the approval
   card names packages from the lockfile. So a hand-written lockfile could put one package's code
   under another's name, and the card would show the wrong package. A tarball's own `package.json`
   must now match its `name@version`, both when it is added and whenever it is loaded.
4. **An `imports` map that loops.** Two `#` entries naming each other overflowed the compile
   worker's stack. Node refuses a `#` target that names another `#` entry, and so does the resolver
   now.

What was tried and held, also in those tests:

- Around the shim: Node's TCP binding, a fresh `require` of `net`, TLS, the synthetic DNS range with
  an undeclared port, IPv6 and IPv4-mapped loopback, look-alike host names and Unix sockets.
- Out of the process: signalling the parent, the inspector, WASI, `dlopen`, the `fs` binding, and
  reading outside the temporary folder by path, relative climb, URL, Buffer and symlink.
- On macOS, `profile.test.ts` repeats the network, file, program and signal refusals with the shim
  and Node's permission model both off, so each refusal is Seatbelt's alone.

Known limits, left as they are:

- **The temporary folder has no size cap.** An adapter can fill the disk during a call (at most 10
  minutes). It is deleted when the call ends.
- **The profile allows a few harmless reads at start.** These are the root folder's names, the OS
  version, and `kern.bootargs`. Node aborts without them.
