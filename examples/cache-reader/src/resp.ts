// RESP2, the cache's wire protocol: commands go out as arrays of bulk strings (written here), and
// replies come back in five types, which the redis-parser npm package reads, however the bytes are
// split across packets. Pure apart from the parser it is handed.

declare const require: (id: string) => any
declare const Buffer: { from(text: string, encoding: string): unknown }

/** One reply: text, a number, null, an array of replies, or the server's error. */
export type Reply = string | number | null | Reply[] | { readonly error: string }

/** A command as RESP: `*N\r\n` then `$len\r\nword\r\n` for each word. */
export function encode(words: readonly string[]): string {
  return `*${words.length}\r\n${words.map((w) => `$${byteLength(w)}\r\n${w}\r\n`).join('')}`
}

function byteLength(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * A reader that collects replies as bytes arrive. `push` takes each chunk; `replies` has every
 * complete reply so far. A malformed stream ends with `fatal` set.
 */
export function replyReader(): {
  push(chunk: unknown): void
  readonly replies: Reply[]
  fatal: string | null
} {
  const Parser = require('redis-parser')
  const state = {
    replies: [] as Reply[],
    fatal: null as string | null,
    push(chunk: unknown) {
      parser.execute(chunk)
    },
  }
  const parser = new Parser({
    returnReply: (reply: Reply) => state.replies.push(reply),
    returnError: (error: { message?: string }) =>
      state.replies.push({ error: String(error.message ?? 'ERR') }),
    returnFatalError: (error: { message?: string }) => {
      state.fatal = String(error.message ?? 'protocol error')
    },
  })
  return state
}

/** Every reply in a whole answer (a case's canned bytes, say). */
export function decodeAll(answer: string): Reply[] {
  const reader = replyReader()
  reader.push(Buffer.from(answer, 'utf8'))
  if (reader.fatal !== null) throw new Error(reader.fatal)
  return reader.replies
}
