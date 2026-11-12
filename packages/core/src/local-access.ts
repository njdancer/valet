// What tool code can reach on the person's Mac through its declared sandbox exceptions (D73;
// docs/sandbox.md#exceptions-capabilities-enforced-in-main). Each method is one capability call the
// main process checks against the manifest's `sandbox.exceptions` before it touches anything. A
// call for a kind the manifest doesn't declare rejects with `tool-run/not-granted`. Tool code never
// gets a handle, a descriptor or a socket: one request, one JSON answer.

/** Text, or bytes as base64. */
export type LocalEncoding = 'utf8' | 'base64'

export interface LocalFileEntry {
  readonly name: string
  /** `other` covers symlinks (never followed), devices, sockets and FIFOs. */
  readonly kind: 'file' | 'directory' | 'other'
  readonly size: number
  /** Milliseconds since the epoch. */
  readonly modifiedAt: number
}

export interface LocalFiles {
  /** The entries of a folder the exceptions cover, at most 1,000, sorted by name. */
  list(dir: string): Promise<readonly LocalFileEntry[]>
  stat(path: string): Promise<LocalFileEntry>
  /** At most 16 MB. Defaults to utf8. */
  read(path: string, options?: { readonly encoding?: LocalEncoding }): Promise<string>
  /** Only under a `read-write` exception. Replaces the file whole; at most 16 MB. */
  write(path: string, content: string, options?: { readonly encoding?: LocalEncoding }): Promise<void>
  /** Only under a `read-write` exception. Creates the folder and any missing parents. */
  mkdir(dir: string): Promise<void>
}

export interface LocalRequestInit {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  /** How `body` is encoded. Defaults to utf8. */
  readonly bodyEncoding?: LocalEncoding
  /** How the answer's body comes back. Defaults to utf8. */
  readonly responseEncoding?: LocalEncoding
}

export interface LocalResponse {
  readonly status: number
  /** Lower-case names; `set-cookie` is never included. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export interface LocalRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** `ctx.local`: present on every ToolContext; each method needs its exception. */
export interface LocalAccess {
  readonly files: LocalFiles
  /** HTTPS to a host a `network` exception names. Redirects come back, not followed. */
  fetch(url: string, init?: LocalRequestInit): Promise<LocalResponse>
  /** HTTP to 127.0.0.1 on a port a `local-service` exception names. `path` starts with `/`. */
  service(port: number, path: string, init?: LocalRequestInit): Promise<LocalResponse>
  /** Runs the program a `command` exception names (the first one, or `program` if several). */
  run(
    args: readonly string[],
    options?: { readonly program?: string; readonly stdin?: string },
  ): Promise<LocalRunResult>
  /** AppleScript sent to one app an `app` exception names; the OS keeps it to that app. */
  appleScript(bundleId: string, source: string): Promise<string>
}
