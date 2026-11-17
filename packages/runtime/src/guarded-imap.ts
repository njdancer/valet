// ctx.imap for one call (docs/imap.md): the checks every operation passes before the protocol host
// is asked to do anything. The host checks the same things again on its own, and its client checks
// every command on the wire (packages/protocols), so each rule holds at three layers.
//
// In order, for each operation:
// 1. the call is still live (not aborted, blocked, or past a guard violation);
// 2. the operation's purpose (imap-policy.ts) is within the tool's declared side effect;
// 3. every folder it names is one the manifest allows;
// 4. it counts against the run's request ceiling, and waits for the site's pace and breaker;
// 5. the first one opens the call's connection: the host process, signed in just in time with the
//    kept credential, through the broker's tunnel to the one declared endpoint.
// A refusal at 2 to 4 is sticky, recorded as `request-blocked`, and sent nowhere.

import {
  type AuditEvent,
  type ErrorClass,
  folderAllowed,
  type FolderRule,
  IMAP_PURPOSE_RANK,
  type ImapAccess,
  type ImapPurpose,
  isOperation,
  type Operation,
  operationPurpose,
  type Purpose,
  type SecretValue,
  type Stage,
  ValetError,
} from '@valet/core'
import type { RunContext } from '@valet/egress'
import { CallGate, type CallGateOptions } from './call-gate'

/** One call's connection to the protocol host. */
export interface ImapConnection {
  operation(op: Operation, args: readonly unknown[]): Promise<unknown>
  /** Signs out and ends the host. Never throws. */
  end(): Promise<void>
}

export interface ImapCall {
  readonly purpose: ImapPurpose
  readonly run: RunContext
  /** One pacing slot per connection the host opens through its tunnel. */
  readonly admit: () => Promise<void>
  /** The kept credential, asked for only once the host is up. The caller disposes the values. */
  readonly signIn: () => Promise<{ readonly username: SecretValue | null; readonly secret: SecretValue }>
  readonly signal: AbortSignal
}

/** What runs the protocol host for an adapter (packages/protocols' imapBackend). */
export interface ImapBackend {
  /** `host:port`, for the audit log. */
  readonly endpoint: string
  readonly folders: FolderRule
  connect(call: ImapCall): Promise<ImapConnection>
}

export interface GuardedImapOptions extends CallGateOptions {
  readonly backend: ImapBackend
  readonly run: RunContext
  readonly signIn: ImapCall['signIn']
}

/** The folder arguments of each operation, by position. */
const FOLDER_ARGS: Readonly<Record<Operation, readonly number[]>> = {
  listFolders: [],
  status: [0],
  search: [0],
  fetch: [0],
  message: [0],
  attachment: [0],
  setFlags: [0],
  copy: [0, 2],
  move: [0, 2],
  append: [0],
  createFolder: [0],
  expunge: [0],
  deleteFolder: [0],
}

export class GuardedImap implements ImapAccess {
  private readonly gate: CallGate
  private connection: Promise<ImapConnection> | null = null

  constructor(private readonly options: GuardedImapOptions) {
    this.gate = new CallGate(options)
    // The connection dies with the call.
    options.state.signal.addEventListener(
      'abort',
      () => {
        void this.connection?.then(
          (c) => c.end(),
          () => undefined,
        )
      },
      { once: true },
    )
  }

