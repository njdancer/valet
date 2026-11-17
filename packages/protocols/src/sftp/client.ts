// Valet's own SFTP version 3 client (docs/sftp.md#three-layers-of-checks), over the SSH channel
// ssh.ts opens. One request at a time, each checked against the session's purpose and roots just
// before it is written (checkRequest): this is the last of the three layers, and it holds whatever a
// bug above it does. Replies are read with hard limits, and anything unexpected ends the session.

import type { Duplex } from 'node:stream'
import {
  accessRank,
  holdsRoot,
  isRootPath,
  openPurpose,
  PACKET_PURPOSE,
  SFTP_PURPOSE_RANK,
  type SftpPurpose,
  type SftpRoot,
  wireAllows,
} from '@valet/core/sftp-policy'
import {
  decodeReply,
  decodeVersion,
  encodeInit,
  encodeRequest,
  MAX_HANDLE,
  MAX_READ_CHUNK,
  MAX_WRITE_CHUNK,
  PacketReader,
  SftpError,
  type SftpReply,
  type SftpRequest,
} from './wire'

export interface SftpClientOptions {
  readonly purpose: SftpPurpose
  /** The manifest's roots, exactly as declared. */
  readonly roots: readonly SftpRoot[]
  /** How long one request may take. Default 30 s. */
  readonly requestTimeoutMs?: number
  /** The most the server may send on this session. Default 64 MB. */
  readonly maxSessionBytes?: number
}

interface HandleInfo {
  readonly kind: 'file' | 'dir'
  readonly purpose: SftpPurpose
}

/** Requests that change what is at their path: never a root itself. */
const CHANGES: ReadonlySet<SftpRequest['type']> = new Set(['MKDIR', 'REMOVE', 'RMDIR'])

/**
 * Whether `request` may be sent by a session with `purpose`, given the declared and resolved roots
 * and the handles the server gave this session. Returns the failure, or null when it may.
 */
export function checkRequest(
  request: SftpRequest,
  purpose: SftpPurpose,
  declared: readonly SftpRoot[],
  resolved: readonly SftpRoot[],
  handles: ReadonlyMap<string, HandleInfo>,
): 'not-allowed' | 'invalid' | null {
  const needed = request.type === 'OPEN' ? openPurpose(request.flags) : PACKET_PURPOSE[request.type]
  if (needed === null) return 'not-allowed'
  if (SFTP_PURPOSE_RANK[needed] > SFTP_PURPOSE_RANK[purpose]) return 'not-allowed'
  const isRoot = (path: string) => isRootPath(path, declared) || isRootPath(path, resolved)
  const holds = (path: string) => holdsRoot(path, declared) || holdsRoot(path, resolved)
  switch (request.type) {
    case 'CLOSE':
    case 'READ':
    case 'READDIR':
    case 'WRITE': {
      const handle = handles.get(request.handle.toString('hex'))
      if (handle === undefined) return 'invalid'
      if (request.type === 'READDIR' && handle.kind !== 'dir') return 'invalid'
      if (request.type === 'READ' && (handle.kind !== 'file' || handle.purpose !== 'read')) return 'invalid'
      if (request.type === 'WRITE') {
        if (handle.kind !== 'file' || handle.purpose === 'read') return 'invalid'
        if (request.data.length > MAX_WRITE_CHUNK) return 'invalid'
      }
      if (request.type === 'READ' && (request.length < 1 || request.length > MAX_READ_CHUNK)) return 'invalid'
      if ((request.type === 'READ' || request.type === 'WRITE') && !Number.isSafeInteger(request.offset))
        return 'invalid'
      return null
    }
    case 'RENAME':
      if (isRoot(request.from) || isRoot(request.to) || holds(request.from)) return 'not-allowed'
      // Never across roots of different access, as declared or as the server resolved them.
      for (const roots of [declared, resolved]) {
        if (accessRank(request.from, roots) !== accessRank(request.to, roots)) return 'not-allowed'
      }
      return wireAllows(request.from, needed, declared, resolved) &&
        wireAllows(request.to, needed, declared, resolved)
        ? null
        : 'not-allowed'
    case 'OPEN':
      // Opening a root for writing would replace or append to a folder: never.
      if (needed !== 'read' && isRoot(request.path)) return 'not-allowed'
      return wireAllows(request.path, needed, declared, resolved) ? null : 'not-allowed'
    default:
      if (CHANGES.has(request.type) && isRoot(request.path)) return 'not-allowed'
      if (request.type === 'RMDIR' && holds(request.path)) return 'not-allowed'
      return wireAllows(request.path, needed, declared, resolved) ? null : 'not-allowed'
  }
}

