// Mail's .emlx file: a line with the message's length in bytes, the message itself (RFC 5322),
// then a property list of Mail's flags. A .partial.emlx is a message Mail hasn't fully downloaded:
// its headers are there, some body parts may not be.

export interface Emlx {
  readonly message: Buffer
  /** False for a .partial.emlx: parts of the body may be missing. */
  readonly complete: boolean
}

export function parseEmlx(bytes: Buffer, partial: boolean): Emlx {
  const newline = bytes.indexOf(0x0a)
  const first = newline < 0 ? '' : bytes.subarray(0, newline).toString('latin1').trim()
  if (/^\d{1,10}$/.test(first)) {
    const length = Number(first)
    const start = newline + 1
    return { message: bytes.subarray(start, Math.min(bytes.length, start + length)), complete: !partial }
  }
  return { message: bytes, complete: !partial }
}

/** Where Mail keeps a message's attachments when it stores them apart: beside its Messages folder. */
export function attachmentFolder(rowId: number): string {
  return messageFolder(rowId).replace(/Messages$/, 'Attachments')
}

/**
 * The folders under a mailbox's own folder where Mail keeps message `rowId`: Data/, then the
 * thousands of the row id digit by digit from the lowest, then Messages/. 123456 is in
 * Data/3/2/1/Messages, 999 in Data/Messages.
 */

export function messageFolder(rowId: number): string {
  const thousands = Math.floor(rowId / 1000)
  const digits = thousands === 0 ? [] : [...String(thousands)].reverse()
  return ['Data', ...digits, 'Messages'].join('/')
}
