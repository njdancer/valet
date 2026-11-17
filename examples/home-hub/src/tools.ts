// The example WebSocket adapter (docs/adapter-kinds.md#h-example-adapters): a home hub on the
// person's own network. Its address is a private host, pinned by the SHA-256 of the hub's own
// certificate (a hub's certificate is self-signed, so no CA can vouch for it). Valet adds the kept
// token to the socket's upgrade request; the tool code never sees it.
//
// Reading is one REST request (GET /api/states). Acting goes over the hub's WebSocket, which
// answers numbered requests: call_service acts on one entity, get_states lists everything, and
// between a request and its result the hub may send events, which are skipped. The socket is
// declared a write, because anything sent on it could act: a read tool can't open it, so reading
// stays on the REST path a read may use.

import { type HttpSocket, type ToolContext, tool, ValetError } from '@valet/core'
import { z } from 'zod'

const HUB = 'https://192.168.1.20:8123'
const CREDENTIAL = 'hub'
const KINDS = ['light', 'switch', 'lock', 'sensor', 'binary_sensor'] as const
const WAIT_MS = 5_000
/** Messages read while waiting for one result: events in between are skipped, up to this many. */
const MAX_MESSAGES = 50

interface Message {
  id?: unknown
  type?: unknown
  success?: unknown
  result?: unknown
  error?: { code?: unknown } | null
}

/** Opens the hub's socket and waits for its hello. */
async function connect(ctx: ToolContext): Promise<HttpSocket> {
  if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
  const socket = await ctx.http.websocket(`${HUB}/api/websocket`, { credential: CREDENTIAL })
  const hello = await next(socket)
  if (hello.type === 'auth_invalid') throw new ValetError('tool-run', 'auth-failed')
  if (hello.type !== 'auth_ok') throw new ValetError('tool-run', 'unexpected-shape')
  return socket
}

async function next(socket: HttpSocket): Promise<Message> {
  const message = await socket.receive({ waitMs: WAIT_MS })
  if (message === null) throw new ValetError('tool-run', 'timed-out')
  if (message.kind === 'closed') throw new ValetError('tool-run', 'unavailable')
  try {
    const parsed: unknown = JSON.parse(message.data)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not an object')
    return parsed as Message
  } catch {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
}

/** Sends one request and returns its result, skipping events. */
export async function request(
  socket: HttpSocket,
  id: number,
  body: Record<string, unknown>,
): Promise<unknown> {
  await socket.send(JSON.stringify({ id, ...body }))
  for (let i = 0; i < MAX_MESSAGES; i++) {
    const message = await next(socket)
    if (message.type !== 'result' || message.id !== id) continue
    if (message.success === true) return message.result
    const code = message.error?.code
    if (code === 'not_found') throw new ValetError('tool-input', 'not-found')
    if (code === 'unauthorized') throw new ValetError('tool-run', 'auth-failed')
    throw new ValetError('tool-run', 'unavailable')
  }
  throw new ValetError('tool-run', 'unexpected-shape')
}

const device = z.object({
  id: z.string(),
  kind: z.enum(KINDS),
  name: z.string(),
  state: z.string(),
  /** A sensor's unit, such as °C. */
  unit: z.string().nullable(),
  changed: z.string().nullable(),
})

/** The entities the tools show, from get_states' result. Pure. */
export function toDevices(result: unknown): z.infer<typeof device>[] {
  if (!Array.isArray(result)) throw new ValetError('tool-run', 'unexpected-shape')
  const out: z.infer<typeof device>[] = []
  for (const e of result.slice(0, 500)) {
    if (e === null || typeof e !== 'object') continue
    const { entity_id: id, state, attributes, last_changed: changed } = e as Record<string, unknown>
    if (typeof id !== 'string' || !/^[a-z_]{1,32}\.[a-z0-9_]{1,64}$/.test(id) || typeof state !== 'string')
      continue
    const kind = id.split('.')[0] as (typeof KINDS)[number]
    if (!KINDS.includes(kind)) continue
    const attrs =
      attributes !== null && typeof attributes === 'object' ? (attributes as Record<string, unknown>) : {}
    out.push({
      id,
      kind,
      name: typeof attrs['friendly_name'] === 'string' ? attrs['friendly_name'].slice(0, 100) : id,
      state: state.slice(0, 50),
      unit:
        typeof attrs['unit_of_measurement'] === 'string' ? attrs['unit_of_measurement'].slice(0, 10) : null,
      changed: typeof changed === 'string' ? changed.slice(0, 40) : null,
    })
  }
  return out
}

export const tools = {
  list_devices: tool({
    input: z.object({ kind: z.enum(KINDS).optional() }),
    output: z.object({ devices: z.array(device) }),
    async run(ctx, input) {
      if (ctx.http === undefined) throw new ValetError('tool-run', 'not-granted')
      const response = await ctx.http.fetch(`${HUB}/api/states`, {
        headers: { accept: 'application/json' },
        credential: CREDENTIAL,
      })
      if (response.status === 401 || response.status === 403) throw new ValetError('tool-run', 'auth-failed')
      if (response.status !== 200) throw new ValetError('tool-run', 'unavailable')
      let body: unknown
      try {
        body = JSON.parse(response.body)
      } catch {
        throw new ValetError('tool-run', 'unexpected-shape')
      }
      const devices = toDevices(body)
      return { devices: input.kind === undefined ? devices : devices.filter((d) => d.kind === input.kind) }
    },
  }),

  switch_light: tool({
    input: z.object({ light: z.string().regex(/^light\.[a-z0-9_]{1,64}$/), on: z.boolean() }),
    output: z.object({ light: z.string(), state: z.string() }),
    async run(ctx, input) {
      const socket = await connect(ctx)
      try {
        await request(socket, 1, {
          type: 'call_service',
          domain: 'light',
          service: input.on ? 'turn_on' : 'turn_off',
          target: { entity_id: input.light },
        })
        // The state as the hub now has it, from the same socket.
        const now = toDevices(await request(socket, 2, { type: 'get_states' })).find(
          (d) => d.id === input.light,
        )
        if (now === undefined) throw new ValetError('tool-input', 'not-found')
        return { light: input.light, state: now.state }
      } finally {
        await socket.close()
      }
    },
  }),
}
