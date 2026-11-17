// The example raw adapter (docs/adapter-kinds.md#h-example-adapters): a Redis-compatible cache over
// TLS, read with Node's own tls module and the redis-parser npm package. A raw adapter is for when
// nothing else fits: Valet can't see inside this protocol, so it holds the connection instead. The
// sandbox lets it reach cache.example.com:6380 only, with that name in TLS, and the entrusted
// password is handed to this code by ctx.secrets.get, audited, for that endpoint alone.
//
// A case can't reach the network, so each tool takes an optional `reply`: the cache's answer as
// text, decoded as if it had come back. A real call leaves it out.

import { type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'
import { decodeAll, encode, type Reply, replyReader } from './resp'

declare const require: (id: string) => any

const HOST = 'cache.example.com'
const PORT = 6380
/** Extra TLS options: none in a real call. A test adds the CA its fake cache's certificate is from. */
export const TLS_OPTIONS: Record<string, unknown> = {}
const KEY = /^[A-Za-z0-9:_.\-]{1,200}$/
const PATTERN = /^[A-Za-z0-9:_.\-*?]{1,100}$/
const MAX_KEYS = 500

/** Signs in and sends `commands` on one connection; the replies, one per command, AUTH's first. */
async function exchange(ctx: ToolContext, commands: readonly (readonly string[])[]): Promise<Reply[]> {
  if (ctx.secrets === undefined) throw new ValetError('tool-run', 'not-granted')
  const { value, username } = await ctx.secrets.get('cache')
  const auth = username === null ? ['AUTH', value] : ['AUTH', username, value]
  const tls = require('node:tls')
  return new Promise((resolve, reject) => {
    const reader = replyReader()
    const want = commands.length + 1
    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST, ...TLS_OPTIONS })
    const timer = setTimeout(() => socket.destroy(new ValetError('tool-run', 'timed-out')), 10_000)
    socket.on('secureConnect', () => socket.write([auth, ...commands].map(encode).join('')))
    socket.on('data', (chunk: unknown) => {
      reader.push(chunk)
      if (reader.fatal !== null) socket.destroy(new ValetError('tool-run', 'unexpected-shape'))
      else if (reader.replies.length >= want) socket.end()
    })
    socket.on('error', (error: unknown) => {
      clearTimeout(timer)
      reject(error instanceof ValetError ? error : new ValetError('tool-run', 'unavailable'))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      if (reader.replies.length >= want) resolve(reader.replies)
      else reject(new ValetError('tool-run', 'unavailable'))
    })
  })
}

/** The replies after AUTH's, or the error the cache gave. Pure. */
export function afterAuth(replies: readonly Reply[]): Reply[] {
  const [auth, ...rest] = replies
  if (isError(auth)) throw new ValetError('tool-run', 'auth-failed')
  return rest
}

function isError(reply: Reply | undefined): reply is { error: string } {
  return reply !== null && typeof reply === 'object' && !Array.isArray(reply)
}

function check(reply: Reply | undefined): Reply {
  if (reply === undefined) throw new ValetError('tool-run', 'unexpected-shape')
  if (isError(reply)) {
    // An account without the right to a key or command: the ACL says no, which the agent can act on.
    if (/^NOPERM\b/.test(reply.error)) throw new ValetError('tool-run', 'not-granted')
    if (/^(NOAUTH|WRONGPASS)\b/.test(reply.error)) throw new ValetError('tool-run', 'auth-failed')
    throw new ValetError('tool-run', 'unavailable')
  }
  return reply
}

/** A case's canned answer as the replies after AUTH's, or null for a real call. */
function canned(reply: string | undefined): Reply[] | null {
  if (reply === undefined) return null
  try {
    return afterAuth(decodeAll(reply))
  } catch (error) {
    if (error instanceof ValetError) throw error
    throw new ValetError('tool-run', 'unexpected-shape')
  }
}

const replyInput = z
  .string()
  .max(100_000)
  .optional()
  .describe('For a case only: the cache’s answer, decoded instead of asking the cache. Leave it out.')

export const tools = {
  get_key: tool({
    input: z.object({ key: z.string().regex(KEY), reply: replyInput }),
    output: z.object({ key: z.string(), value: z.string().nullable() }),
    async run(ctx, input) {
      const replies = canned(input.reply) ?? afterAuth(await exchange(ctx, [['GET', input.key]]))
      const value = check(replies[0])
      if (value !== null && typeof value !== 'string') throw new ValetError('tool-run', 'unexpected-shape')
      return { key: input.key, value: value === null ? null : value.slice(0, 10_000) }
    },
  }),

  scan_keys: tool({
    input: z.object({ pattern: z.string().regex(PATTERN).default('*'), reply: replyInput }),
    output: z.object({ keys: z.array(z.string()), complete: z.boolean() }),
    async run(ctx, input) {
      // One connection, one SCAN of up to 1,000: a cache with more says it isn't complete.
      const replies =
        canned(input.reply) ??
        afterAuth(await exchange(ctx, [['SCAN', '0', 'MATCH', input.pattern, 'COUNT', '1000']]))
      const scan = check(replies[0])
      if (!Array.isArray(scan) || typeof scan[0] !== 'string' || !Array.isArray(scan[1]))
        throw new ValetError('tool-run', 'unexpected-shape')
      const keys = scan[1].filter((k): k is string => typeof k === 'string').slice(0, MAX_KEYS)
      keys.sort()
      return { keys, complete: scan[0] === '0' && scan[1].length <= MAX_KEYS }
    },
  }),
}