export class SftpClient {
  private readonly packets = new PacketReader()
  private waiting: { resolve: (packet: Buffer) => void; reject: (error: SftpError) => void } | null = null
  private failed: SftpError | null = null
  private received = 0
  private nextId = 1
  private resolved: readonly SftpRoot[] = []
  private readonly handles = new Map<string, HandleInfo>()
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly stream: Duplex,
    private readonly options: SftpClientOptions,
  ) {
    stream.on('data', (chunk: Buffer) => this.onData(chunk))
    stream.on('error', () => this.fail(new SftpError('closed')))
    stream.on('close', () => this.fail(new SftpError('closed')))
    stream.on('end', () => this.fail(new SftpError('closed')))
  }

  /** Starts the session: INIT, and a VERSION of exactly 3. */
  static async open(stream: Duplex, options: SftpClientOptions): Promise<SftpClient> {
    const client = new SftpClient(stream, options)
    const reply = client.next()
    stream.write(encodeInit())
    const version = decodeVersion(await client.within(reply))
    if (version !== 3) {
      client.close()
      throw new SftpError('unsupported')
    }
    return client
  }

  get purpose(): SftpPurpose {
    return this.options.purpose
  }

  get roots(): readonly SftpRoot[] {
    return this.options.roots
  }

  get resolvedRoots(): readonly SftpRoot[] {
    return this.resolved
  }

  /** Where the server says each declared root really is. Set once, before any operation. */
  setResolvedRoots(roots: readonly SftpRoot[]): void {
    this.resolved = roots
  }

  /** Sends one request after checking it, and returns the reply. One at a time, in order. */
  request(request: SftpRequest): Promise<SftpReply> {
    const run = this.queue.then(() => this.send(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async send(request: SftpRequest): Promise<SftpReply> {
    if (this.failed !== null) throw this.failed
    const refusal = checkRequest(
      request,
      this.options.purpose,
      this.options.roots,
      this.resolved,
      this.handles,
    )
    if (refusal !== null) throw new SftpError(refusal)
    const id = this.nextId++
    const answer = this.next()
    this.stream.write(encodeRequest(id, request))
    const { id: got, reply } = decodeReply(await this.within(answer))
    // One request is outstanding, so the reply must be for it.
    if (got !== id) {
      const error = new SftpError('malformed')
      this.fail(error)
      throw error
    }
    this.expect(request, reply)
    if (reply.type === 'HANDLE') {
      const purpose =
        request.type === 'OPEN' ? (openPurpose(request.flags) as SftpPurpose) : ('read' as SftpPurpose)
      this.handles.set(reply.handle.toString('hex'), {
        kind: request.type === 'OPENDIR' ? 'dir' : 'file',
        purpose,
      })
    }
    if (request.type === 'CLOSE') this.handles.delete(request.handle.toString('hex'))
    return reply
  }

  /** The reply types each request may have. Anything else ends the session. */
  private expect(request: SftpRequest, reply: SftpReply): void {
    const ok = (() => {
      if (reply.type === 'STATUS') return true
      switch (request.type) {
        case 'OPEN':
        case 'OPENDIR':
          return reply.type === 'HANDLE' && reply.handle.length <= MAX_HANDLE
        case 'READ':
          return reply.type === 'DATA' && reply.data.length <= request.length
        case 'READDIR':
          return reply.type === 'NAME'
        case 'REALPATH':
          return reply.type === 'NAME' && reply.names.length === 1
        case 'STAT':
        case 'LSTAT':
          return reply.type === 'ATTRS'
        default:
          return false
      }
    })()
    if (!ok) {
      const error = new SftpError('malformed')
      this.fail(error)
      throw error
    }
  }

  /** Ends the session. Never throws. */
  close(): void {
    this.fail(new SftpError('closed'))
    try {
      this.stream.end()
      this.stream.destroy()
    } catch {}
  }

  private next(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.failed !== null) {
        reject(this.failed)
        return
      }
      this.waiting = { resolve, reject }
    })
  }

  private within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new SftpError('timeout')
        this.fail(error)
        reject(error)
      }, this.options.requestTimeoutMs ?? 30_000)
    })
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
  }

  private onData(chunk: Buffer): void {
    if (this.failed !== null) return
    this.received += chunk.length
    if (this.received > (this.options.maxSessionBytes ?? 64 * 1024 * 1024)) {
      this.fail(new SftpError('too-large'))
      return
    }
    let packets: Buffer[]
    try {
      packets = this.packets.push(chunk)
    } catch (error) {
      this.fail(error instanceof SftpError ? error : new SftpError('malformed'))
      return
    }
    for (const packet of packets) {
      const waiting = this.waiting
      // A packet nobody asked for: the server is not following the protocol.
      if (waiting === null) {
        this.fail(new SftpError('malformed'))
        return
      }
      this.waiting = null
      waiting.resolve(packet)
    }
  }

  private fail(error: SftpError): void {
    if (this.failed !== null) return
    this.failed = error
    this.waiting?.reject(error)
    this.waiting = null
    try {
      this.stream.destroy()
    } catch {}
  }
}
