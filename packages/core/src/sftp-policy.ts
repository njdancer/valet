// What a `protocol` adapter may do over SFTP (docs/sftp.md), and where. No imports: the SFTP host
// bundles this file, and it is the table a reviewer reads.
//
// Purposes are a tool's declared side effect:
// - read: list folders, stat and read files.
// - write: changes that can be undone: a new file, appending to a file, a new folder, a rename to a
//   name that is free.
// - irreversible: what can't be undone: replacing a file's contents, removing a file or a folder.
//
// Roots are the folders a manifest names, each with the most a tool may do under it (the same three
// words). The deepest root that holds a path decides, so a read-only folder inside a writable one
// stays read-only. A root itself is never removed, renamed or replaced.
//
// On the wire, only the SFTP version 3 requests in PACKET_PURPOSE are ever sent. Never SETSTAT or
// FSETSTAT (permissions and owners), SYMLINK, LINK, READLINK, or any EXTENDED request, whatever the
// purpose.

export type SftpPurpose = 'read' | 'write' | 'irreversible'
type Purpose = SftpPurpose

export const SFTP_PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

/** The operations ctx.sftp offers tool code, each with the purpose it needs. */
export const SFTP_OPERATION_PURPOSE = {
  list: 'read',
  stat: 'read',
  read: 'read',
  write: 'write',
  mkdir: 'write',
  rename: 'write',
  remove: 'irreversible',
  removeDir: 'irreversible',
} as const satisfies Record<string, Purpose>

export type SftpOperation = keyof typeof SFTP_OPERATION_PURPOSE

export function isSftpOperation(value: unknown): value is SftpOperation {
  return typeof value === 'string' && Object.hasOwn(SFTP_OPERATION_PURPOSE, value)
}

/** How write() treats a file that is already there. */
export const SFTP_WRITE_MODES = ['create', 'append', 'replace'] as const
export type SftpWriteMode = (typeof SFTP_WRITE_MODES)[number]

/**
 * The purpose one call of `operation` needs. write() replacing a file is irreversible: the old
 * contents are gone. Any mode it doesn't know is treated as the most it could be.
 */
export function sftpOperationPurpose(operation: SftpOperation, args: readonly unknown[]): Purpose {
  if (operation === 'write') {
    const options = args[2]
    const mode =
      options !== null && typeof options === 'object' && !Array.isArray(options)
        ? (options as Record<string, unknown>)['mode']
        : undefined
    if (mode === undefined || mode === 'create' || mode === 'append') return 'write'
    return 'irreversible'
  }
  return SFTP_OPERATION_PURPOSE[operation]
}

/** The path arguments of each operation, by position. */
export const SFTP_PATH_ARGS: Readonly<Record<SftpOperation, readonly number[]>> = {
  list: [0],
  stat: [0],
  read: [0],
  write: [0],
  mkdir: [0],
  rename: [0, 1],
  remove: [0],
  removeDir: [0],
}

/** Operations that change the thing at a path, so may never name a root itself. */
const CHANGES_PATH: ReadonlySet<SftpOperation> = new Set(['write', 'mkdir', 'rename', 'remove', 'removeDir'])

export const MAX_SFTP_PATH_BYTES = 1024
export const MAX_SFTP_NAME_BYTES = 255

/**
 * A path as tool code and manifests write it: absolute, separated by "/", with no empty, "." or ".."
 * segments, no trailing "/" (except "/" itself), no backslash, and no control or unpaired surrogate
 * characters. Nothing is normalised: a path that isn't already in this form is refused, so the path
 * Valet checks is the path the server is sent.
 */
export function isSftpPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false
  if (utf8Length(value) > MAX_SFTP_PATH_BYTES) return false
  if (value === '/') return true
  const segments = value.slice(1).split('/')
  return segments.every(isSftpName)
}

