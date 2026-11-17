// A fake SFTP server on loopback for tests (docs/sftp.md#tests): ssh2's server, with a fresh host
// key, a key-only sign-in, and an SFTP subsystem over a real folder on disk, so symbolic links,
// renames and permissions behave as a real server's do. It records every request it receives, and
// can answer any of them with anything at all for the red team's hostile-server cases. Where
// OpenSSH's own sftp-server is installed (macOS has one), it can serve that instead.
//
// Paths: in `node` mode the folder is the server's "/", so tests name paths as the server would
// (`/docs/a.txt`). In `openssh` mode the server sees the real file system, so `root` is the folder's
// real path and tests name paths under it. Either way `at(path)` turns a server path into a local
// one, and `root` is the server's name for the folder.

import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { type Connection, type ParsedKey, Server, type SFTPWrapper, utils } from 'ssh2'

const { OPEN_MODE, STATUS_CODE } = utils.sftp

/** OpenSSH's sftp-server, where the system has one. */
export const OPENSSH_SFTP_SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server'].find((p) =>
  existsSync(p),
)

export interface KeyPair {
  /** OpenSSH private key text. */
  readonly private: string
  /** `ssh-ed25519 AAAA...` */
  readonly public: string
}

/**
 * A fresh Ed25519 key pair, in OpenSSH formats. ssh2's generator drops a leading zero byte from
 * the public key about one time in 256, and then can't read its own key back, so such a pair is
 * thrown away and another made. (Valet's own keys, packages/credentials valet-key.ts, are built
 * from the 32 raw bytes and don't have this problem.)
 */
export function keyPair(): KeyPair {
  for (;;) {
    const pair = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(pair.private) instanceof Error)) return { private: pair.private, public: pair.public }
  }
}

