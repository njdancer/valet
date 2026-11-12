// The Durable Object for one Mac: the Durable Object API adapted to RelayCore's interfaces. Uses
// the WebSocket hibernation API, so an idle Mac or phone connection costs almost nothing, and
// answers "ping" without waking (relay.md, "Shape").

import { DurableObject } from 'cloudflare:workers'
import type { RelayStoredState } from '@valet/core/relay-protocol'
import { type ConsentAnswer, type ForwardRequest, type RelaySocket, RelayCore, type Role, type SocketState } from './core'
import type { Env } from './env'
import type { PushKind, PushResult } from './push'

const STATE_KEY = 'state'

export class MacRelay extends DurableObject<Env> {
  private core: RelayCore | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /** The Mac's id is the object's name, which the front door checked against KEY_ID. */
  private relay(macId: string): RelayCore {
    if (this.core !== null) return this.core
    const ctx = this.ctx
    const env = this.env
    this.core = new RelayCore({
      macId,
      origin: env.RELAY_ORIGIN,
      env: {
        sockets: () => ctx.getWebSockets().map(wrap),
        load: async () => (await ctx.storage.get<RelayStoredState>(STATE_KEY)) ?? null,
        save: async (state) => {
          // Exactly RelayStoredState, under one key. Nothing else is ever written.
          await ctx.storage.put(STATE_KEY, state)
        },
        wakeAt: (at) => {
          void ctx.storage.getAlarm().then((current) => {
            if (current === null || current > at) return ctx.storage.setAlarm(at)
          })
        },
        push: (token, kind) => push(env, token, kind),
      },
    })
    return this.core
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const macId = url.searchParams.get('mac') ?? ''
    const core = this.relay(macId)
    switch (url.pathname) {
      case '/connect': {
        const role = url.searchParams.get('role') as Role
        const pair = new WebSocketPair()
        const [client, server] = [pair[0], pair[1]]
        this.ctx.acceptWebSocket(server)
        server.serializeAttachment({ macId })
        core.connect(wrap(server), role)
        return new Response(null, { status: 101, webSocket: client })
      }
      case '/forward': {
        const forward = (await request.json()) as ForwardRequest
        return core.forward(forward, request.signal)
      }
      case '/consent': {
        const { id, query, source } = (await request.json()) as { id: string; query: string; source: string }
        return Response.json(await core.consent(id, query, source))
      }
      default:
        return new Response('Not found', { status: 404 })
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.relayFor(ws).message(wrap(ws), message)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.relayFor(ws).closed(wrap(ws))
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.relayFor(ws).closed(wrap(ws))
  }

  override async alarm(): Promise<void> {
    const first = this.ctx.getWebSockets()[0]
    if (first !== undefined) this.relayFor(first).alarm()
  }

  /** After hibernation the object is new; the Mac's id travels in each socket's attachment. */
  private relayFor(ws: WebSocket): RelayCore {
    return this.relay((ws.deserializeAttachment() as Attached | null)?.macId ?? '')
  }
}

type Attached = SocketState & { readonly macId: string }

function wrap(ws: WebSocket): RelaySocket {
  return {
    send: (text) => ws.send(text),
    close: (code, reason) => {
      try {
        ws.close(code, reason)
      } catch {
        // Already closed.
      }
    },
    state: () => (ws.deserializeAttachment() as Attached | null) ?? null,
    setState: (state) => {
      const previous = ws.deserializeAttachment() as Attached | null
      ws.serializeAttachment({ ...state, macId: previous?.macId ?? '' })
    },
  }
}

async function push(env: Env, token: string, kind: PushKind): Promise<PushResult> {
  if (env.PUSH === undefined) return 'off'
  const stub = env.PUSH.get(env.PUSH.idFromName('apns'))
  const response = await stub.fetch('https://push.internal/send', {
    method: 'POST',
    body: JSON.stringify({ token, kind }),
  })
  return ((await response.json()) as { result: PushResult }).result
}

export type { ConsentAnswer }
