// The relay Worker (docs/relay-worker.md). Remote MCP clients reach a Mac that only dials out.

import type { ForwardRequest } from './core'
import type { Env } from './env'
import { type FrontDoor, frontDoor, type MacRelayStub, waitKey } from './front'
import { logFailure } from './log'

export { MacRelay } from './mac-relay'
export { PushRelay } from './push-relay'

let key: { readonly secret: string | undefined; readonly key: Promise<CryptoKey> } | null = null

function stub(env: Env, macId: string): MacRelayStub {
  const object = env.MAC_RELAY.get(env.MAC_RELAY.idFromName(macId))
  const at = (path: string, extra = '') => `https://mac.internal${path}?mac=${macId}${extra}`
  return {
    connect: (request, role) => object.fetch(new Request(at('/connect', `&role=${role}`), request)),
    forward: (request: ForwardRequest, signal) =>
      object.fetch(at('/forward'), { method: 'POST', body: JSON.stringify(request), signal }),
    consent: async (id, query, source) => {
      const response = await object.fetch(at('/consent'), { method: 'POST', body: JSON.stringify({ id, query, source }) })
      return response.json()
    },
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (key === null || key.secret !== env.WAIT_SECRET) key = { secret: env.WAIT_SECRET, key: waitKey(env.WAIT_SECRET) }
    const door: FrontDoor = {
      host: env.RELAY_HOST,
      waitKey: await key.key,
      mac: (macId) => stub(env, macId),
      limits: {
        connect: env.CONNECT_LIMIT,
        forward: env.FORWARD_LIMIT,
        signIn: env.SIGN_IN_LIMIT,
        poll: env.POLL_LIMIT,
      },
    }
    try {
      return await frontDoor(request, door)
    } catch (error) {
      logFailure('front door', error)
      return new Response('Relay error', { status: 500, headers: { 'cache-control': 'no-store' } })
    }
  },
} satisfies ExportedHandler<Env>
