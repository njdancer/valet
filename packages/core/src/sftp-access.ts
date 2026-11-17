// ctx.sftp: what a `protocol` adapter's tool code can do with files on an SFTP server
// (docs/sftp.md). Valet's own SFTP client does it in the sandboxed protocol host, over an SSH
// connection whose host key is pinned and which signs in with a kept key the adapter never sees.
// Every operation is checked against the tool's declared side effect and the manifest's roots
// before anything is sent (sftp-policy.ts).

import type { SftpWriteMode } from './sftp-policy'

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface SftpEntry {
  readonly name: string
  readonly type: SftpEntryType
  /** Bytes, when the server says. */
  readonly size: number | null
  /** ISO 8601, when the server says. */
  readonly modified: string | null
  /** The permission bits as four octal digits ("0644"), when the server says. */
  readonly permissions: string | null
}

export interface SftpStat {
  readonly path: string
  readonly type: SftpEntryType
  readonly size: number | null
  readonly modified: string | null
  readonly permissions: string | null
}

export interface SftpAccess {
  /**
   * read. A folder's entries by name, at most `limit` (default 200, at most 1000). Names Valet
   * can't address (a control character, a backslash) are left out and counted in `skipped`.
   */
  list(
    path: string,
    options?: { readonly limit?: number },
  ): Promise<{
    readonly path: string
    readonly entries: readonly SftpEntry[]
    readonly truncated: boolean
    readonly skipped: number
  }>
  /** read. Follows a symbolic link, if it stays inside the roots. */
  stat(path: string): Promise<SftpStat>
  /**
   * read. Up to `length` bytes (default 1 MB, at most 1.5 MB) from `offset`, as base64, or as text
   * with `encoding: "utf8"` (control characters other than tab and line breaks removed).
   */
  read(
    path: string,
    options?: { readonly offset?: number; readonly length?: number; readonly encoding?: 'base64' | 'utf8' },
  ): Promise<{
    readonly path: string
    readonly size: number | null
    readonly offset: number
    readonly bytes: number
    readonly base64?: string
    readonly text?: string
    readonly truncated: boolean
  }>
  /**
   * write, or irreversible with `mode: "replace"`. At most 1 MB, `data` as text, or base64 with
   * `encoding: "base64"`. `create` (the default) fails if anything is there already; `append` adds
   * to an existing file; `replace` overwrites one or makes it. Never writes through a symbolic link.
   */
  write(
    path: string,
    data: string,
    options?: { readonly mode?: SftpWriteMode; readonly encoding?: 'utf8' | 'base64' },
  ): Promise<{ readonly path: string; readonly bytes: number; readonly mode: SftpWriteMode }>
  /** write. One new folder; its parent must exist. */
  mkdir(path: string): Promise<{ readonly path: string }>
  /** write. Fails if `to` exists. Both must be in roots that allow writing. Never a root. */
  rename(from: string, to: string): Promise<{ readonly from: string; readonly to: string }>
  /** irreversible. A file or a symbolic link (the link, never what it points to). Never a folder. */
  remove(path: string): Promise<{ readonly path: string }>
  /** irreversible. An empty folder. Never a root. */
  removeDir(path: string): Promise<{ readonly path: string }>
}
