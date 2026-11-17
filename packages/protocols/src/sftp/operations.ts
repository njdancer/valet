// What ctx.sftp does, as SFTP (docs/sftp.md): each operation checks its arguments, keeps to the
// manifest's roots on the paths the server itself resolves, and returns plain, bounded data. The
// protocol host runs these against the real server; every request they make passes checkRequest
// (client.ts) on the way out.
//
// Arguments arrive from tool code (through the main process, which checked them once already), so
// every one is checked again here as if it were hostile.
//
// Symbolic links: a path is resolved by the server (REALPATH) and the answer must be inside the
// roots, and every folder below the root on the way to it is checked with LSTAT, so a server whose
// REALPATH doesn't follow links still can't lead a call outside. Reads and listings follow a link
// that stays inside; writes, renames and removals act on the name itself and never go through a link.

import {
  accessRank,
  isSftpName,
  isSftpPath,
  joinPath,
  nameOf,
  OPEN_FLAGS,
  parentOf,
  pathAllowed,
  renameAllowed,
  rootOf,
  SFTP_PURPOSE_RANK,
  type SftpOperation,
  type SftpPurpose,
  type SftpRoot,
  sftpOperationPurpose,
  wireAllows,
} from '@valet/core/sftp-policy'
import { cleanBody } from '../imap/decode'
import type { SftpClient } from './client'
import { FX, MAX_READ_CHUNK, MAX_WRITE_CHUNK, type SftpAttrs, SftpError, type SftpReply } from './wire'

export const SFTP_LIMITS = {
  listDefault: 200,
  listMax: 1000,
  /** READDIR requests for one listing, however few names each brings. */
  listRequests: 200,
  readDefault: 1024 * 1024,
  readMax: 1536 * 1024,
  writeMax: 1024 * 1024,
} as const

export type EntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface Entry {
  readonly name: string
  readonly type: EntryType
  readonly size: number | null
  readonly modified: string | null
  readonly permissions: string | null
}

const S_IFMT = 0o170000

function typeOf(attrs: SftpAttrs): EntryType {
  if (attrs.permissions === null) return 'other'
  switch (attrs.permissions & S_IFMT) {
    case 0o100000:
      return 'file'
    case 0o040000:
      return 'directory'
    case 0o120000:
      return 'symlink'
    default:
      return 'other'
  }
}

function describe(attrs: SftpAttrs): Omit<Entry, 'name'> {
  return {
    type: typeOf(attrs),
    size: attrs.size,
    modified: attrs.mtime === null ? null : new Date(attrs.mtime * 1000).toISOString(),
    permissions:
      attrs.permissions === null ? null : (attrs.permissions & 0o7777).toString(8).padStart(4, '0'),
  }
}

const invalid = () => new SftpError('invalid')
const notAllowed = () => new SftpError('not-allowed')

/** The server's no, as the host reports it. */
function no(code: number): SftpError {
  switch (code) {
    case FX.NO_SUCH_FILE:
      return new SftpError('no', 'NONEXISTENT')
    case FX.PERMISSION_DENIED:
      return new SftpError('no', 'DENIED')
    case FX.OP_UNSUPPORTED:
      return new SftpError('no', 'UNSUPPORTED')
    default:
      return new SftpError('no', 'FAILURE')
  }
}

function options(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((k) => !allowed.includes(k))) throw invalid()
  return record
}