/** `SHA256:<base64>` of a public key line, as `ssh-keygen -lf` prints it. */
export function fingerprint(publicKey: string): string {
  const parsed = utils.parseKey(publicKey)
  if (parsed instanceof Error) throw parsed
  const key = Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed
  return `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
}

export interface SeenRequest {
  /** SFTP request type: OPEN, READ, LSTAT, SETSTAT... */
  readonly type: string
  readonly path?: string
  readonly path2?: string
  readonly flags?: number
  /** The SSH connection it came on, numbered from 1. */
  readonly connection: number
}

/** What a hostile hook sees, and the SFTP object it may answer on. */
export interface HostileContext {
  readonly request: SeenRequest
  readonly reqid: number
  readonly sftp: SFTPWrapper
}

export interface FakeSftpOptions {
  /** The account and the public key it accepts. Default `nick` and a fresh key (see `clientKey`). */
  readonly username?: string
  readonly authorizedKey?: string
  /** The server's host key (OpenSSH private key text). Default a fresh Ed25519 key. */
  readonly hostKey?: string
  /** Files to make: path (as the server names it) to contents; a path ending in "/" is a folder. */
  readonly files?: Readonly<Record<string, string | Buffer>>
  /** `node` (default): ssh2's own SFTP server over the folder. `openssh`: OpenSSH's sftp-server. */
  readonly mode?: 'node' | 'openssh'
  /**
   * Answer a request yourself: return true when the hook has answered it. Called before the fake's
   * own handling, in node mode only.
   */
  readonly hostile?: (context: HostileContext) => boolean
  /**
   * Speak raw bytes on the sftp channel instead of SFTP: for malformed-packet cases. Called with
   * the channel; the fake does nothing else with it.
   */
  readonly raw?: (channel: NodeJS.ReadWriteStream) => void
}

export interface FakeSftp {
  readonly port: number
  readonly username: string
  /** The private half of the key the server accepts, when the fake made it. */
  readonly clientKey: KeyPair
  readonly hostKey: KeyPair
  /** The pin for the host key: `SHA256:...`. */
  readonly hostKeySha256: string
  /** The server's name for the folder: "/" in node mode, its real path in openssh mode. */
  readonly root: string
  /** The folder on disk. */
  readonly dir: string
  /** A server path, as a local path. */
  at(path: string): string
  /** A server path under `root`, e.g. path('/docs') is `/docs` in node mode. */
  path(relative: string): string
  readonly requests: SeenRequest[]
  readonly logins: { readonly username: string; readonly method: string; readonly ok: boolean }[]
  /** Connections accepted so far. */
  readonly connections: number
  close(): Promise<void>
}

export const DEFAULT_USERNAME = 'nick'

export async function startFakeSftp(options: FakeSftpOptions = {}): Promise<FakeSftp> {
  const mode = options.mode ?? 'node'
  if (mode === 'openssh' && OPENSSH_SFTP_SERVER === undefined) throw new Error('no sftp-server here')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'valet-fake-sftp-')))
  const root = mode === 'node' ? '/' : dir
  const toLocal = (path: string): string => {
    if (mode === 'openssh') return path
    // Lexically inside the folder: ".." can't climb out of it, as on a chrooted server.
    return join(dir, posix.resolve('/', path))
  }
  const toServer = (local: string): string | null => {
    if (mode === 'openssh') return local
    if (local === dir) return '/'
    return local.startsWith(`${dir}/`) ? local.slice(dir.length) : null
  }
  const serverPath = (relative: string) =>
    mode === 'node' ? relative : relative === '/' ? dir : `${dir}${relative}`

  for (const [path, contents] of Object.entries(options.files ?? {})) {
    const local = toLocal(serverPath(path))
    if (path.endsWith('/')) {
      await mkdir(local, { recursive: true })
    } else {
      await mkdir(posix.dirname(local), { recursive: true })
      const file = await open(local, 'w')
      await file.writeFile(contents)
      await file.close()
    }
  }

  const username = options.username ?? DEFAULT_USERNAME
  const clientKey = keyPair()
  const authorized = utils.parseKey(options.authorizedKey ?? clientKey.public)
  if (authorized instanceof Error) throw authorized
  const authorizedKey = Array.isArray(authorized) ? (authorized[0] as ParsedKey) : authorized
  const hostKey = options.hostKey === undefined ? keyPair() : publicOf(options.hostKey)

  const requests: SeenRequest[] = []
  const logins: FakeSftp['logins'][number][] = []
  const clients = new Set<Connection>()
  let connections = 0

  const server = new Server({ hostKeys: [hostKey.private], ident: 'FakeSftp' }, (client: Connection) => {
    const connection = ++connections
    clients.add(client)
    // One small request at a time: without this, Nagle's algorithm holds each answer back.
    ;(client as unknown as { setNoDelay(on: boolean): void }).setNoDelay(true)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      const ok =
        ctx.method === 'publickey' &&
        ctx.username === username &&
        ctx.key.algo === authorizedKey.type &&
        sameBytes(ctx.key.data, authorizedKey.getPublicSSH())
      if (!ok) {
        if (ctx.method !== 'none') logins.push({ username: ctx.username, method: ctx.method, ok: false })
        return ctx.reject(['publickey'])
      }
      // The first try only asks whether the key would do; the second carries a signature.
      if (ctx.method === 'publickey' && ctx.signature === undefined) return ctx.accept()
      const signed =
        ctx.method === 'publickey' &&
        ctx.blob !== undefined &&
        authorizedKey.verify(ctx.blob, ctx.signature as Buffer, ctx.hashAlgo) === true
      logins.push({ username: ctx.username, method: ctx.method, ok: signed })
      if (!signed) return ctx.reject(['publickey'])
      ctx.accept()
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        if (options.raw !== undefined) {
          session.on('subsystem', (acceptSub) => {
            const channel = acceptSub()
            options.raw?.(channel as unknown as NodeJS.ReadWriteStream)
          })
          return
        }
        if (mode === 'openssh') {
          session.on('subsystem', (acceptSub, rejectSub, info) => {
            if (info.name !== 'sftp' || OPENSSH_SFTP_SERVER === undefined) return rejectSub()
            const channel = acceptSub()
            const child = spawn(OPENSSH_SFTP_SERVER, ['-e', '-l', 'DEBUG3'], {
              cwd: dir,
              stdio: ['pipe', 'pipe', 'pipe'],
            })
            channel.pipe(child.stdin)
            child.stdout.pipe(channel)
            child.stderr.on('data', (chunk: Buffer) => {
              for (const line of chunk.toString('utf8').split('\n')) {
                // `debug3: request 7: open` and the like; `request 7: sent status` is its answer.
                const m = /request \d+: (\w+)/.exec(line)
                const type = m?.[1]?.toUpperCase()
                if (type !== undefined && type !== 'SENT') requests.push({ type, connection })
              }
            })
            channel.on('close', () => child.kill())
          })
          return
        }
        session.on('sftp', (acceptSftp) => {
          serveSftp(acceptSftp(), connection)
        })
      })
    })
  })

  function serveSftp(sftp: SFTPWrapper, connection: number): void {
    const handles = new Map<string, { kind: 'file'; file: FileHandle; path: string } | { kind: 'dir'; path: string; done: boolean }>()
    let nextHandle = 1
    const newHandle = (value: Parameters<typeof handles.set>[1]) => {
      const key = Buffer.alloc(4)
      key.writeUInt32BE(nextHandle++)
      handles.set(key.toString('hex'), value)
      return key
    }
    const record = (reqid: number, request: Omit<SeenRequest, 'connection'>): boolean => {
      const seen = { ...request, connection }
      requests.push(seen)
      return options.hostile?.({ request: seen, reqid, sftp }) === true
    }
    const fail = (reqid: number, error: unknown) => sftp.status(reqid, statusOf(error))
    const attrsOf = (s: import('node:fs').Stats) => ({
      mode: s.mode,
      uid: s.uid,
      gid: s.gid,
      size: s.size,
      atime: Math.floor(s.atimeMs / 1000),
      mtime: Math.floor(s.mtimeMs / 1000),
    })

    sftp.on('OPEN', async (reqid, filename, flags) => {
      if (record(reqid, { type: 'OPEN', path: filename, flags })) return
      try {
        const file = await open(toLocal(filename), nodeFlags(flags), 0o644)
        sftp.handle(reqid, newHandle({ kind: 'file', file, path: filename }))
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('READ', async (reqid, handle, offset, length) => {
      if (record(reqid, { type: 'READ' })) return
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
      const buffer = Buffer.alloc(length)
      try {
        const { bytesRead } = await h.file.read(buffer, 0, length, offset)
        if (bytesRead === 0) return sftp.status(reqid, STATUS_CODE.EOF)
        sftp.data(reqid, buffer.subarray(0, bytesRead))
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('WRITE', async (reqid, handle, offset, data) => {
      if (record(reqid, { type: 'WRITE' })) return
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
      try {
        await h.file.write(data, 0, data.length, offset)
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('CLOSE', async (reqid, handle) => {
      if (record(reqid, { type: 'CLOSE' })) return
      const key = handle.toString('hex')
      const h = handles.get(key)
      if (h === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
      handles.delete(key)
      if (h.kind === 'file') await h.file.close().catch(() => undefined)
      sftp.status(reqid, STATUS_CODE.OK)
    })
    sftp.on('OPENDIR', async (reqid, path) => {
      if (record(reqid, { type: 'OPENDIR', path })) return
      try {
        if (!(await stat(toLocal(path))).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE)
        sftp.handle(reqid, newHandle({ kind: 'dir', path, done: false }))
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('READDIR', async (reqid, handle) => {
      if (record(reqid, { type: 'READDIR' })) return
      const h = handles.get(handle.toString('hex'))
      if (h?.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
      if (h.done) return sftp.status(reqid, STATUS_CODE.EOF)
      h.done = true
      try {
        const local = toLocal(h.path)
        const names = await readdir(local)
        const entries = []
        for (const name of ['.', '..', ...names]) {
          const s = await lstat(join(local, name))
          entries.push({ filename: name, longname: name, attrs: attrsOf(s) })
        }
        sftp.name(reqid, entries)
      } catch (error) {
        fail(reqid, error)
      }
    })
    for (const type of ['LSTAT', 'STAT'] as const) {
      sftp.on(type, async (reqid: number, path: string) => {
        if (record(reqid, { type, path })) return
        try {
          sftp.attrs(reqid, attrsOf(await (type === 'LSTAT' ? lstat : stat)(toLocal(path))))
        } catch (error) {
          fail(reqid, error)
        }
      })
    }
    sftp.on('REALPATH', async (reqid, path) => {
      if (record(reqid, { type: 'REALPATH', path })) return
      try {
        const real = toServer(await realpath(toLocal(path)))
        // A link that leads outside the folder: a real server would name the place it leads to.
        const shown = real ?? `/outside${await realpath(toLocal(path))}`
        sftp.name(reqid, [{ filename: shown, longname: shown, attrs: {} as never }])
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('MKDIR', async (reqid, path) => {
      if (record(reqid, { type: 'MKDIR', path })) return
      try {
        await mkdir(toLocal(path))
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('RMDIR', async (reqid, path) => {
      if (record(reqid, { type: 'RMDIR', path })) return
      try {
        await rmdir(toLocal(path))
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('REMOVE', async (reqid, path) => {
      if (record(reqid, { type: 'REMOVE', path })) return
      try {
        await unlink(toLocal(path))
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })
    sftp.on('RENAME', async (reqid, from, to) => {
      if (record(reqid, { type: 'RENAME', path: from, path2: to })) return
      try {
        // As OpenSSH: never over something that's there.
        if (await lstat(toLocal(to)).then(() => true, () => false)) return sftp.status(reqid, STATUS_CODE.FAILURE)
        await rename(toLocal(from), toLocal(to))
        sftp.status(reqid, STATUS_CODE.OK)
      } catch (error) {
        fail(reqid, error)
      }
    })
    // Valet never sends these; the fake records them so a test can prove it.
    for (const type of ['SETSTAT', 'FSETSTAT', 'FSTAT', 'READLINK', 'SYMLINK'] as const) {
      sftp.on(type as 'SETSTAT', (reqid: number, path?: unknown) => {
        if (record(reqid, { type, ...(typeof path === 'string' ? { path } : {}) })) return
        sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
      })
    }
    sftp.on('end', () => {
      for (const h of handles.values()) if (h.kind === 'file') void h.file.close().catch(() => undefined)
    })
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    username,
    clientKey,
    hostKey,
    hostKeySha256: fingerprint(hostKey.public),
    root,
    dir,
    at: toLocal,
    path: serverPath,
    requests,
    logins,
    get connections() {
      return connections
    },
    async close() {
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** The public half of a private key, as a pair. */
function publicOf(privateKey: string): KeyPair {
  const parsed = utils.parseKey(privateKey)
  if (parsed instanceof Error) throw parsed
  const key = Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed
  return { private: privateKey, public: `${key.type} ${key.getPublicSSH().toString('base64')}` }
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function nodeFlags(flags: number): number {
  let out = 0
  const read = (flags & OPEN_MODE.READ) !== 0
  const write = (flags & OPEN_MODE.WRITE) !== 0
  out |= read && write ? constants.O_RDWR : write ? constants.O_WRONLY : constants.O_RDONLY
  if (flags & OPEN_MODE.APPEND) out |= constants.O_APPEND
  if (flags & OPEN_MODE.CREAT) out |= constants.O_CREAT
  if (flags & OPEN_MODE.TRUNC) out |= constants.O_TRUNC
  if (flags & OPEN_MODE.EXCL) out |= constants.O_EXCL
  return out
}

function statusOf(error: unknown): number {
  const code = (error as { code?: string }).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE
  if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED
  return STATUS_CODE.FAILURE
}

