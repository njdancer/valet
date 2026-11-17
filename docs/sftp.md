# SFTP protocol adapters

A `protocol` adapter reaches a file server over SFTP, through Valet's own client, never its own
code. Its tools call `ctx.sftp`, a short list of typed file operations. Each operation is checked
against the tool's declared side effect and the manifest's roots before anything is sent, and
again in the protocol host against the paths the server itself resolves. This is workstream E of
[adapter-kinds.md](adapter-kinds.md#protocol).

## The manifest

```json
{
  "runtime": "protocol",
  "protocols": {
    "sftp": {
      "endpoint": "nas.example.com:22",
      "credential": "nas",
      "hostKeySha256": "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
      "username": "alex",
      "roots": [
        { "path": "/volume1/docs", "access": "read" },
        { "path": "/volume1/inbox", "access": "write" },
        { "path": "/volume1/scratch", "access": "irreversible" }
      ]
    }
  },
  "credentials": {
    "nas": {
      "description": "A key Valet made for the NAS",
      "kind": "ssh-key",
      "custody": "kept",
      "use": { "protocol": "sftp", "endpoint": "nas.example.com:22" }
    }
  }
}
```

- **`endpoint`** is `host:port`. The host is a public name, or an IP address in a private range
  (a NAS on the person's network). A private address is shown on the card as a high-risk line and
  goes through the broker as a private host, so nothing else on that network is reachable.
- **`hostKeySha256`** is the server's host key fingerprint, as `ssh-keygen -lf` prints it
  (`SHA256:` and 43 base64 characters). It is checked on every key exchange. There is no trust on
  first use: a server with any other key is refused before the key is offered, as
  `egress/host-key-mismatch`.
- **`username`** is used when the credential item has none. The item's own username wins.
- **`credential`** names a kept `ssh-key` credential for `sftp` at the same endpoint. Valet makes
  the key (secrets v2's generator, ed25519) and shows the public half to put in the server's
  `authorized_keys`. Passwords aren't accepted yet.
- **`roots`**: one to twenty absolute paths, each with the most a tool may do there:
  - `read`: list, stat and read.
  - `write`: also write a new file, append to an existing one, make a folder, and rename.
  - `irreversible`: also replace a file's contents, remove a file and remove an empty folder.

  A path is under the deepest root that holds it, so `/docs` as `read` with `/docs/inbox` as
  `write` lets tools add files to the inbox only. A root itself is never changed, renamed or
  removed, nor is a folder that holds one. `/` is allowed and is shown as "everything this
  account can reach".
- An adapter uses one protocol: `protocols.imap` or `protocols.sftp`, not both.

## ctx.sftp

| Call                                          | Purpose      | Returns                                                                                                                                         |
| --------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `list(path, { limit? })`                      | read         | `{ path, entries: [{ name, type, size, modified, permissions }], truncated, skipped }`, at most 1,000 (default 200)                             |
| `stat(path)`                                  | read         | `{ path, type, size, modified, permissions }`                                                                                                   |
| `read(path, { encoding?, offset?, length? })` | read         | `{ path, size, offset, bytes, base64 \| text, truncated }`: base64 by default, or text with `encoding: 'utf8'`; 1 MB by default, at most 1.5 MB |
| `write(path, data, { encoding?, mode? })`     | write        | `{ path, bytes, mode }`: `create` (the default) or `append`, up to 1 MB                                                                         |
| `write(path, data, { mode: 'replace' })`      | irreversible | Replaces a file's contents, or makes it                                                                                                         |
| `mkdir(path)`                                 | write        | `{ path }`                                                                                                                                      |
| `rename(from, to)`                            | write        | `{ from, to }`; never overwrites                                                                                                                |
| `remove(path)`                                | irreversible | `{ path }`; files and links only                                                                                                                |
| `removeDir(path)`                             | irreversible | `{ path }`; empty folders only                                                                                                                  |

- Paths are absolute, `/`-separated, without `.` or `..` parts, empty parts, a trailing `/`,
  control characters or backslashes, at most 1,024 bytes (a name at most 255).
- `type` is `file`, `directory`, `symlink` or `other`. A listing leaves out `.` and `..`, is sorted
  by name, and leaves out names Valet can't address (counted in `skipped`).
- `create` never overwrites (the server is asked for an exclusive create), `append` needs an
  existing regular file, and nothing is ever written through a link.
- Errors: a missing path is `not-found`, one that already exists or a folder that isn't empty is
  `invalid`, the server's own refusal is `blocked-by-site`. A refusal by Valet's checks ends the
  call as `request-surface/command-not-allowed`, recorded as `request-blocked`, even if the code
  catches it.

## Three layers of checks

Each rule holds at three layers, so a bug in one is caught by the next.

1. **The main process** (`packages/runtime/src/guarded-sftp.ts`), before the protocol host is asked
   anything: the operation's purpose is within the tool's side effect; every path is in Valet's
   form and under a root that allows the purpose; the call is within its request ceiling and
   pacing. A refusal is sticky and audited.
2. **The protocol host** (`packages/protocols/src/sftp/operations.ts`), against what the server
   says: each root is resolved once with `REALPATH`, and each path a tool names is resolved again
   before use. Reads may follow a link only when the target stays inside a root that allows the
   read; every part below the root is checked with `LSTAT` too, for servers whose `REALPATH` is
   only lexical. Changes never go through a link: the target and its folder are checked with
   `LSTAT`, a create uses an exclusive open, and a replace refuses a link.
3. **The wire** (`packages/protocols/src/sftp/client.ts`): every request is checked just before it's
   written. Only the packets in the session's purpose are sent, open flags are one of four exact
   combinations (read; create exclusive; append; replace, which is irreversible), each handle is
   used only for what it was opened for, and every path must be under a root, both as declared and
   as the server resolved it, that allows the request. `SETSTAT`, `SYMLINK`, `READLINK` and
   extensions are never sent.

The session's purpose is the tool's side effect, so a `read` tool's host can't send a `WRITE` or
`REMOVE`, whatever the other layers do.

## The SSH connection

`ssh2` carries the SSH transport only; the SFTP protocol (version 3) is Valet's own client
(`packages/protocols/src/sftp/wire.ts`), with hard limits on every packet (256 KB), name list,
handle and session (64 MB).

- Key exchange, host keys, ciphers and MACs are a fixed modern list: curve25519 and ECDH, ed25519,
  ECDSA and RSA-SHA2 host keys, AES-GCM and AES-CTR with SHA-2 MACs. SHA-1, CBC and compression are
  never offered. chacha20-poly1305 is left out, because its WebAssembly part can't load in the
  sandboxed host.
- The host key is pinned (above). The pin is compared in constant time.
- The kept key is fetched only after the host is up and the tunnel open, sent to the host once, and
  dropped from the main process's memory once signed in. It never reaches adapter code.

## The protocol host

The SFTP host is its own bundle (`packages/protocols/src/host/sftp-host.ts`, built by
`buildSftpHost`), because it carries `ssh2` and its few pure-JavaScript dependencies; the IMAP host
stays free of npm code. `ssh2`'s native and WebAssembly parts are left out of the bundle.

It runs like the IMAP host: one Node process per call, under the Seatbelt profile on macOS, with no
network but one loopback port from the broker's tunnel (`plainTcp`, since SSH isn't TLS) to the one
declared endpoint. The broker dials the endpoint itself, spends every byte sent from the call's
upload budget and paces each connection.

## The approval card

No new permission areas: the card shows

- under **Network**, `SFTP as alex to nas.example.com:22` and `host key SHA256:…` (medium); for a
  private address, under **Your network**, `… on your network` (high);
- under **Requests**, one line per root: `Read files in /volume1/docs` (low), `Read, add and rename
files in /volume1/inbox` (medium), `Read, add, rename, replace and delete files in
/volume1/scratch` (high).

An update that changes the server, key or roots shows the change like any other.

## Tests

- `fakes/sftp`: an `ssh2` server on loopback with a real temporary folder, public-key sign-in, a
  fixed host key, and hooks for hostile answers. With `mode: 'openssh'` it hands the channel to
  OpenSSH's own `sftp-server` where one is installed.
- `packages/core/test/sftp-policy.test.ts`, `manifest-sftp.test.ts`: paths, roots, purposes, the
  manifest and card lines.
- `packages/protocols/test/sftp-wire.test.ts`: encoding, and the wire checks refusing what each
  purpose doesn't allow.
- `sftp-operations.test.ts`: every operation against the fake, links in and out of roots, writes
  through links refused.
- `sftp-hostile.test.ts`: a server that answers out of order, with the wrong ids, oversized
  packets, endless listings, or paths outside the roots.
- `sftp-openssh.test.ts`: the same against OpenSSH's server, whose `REALPATH` follows links.
- `sftp-host.e2e.test.ts`: the bundled host in its own process (under Seatbelt on macOS), through
  the broker's tunnel, pinned, signed in with a key Valet made.
- `packages/runtime/test/sftp.e2e.test.ts`: tools in the isolation sandbox calling `ctx.sftp`, the
  purpose and root checks, the request ceiling, and the audit.

## Red team

See [adapter-kinds.md](adapter-kinds.md#decisions-for-nicks-review) for the decisions and the red
team's findings.
