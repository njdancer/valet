// Which IMAP commands each tool purpose may send (docs/adapter-kinds.md#protocol, docs/imap.md).
// No imports: the protocol host bundles this file, and it is the table a reviewer reads.
//
// - read: look without changing anything. Folders are opened with EXAMINE (read-only), and message
//   data is fetched only with BODY.PEEK, so nothing is marked as read.
// - write: changes that can be undone: flags (but not \Deleted), copy, move, append, new folders.
// - irreversible: what can't be undone: \Deleted, UID EXPUNGE, deleting a folder.
//
// Never sent at all: CLOSE (it expunges silently), plain EXPUNGE (it would expunge what other
// clients marked), RENAME, SUBSCRIBE, STARTTLS, AUTHENTICATE, COMPRESS, IDLE, ACL and quota
// commands, and anything else not listed here.

export type Purpose = 'read' | 'write' | 'irreversible'

export const PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

export const VERB_PURPOSE: Readonly<Record<string, Purpose>> = {
  CAPABILITY: 'read',
  NOOP: 'read',
  LOGIN: 'read',
  LOGOUT: 'read',
  LIST: 'read',
  STATUS: 'read',
  EXAMINE: 'read',
  UNSELECT: 'read',
  'UID SEARCH': 'read',
  'UID FETCH': 'read',
  SELECT: 'write',
  'UID STORE': 'write',
  'UID COPY': 'write',
  'UID MOVE': 'write',
  APPEND: 'write',
  CREATE: 'write',
  'UID EXPUNGE': 'irreversible',
  DELETE: 'irreversible',
}

/**
 * Fetch items any purpose may ask for. Message data only ever as BODY.PEEK, which never sets
 * \Seen; BODY[...], RFC822, RFC822.TEXT and RFC822.HEADER would.
 */
const PLAIN_ITEMS = new Set(['UID', 'FLAGS', 'ENVELOPE', 'INTERNALDATE', 'RFC822.SIZE', 'BODYSTRUCTURE'])
/** BODY.PEEK[section]<partial>: a part number, optionally .MIME, .HEADER or .TEXT; or HEADER or TEXT. */
const PEEK = /^BODY\.PEEK\[(?:(?:[1-9]\d{0,3})(?:\.[1-9]\d{0,3}){0,9}(?:\.(?:MIME|HEADER|TEXT))?|HEADER|TEXT)?\](?:<\d{1,10}\.[1-9]\d{0,9}>)?$/

export function checkFetchItem(item: string): boolean {
  return PLAIN_ITEMS.has(item) || PEEK.test(item)
}

/** The operations ctx.imap offers tool code, each with the purpose it needs. */
export const OPERATION_PURPOSE = {
  listFolders: 'read',
  status: 'read',
  search: 'read',
  fetch: 'read',
  message: 'read',
  attachment: 'read',
  setFlags: 'write',
  copy: 'write',
  move: 'write',
  append: 'write',
  createFolder: 'write',
  expunge: 'irreversible',
  deleteFolder: 'irreversible',
} as const satisfies Record<string, Purpose>

export type Operation = keyof typeof OPERATION_PURPOSE

export function isOperation(value: unknown): value is Operation {
  return typeof value === 'string' && Object.hasOwn(OPERATION_PURPOSE, value)
}

/**
 * The purpose one call of `operation` needs. Setting or clearing \Deleted is irreversible, because
 * any other client (the person's own Mail app) may expunge what it marks.
 */
export function operationPurpose(operation: Operation, args: readonly unknown[]): Purpose {
  if (operation === 'setFlags' || operation === 'append') {
    // setFlags(folder, uids, { add, remove }) and append(folder, message, { flags }).
    if (mentionsDeleted(args[2])) return 'irreversible'
  }
  return OPERATION_PURPOSE[operation]
}

function mentionsDeleted(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const lists = Array.isArray(value) ? [value] : Object.values(value as Record<string, unknown>)
  return lists.some(
    (list) =>
      Array.isArray(list) && list.some((f) => typeof f === 'string' && f.toLowerCase() === '\\deleted'),
  )
}