function integer(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid()
  return value
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class SftpOperations {
  private constructor(private readonly client: SftpClient) {}

  /**
   * Resolves each root on the server (REALPATH), so a root that is a link still works, and returns
   * the operations. A root the server can't resolve stays unusable: calls under it fail not-found.
   */
  static async start(client: SftpClient): Promise<SftpOperations> {
    const ops = new SftpOperations(client)
    const resolved: SftpRoot[] = []
    for (const root of client.roots) {
      try {
        resolved.push({ path: await ops.realpath(root.path), access: root.access })
      } catch (error) {
        if (!(error instanceof SftpError && error.failure === 'no')) throw error
      }
    }
    client.setResolvedRoots(resolved)
    return ops
  }

  private get declared(): readonly SftpRoot[] {
    return this.client.roots
  }

  async run(op: SftpOperation, args: readonly unknown[]): Promise<unknown> {
    if (!Array.isArray(args) || args.length > 3) throw invalid()
    const purpose = sftpOperationPurpose(op, args)
    // A session never does more than it was started for: a read tool's host can't write.
    if (SFTP_PURPOSE_RANK[purpose] > SFTP_PURPOSE_RANK[this.client.purpose]) throw notAllowed()
    const path = (index: number): string => {
      const value = args[index]
      if (!isSftpPath(value)) throw invalid()
      if (!pathAllowed(op, value, purpose, this.declared)) throw notAllowed()
      return value
    }
    switch (op) {
      case 'list':
        return this.list(path(0), options(args[1], ['limit']))
      case 'stat':
        if (args.length > 1) throw invalid()
        return this.stat(path(0))
      case 'read':
        return this.read(path(0), options(args[1], ['offset', 'length', 'encoding']))
      case 'write':
        if (typeof args[1] !== 'string') throw invalid()
        return this.write(path(0), args[1], options(args[2], ['mode', 'encoding']), purpose)
      case 'mkdir':
        if (args.length > 1) throw invalid()
        return this.mkdir(path(0))
      case 'rename':
        if (args.length > 2) throw invalid()
        return this.rename(path(0), path(1))
      case 'remove':
        if (args.length > 1) throw invalid()
        return this.remove(path(0))
      case 'removeDir':
        if (args.length > 1) throw invalid()
        return this.removeDir(path(0))
    }
  }

  // --- The operations -----------------------------------------------------------------------------

  private async list(path: string, opts: Record<string, unknown>) {
    const limit = integer(opts['limit'], 1, SFTP_LIMITS.listMax, SFTP_LIMITS.listDefault)
    const real = await this.followed(path, 'read')
    const handle = this.handleOf(await this.client.request({ type: 'OPENDIR', path: real }))
    const entries: Entry[] = []
    let skipped = 0
    let truncated = false
    try {
      for (let i = 0; ; i++) {
        if (i >= SFTP_LIMITS.listRequests) {
          truncated = true
          break
        }
        const reply = await this.client.request({ type: 'READDIR', handle })
        if (reply.type === 'STATUS') {
          if (reply.code === FX.EOF) break
          throw no(reply.code)
        }
        if (reply.type !== 'NAME') throw new SftpError('malformed')
        for (const n of reply.names) {
          const name = utf8(n.filename)
          if (name === '.' || name === '..') continue
          if (name === null || !isSftpName(name)) {
            skipped++
            continue
          }
          if (entries.length >= limit) {
            truncated = true
            continue
          }
          entries.push({ name, ...describe(n.attrs) })
        }
        if (truncated) break
      }
    } finally {
      await this.close(handle)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { path, entries, truncated, skipped }
  }

  private async stat(path: string) {
    const real = await this.followed(path, 'read')
    const attrs = this.attrsOf(await this.client.request({ type: 'STAT', path: real }))
    return { path, ...describe(attrs) }
  }

  private async read(path: string, opts: Record<string, unknown>) {
    const offset = integer(opts['offset'], 0, Number.MAX_SAFE_INTEGER, 0)
    const length = integer(opts['length'], 1, SFTP_LIMITS.readMax, SFTP_LIMITS.readDefault)
    const encoding = opts['encoding'] ?? 'base64'
    if (encoding !== 'base64' && encoding !== 'utf8') throw invalid()
    const real = await this.followed(path, 'read')
    const attrs = this.attrsOf(await this.client.request({ type: 'STAT', path: real }))
    if (typeOf(attrs) !== 'file') throw invalid()
    const handle = this.handleOf(
      await this.client.request({ type: 'OPEN', path: real, flags: OPEN_FLAGS.READ }),
    )
    const chunks: Buffer[] = []
    let got = 0
    let eof = false
    try {
      while (got < length) {
        const want = Math.min(MAX_READ_CHUNK, length - got)
        const reply = await this.client.request({ type: 'READ', handle, offset: offset + got, length: want })
        if (reply.type === 'STATUS') {
          if (reply.code === FX.EOF) {
            eof = true
            break
          }
          throw no(reply.code)
        }
        if (reply.type !== 'DATA') throw new SftpError('malformed')
        // A server may send less than asked; an empty DATA would never end.
        if (reply.data.length === 0) throw new SftpError('malformed')
        chunks.push(reply.data)
        got += reply.data.length
      }
    } finally {
      await this.close(handle)
    }
    const bytes = Buffer.concat(chunks, got)
    const size = attrs.size
    const truncated = !eof && (size === null || offset + got < size)
    const body =
      encoding === 'utf8'
        ? { text: cleanBody(new TextDecoder('utf-8', { fatal: false }).decode(bytes)) }
        : { base64: bytes.toString('base64') }
    return { path, size, offset, bytes: got, ...body, truncated }
  }

  private async write(path: string, data: string, opts: Record<string, unknown>, purpose: SftpPurpose) {
    const mode = opts['mode'] ?? 'create'
    if (mode !== 'create' && mode !== 'append' && mode !== 'replace') throw invalid()
    const encoding = opts['encoding'] ?? 'utf8'
    if (encoding !== 'utf8' && encoding !== 'base64') throw invalid()
    // Bounded before anything is decoded: a UTF-16 unit is at least one byte, four base64 characters three.
    const maxChars = encoding === 'base64' ? Math.ceil(SFTP_LIMITS.writeMax / 3) * 4 : SFTP_LIMITS.writeMax
    if (data.length > maxChars || (encoding === 'base64' && !BASE64.test(data))) throw invalid()
    const bytes = Buffer.from(data, encoding)
    if (bytes.length > SFTP_LIMITS.writeMax) throw invalid()
    const target = await this.placed(path, purpose)
    const existing = await this.lstat(target)
    let flags: number
    let start = 0
    if (mode === 'create') {
      if (existing !== null) throw new SftpError('no', 'ALREADYEXISTS')
      flags = OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | OPEN_FLAGS.EXCL
    } else {
      // Never through a link: the link's target could be anywhere.
      if (existing !== null && typeOf(existing) !== 'file')
        throw typeOf(existing) === 'symlink' ? notAllowed() : invalid()
      if (mode === 'append') {
        if (existing === null) throw new SftpError('no', 'NONEXISTENT')
        flags = OPEN_FLAGS.WRITE | OPEN_FLAGS.APPEND
        start = existing.size ?? 0
      } else {
        flags = OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | OPEN_FLAGS.TRUNC
      }
    }
    const handle = this.handleOf(await this.client.request({ type: 'OPEN', path: target, flags }))
    try {
      for (let at = 0; at < bytes.length; at += MAX_WRITE_CHUNK) {
        const piece = bytes.subarray(at, at + MAX_WRITE_CHUNK)
        this.ok(await this.client.request({ type: 'WRITE', handle, offset: start + at, data: piece }))
      }
    } finally {
      await this.close(handle)
    }
    return { path, bytes: bytes.length, mode }
  }

  private async mkdir(path: string) {
    const target = await this.placed(path, 'write')
    if ((await this.lstat(target)) !== null) throw new SftpError('no', 'ALREADYEXISTS')
    this.ok(await this.client.request({ type: 'MKDIR', path: target }))
    return { path }
  }

  private async rename(from: string, to: string) {
    // Never across roots of different access (sftp-policy.ts renameAllowed).
    if (!renameAllowed(from, to, this.declared)) throw notAllowed()
    const source = await this.placed(from, 'write')
    if ((await this.lstat(source)) === null) throw new SftpError('no', 'NONEXISTENT')
    const destination = await this.placed(to, 'write')
    if ((await this.lstat(destination)) !== null) throw new SftpError('no', 'ALREADYEXISTS')
    // Where the server really puts them, the access must match too.
    const resolved = this.client.resolvedRoots
    if (accessRank(source, resolved) !== accessRank(destination, resolved)) throw notAllowed()
    this.ok(await this.client.request({ type: 'RENAME', from: source, to: destination }))
    return { from, to }
  }

  private async remove(path: string) {
    const target = await this.placed(path, 'irreversible')
    const existing = await this.lstat(target)
    if (existing === null) throw new SftpError('no', 'NONEXISTENT')
    if (typeOf(existing) === 'directory') throw invalid()
    this.ok(await this.client.request({ type: 'REMOVE', path: target }))
    return { path }
  }

  private async removeDir(path: string) {
    const target = await this.placed(path, 'irreversible')
    const existing = await this.lstat(target)
    if (existing === null) throw new SftpError('no', 'NONEXISTENT')
    if (typeOf(existing) !== 'directory') throw invalid()
    const reply = await this.client.request({ type: 'RMDIR', path: target })
    if (reply.type === 'STATUS' && reply.code === FX.FAILURE) throw new SftpError('no', 'NOTEMPTY')
    this.ok(reply)
    return { path }
  }

  // --- Resolving paths ----------------------------------------------------------------------------

  /** The server's answer for where `path` really is: an absolute path in Valet's form. */
  private async realpath(path: string): Promise<string> {
    const reply = await this.client.request({ type: 'REALPATH', path })
    if (reply.type === 'STATUS') throw no(reply.code)
    if (reply.type !== 'NAME' || reply.names.length !== 1) throw new SftpError('malformed')
    const real = utf8((reply.names[0] as { filename: Buffer }).filename)
    if (real === null || !isSftpPath(real)) throw new SftpError('malformed')
    return real
  }

  /** LSTAT's attributes, or null when nothing is there. */
  private async lstat(path: string): Promise<SftpAttrs | null> {
    const reply = await this.client.request({ type: 'LSTAT', path })
    if (reply.type === 'STATUS') {
      if (reply.code === FX.NO_SUCH_FILE) return null
      throw no(reply.code)
    }
    return this.attrsOf(reply)
  }

  /**
   * Checks that nothing between `real`'s root and `real` itself (inclusive) is a link. A server
   * whose REALPATH follows links never has one there; one that only tidies the path would.
   */
  private async noLinksBelowRoot(real: string): Promise<void> {
    const root = rootOf(real, this.client.resolvedRoots) ?? rootOf(real, this.declared)
    if (root === null) throw notAllowed()
    if (real === root.path) return
    const rest = (root.path === '/' ? real.slice(1) : real.slice(root.path.length + 1)).split('/')
    let at = root.path
    for (const segment of rest) {
      at = joinPath(at, segment)
      const attrs = await this.lstat(at)
      if (attrs === null) throw new SftpError('no', 'NONEXISTENT')
      if (typeOf(attrs) === 'symlink') throw notAllowed()
    }
  }

  /** Where an existing `path` really is, for reading: inside the roots, or refused. */
  private async followed(path: string, purpose: SftpPurpose): Promise<string> {
    const real = await this.realpath(path)
    if (!wireAllows(real, purpose, this.declared, this.client.resolvedRoots)) throw notAllowed()
    await this.noLinksBelowRoot(real)
    return real
  }

  /**
   * The real path for `path`'s own name, for a change: its folder resolved by the server and inside
   * the roots, and the name itself, never followed.
   */
  private async placed(path: string, purpose: SftpPurpose): Promise<string> {
    const parent = parentOf(path)
    if (parent === null) throw notAllowed()
    const folder = await this.realpath(parent)
    if (!wireAllows(folder, 'read', this.declared, this.client.resolvedRoots)) throw notAllowed()
    await this.noLinksBelowRoot(folder)
    const target = joinPath(folder, nameOf(path))
    if (!wireAllows(target, purpose, this.declared, this.client.resolvedRoots)) throw notAllowed()
    return target
  }

  // --- Replies ------------------------------------------------------------------------------------

  private handleOf(reply: SftpReply): Buffer {
    if (reply.type === 'STATUS') throw no(reply.code)
    if (reply.type !== 'HANDLE') throw new SftpError('malformed')
    return reply.handle
  }

  private attrsOf(reply: SftpReply): SftpAttrs {
    if (reply.type === 'STATUS') throw no(reply.code)
    if (reply.type !== 'ATTRS') throw new SftpError('malformed')
    return reply.attrs
  }

  private ok(reply: SftpReply): void {
    if (reply.type !== 'STATUS') throw new SftpError('malformed')
    if (reply.code !== FX.OK) throw no(reply.code)
  }

  private async close(handle: Buffer): Promise<void> {
    try {
      await this.client.request({ type: 'CLOSE', handle })
    } catch {}
  }
}

/** Strict UTF-8, or null: a name that isn't can't be addressed by tool code. */
function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