  listFolders = () => this.op('listFolders', []) as ReturnType<ImapAccess['listFolders']>
  status = (folder: string) => this.op('status', [folder]) as ReturnType<ImapAccess['status']>
  search: ImapAccess['search'] = (folder, criteria, options) =>
    this.op('search', [folder, criteria, options]) as ReturnType<ImapAccess['search']>
  fetch: ImapAccess['fetch'] = (folder, uids) => this.op('fetch', [folder, uids]) as ReturnType<ImapAccess['fetch']>
  message: ImapAccess['message'] = (folder, uid, options) =>
    this.op('message', [folder, uid, options]) as ReturnType<ImapAccess['message']>
  attachment: ImapAccess['attachment'] = (folder, uid, part, options) =>
    this.op('attachment', [folder, uid, part, options]) as ReturnType<ImapAccess['attachment']>
  setFlags: ImapAccess['setFlags'] = (folder, uids, change) =>
    this.op('setFlags', [folder, uids, change]) as ReturnType<ImapAccess['setFlags']>
  copy: ImapAccess['copy'] = (folder, uids, to) => this.op('copy', [folder, uids, to]) as ReturnType<ImapAccess['copy']>
  move: ImapAccess['move'] = (folder, uids, to) => this.op('move', [folder, uids, to]) as ReturnType<ImapAccess['move']>
  append: ImapAccess['append'] = (folder, message, options) =>
    this.op('append', [folder, message, options]) as ReturnType<ImapAccess['append']>
  createFolder: ImapAccess['createFolder'] = (folder) =>
    this.op('createFolder', [folder]) as ReturnType<ImapAccess['createFolder']>
  expunge: ImapAccess['expunge'] = (folder, uids) =>
    this.op('expunge', [folder, uids]) as ReturnType<ImapAccess['expunge']>
  deleteFolder: ImapAccess['deleteFolder'] = (folder) =>
    this.op('deleteFolder', [folder]) as ReturnType<ImapAccess['deleteFolder']>

  /** Runs one operation by name, as the isolation channel delivers it. */
  async op(name: unknown, args: readonly unknown[]): Promise<unknown> {
    const { state } = this.options
    state.assertLive()
    if (!isOperation(name) || !Array.isArray(args) || args.length > 4) throw new ValetError('tool-run', 'invalid')
    const needed: Purpose = operationPurpose(name, args)
    if (IMAP_PURPOSE_RANK[needed] > IMAP_PURPOSE_RANK[this.options.sideEffect]) {
      return this.deny('request-surface', 'command-not-allowed', name)
    }
    for (const index of FOLDER_ARGS[name]) {
      const folder = args[index]
      if (typeof folder !== 'string') throw new ValetError('tool-run', 'invalid')
      if (!folderAllowed(folder, this.options.backend.folders)) {
        return this.deny('request-surface', 'command-not-allowed', name)
      }
    }
    state.requests++
    if (state.requests > this.options.manifest.limits.requestsPerRun) {
      return this.deny('request-surface', 'request-ceiling', name)
    }
    await this.gate.pace()
    const connection = await state.track(this.connect())
    state.assertLive()
    try {
      return await state.track(connection.operation(name, args))
    } catch (error) {
      if (error instanceof ValetError && error.errorClass === 'command-not-allowed') {
        // The host refused what these checks let through: a bug here, so it ends the call.
        state.violation ??= error
      }
      throw error instanceof ValetError ? error : new ValetError('egress', 'unavailable')
    }
  }

  private connect(): Promise<ImapConnection> {
    if (this.connection === null) {
      const { backend, run, state, signIn, sideEffect } = this.options
      this.connection = backend.connect({
        purpose: sideEffect,
        run,
        admit: async () => {
          await this.gate.pace()
        },
        signIn,
        signal: state.signal,
      })
      // A failed start isn't retried within the call: the next call starts fresh.
      this.connection.catch(() => undefined)
    }
    return this.connection
  }

  private async deny(stage: Stage, errorClass: ErrorClass, operation: Operation): Promise<never> {
    const { state, adapterId, audit } = this.options
    const error = new ValetError(stage, errorClass)
    state.violation ??= error
    const event: AuditEvent = {
      type: 'request-blocked',
      adapterId,
      method: 'IMAP',
      target: `imaps://${this.options.backend.endpoint}/${operation}`,
      reason: errorClass,
      initiator: 'tool',
      partition: 'tool',
      callId: state.callId,
    }
    await audit(event)
    throw error
  }
}

/** ctx.imap for an adapter that has no IMAP: every call is not-granted. */
export const NO_IMAP_ACCESS: ImapAccess = Object.freeze(
  Object.fromEntries(
    (
      [
        'listFolders',
        'status',
        'search',
        'fetch',
        'message',
        'attachment',
        'setFlags',
        'copy',
        'move',
        'append',
        'createFolder',
        'expunge',
        'deleteFolder',
      ] as const
    ).map((name) => [name, () => Promise.reject(new ValetError('tool-run', 'not-granted'))]),
  ) as unknown as ImapAccess,
)