/** One segment of a path: a file or folder name. */
export function isSftpName(value: string): boolean {
  if (value === '' || value === '.' || value === '..') return false
  if (utf8Length(value) > MAX_SFTP_NAME_BYTES) return false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    // C0, DEL and C1 controls; "/" can't appear (it splits), backslash is a separator on some servers.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x5c) return false
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

function utf8Length(value: string): number {
  let n = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Whether `path` is `root` or inside it. Both are paths in isSftpPath's form. */
export function isWithin(path: string, root: string): boolean {
  if (root === '/') return true
  return path === root || path.startsWith(`${root}/`)
}

/** The folder that holds `path`, or null for "/". */
export function parentOf(path: string): string | null {
  if (path === '/') return null
  const index = path.lastIndexOf('/')
  return index === 0 ? '/' : path.slice(0, index)
}

/** The last segment of `path` ("" for "/"). */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** `name` in folder `parent`. */
export function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

export interface SftpRoot {
  readonly path: string
  readonly access: Purpose
}

/** The deepest root that holds `path`, or null if none does. */
export function rootOf(path: string, roots: readonly SftpRoot[]): SftpRoot | null {
  let best: SftpRoot | null = null
  for (const root of roots) {
    if (isWithin(path, root.path) && (best === null || root.path.length > best.path.length)) best = root
  }
  return best
}

/** Whether `purpose` may act on `path` under `roots`: the deepest root decides. */
export function rootAllows(path: string, roots: readonly SftpRoot[], purpose: Purpose): boolean {
  const root = rootOf(path, roots)
  return root !== null && SFTP_PURPOSE_RANK[root.access] >= SFTP_PURPOSE_RANK[purpose]
}

/** Whether `path` is one of the roots itself. */
export function isRootPath(path: string, roots: readonly SftpRoot[]): boolean {
  return roots.some((r) => r.path === path)
}

/**
 * Whether a root lies inside `path` (below it, not equal). Renaming such a folder would carry a
 * read-only root's files somewhere writable, so it is refused, as is removing it.
 */
export function holdsRoot(path: string, roots: readonly SftpRoot[]): boolean {
  return roots.some((r) => r.path !== path && isWithin(r.path, path))
}

/** Operations that move or remove a folder with everything in it. */
const CARRIES_CONTENTS: ReadonlySet<SftpOperation> = new Set(['rename', 'removeDir'])

/**
 * Whether tool code may ask for `operation` on `path`, as written, under the manifest's roots. The
 * host checks it again on the path the server resolved, and the wire once more before sending.
 */
export function pathAllowed(
  operation: SftpOperation,
  path: string,
  purpose: Purpose,
  roots: readonly SftpRoot[],
): boolean {
  if (!isSftpPath(path)) return false
  if (CHANGES_PATH.has(operation) && isRootPath(path, roots)) return false
  if (CARRIES_CONTENTS.has(operation) && holdsRoot(path, roots)) return false
  return rootAllows(path, roots, purpose)
}

/**
 * Where the wire may send a path: the deepest declared root and the deepest resolved root that
 * hold it must each allow `purpose` (when one holds it), and at least one must. Resolved roots are
 * the server's own answer for where each declared root really is (REALPATH), so a root that is a
 * symbolic link still works, and a path the server resolved somewhere else is refused.
 */
export function wireAllows(
  path: string,
  purpose: Purpose,
  declared: readonly SftpRoot[],
  resolved: readonly SftpRoot[],
): boolean {
  if (!isSftpPath(path)) return false
  const a = rootOf(path, declared)
  const b = rootOf(path, resolved)
  if (a === null && b === null) return false
  const rank = SFTP_PURPOSE_RANK[purpose]
  return (
    (a === null || SFTP_PURPOSE_RANK[a.access] >= rank) && (b === null || SFTP_PURPOSE_RANK[b.access] >= rank)
  )
}

/** SFTP version 3 request types Valet sends, with the purpose each needs. */
export const PACKET_PURPOSE = {
  OPEN: 'read', // by its flags: see openPurpose
  CLOSE: 'read',
  READ: 'read',
  LSTAT: 'read',
  STAT: 'read',
  OPENDIR: 'read',
  READDIR: 'read',
  REALPATH: 'read',
  WRITE: 'write',
  MKDIR: 'write',
  RENAME: 'write',
  REMOVE: 'irreversible',
  RMDIR: 'irreversible',
} as const satisfies Record<string, Purpose>

export type SftpPacket = keyof typeof PACKET_PURPOSE

/** SSH_FXF_* open flags (draft-ietf-secsh-filexfer-02). */
export const OPEN_FLAGS = {
  READ: 0x01,
  WRITE: 0x02,
  APPEND: 0x04,
  CREAT: 0x08,
  TRUNC: 0x10,
  EXCL: 0x20,
} as const

/**
 * The purpose an OPEN with these flags needs, or null for a combination Valet never sends. Reading
 * only; creating a new file (CREAT|EXCL, which never follows or replaces anything); appending; or
 * replacing (TRUNC), which is irreversible.
 */
export function openPurpose(flags: number): Purpose | null {
  const F = OPEN_FLAGS
  switch (flags) {
    case F.READ:
      return 'read'
    case F.WRITE | F.CREAT | F.EXCL:
    case F.WRITE | F.APPEND:
      return 'write'
    case F.WRITE | F.CREAT | F.TRUNC:
      return 'irreversible'
    default:
      return null
  }
}
