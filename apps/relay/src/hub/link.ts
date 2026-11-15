// How a Mac's object reaches the hub's object (relay-hub.md). Both live in this Worker; the hub
// answers on internal URLs that the front door never routes to.

import type { HubStatus } from '@valet/core/relay-protocol'
import type { HubLink } from '../core'
import type { Env } from '../env'

/** The one hub object. Single account for now (H5); rows carry an account id so it can shard later. */
export const HUB_OBJECT = 'hub'
export const HUB_INTERNAL = 'https://hub.internal'
export const MAC_INTERNAL = 'https://mac.internal'

export function hubEnabled(env: Env): boolean {
  return env.HUB !== undefined && env.HUB_HOST !== undefined && env.HUB_HOST !== ''
}

export function hubStub(env: Env): DurableObjectStub {
  const hub = env.HUB as DurableObjectNamespace
  return hub.get(hub.idFromName(HUB_OBJECT))
}

export function hubLink(env: Env): HubLink | undefined {
  if (!hubEnabled(env)) return undefined
  const ask = async (path: string, body: unknown): Promise<HubStatus> => {
    const response = await hubStub(env).fetch(`${HUB_INTERNAL}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`hub ${path}: ${response.status}`)
    return (await response.json()) as HubStatus
  }
  return {
    presence: (macId, online) => ask('/node/presence', { macId, online }),
    linkStart: (macId, name) => ask('/node/link-start', { macId, name }),
    unlink: (macId) => ask('/node/unlink', { macId }),
  }
}

/** The Mac's object, for the hub: tell the Mac its status, or ask whether it is connected. */
export function macStub(env: Env, macId: string) {
  const object = env.MAC_RELAY.get(env.MAC_RELAY.idFromName(macId))
  return {
    tell: async (status: HubStatus): Promise<void> => {
      await object.fetch(`${MAC_INTERNAL}/hub-status?mac=${macId}`, {
        method: 'POST',
        body: JSON.stringify(status),
      })
    },
    presence: async (): Promise<{ connected: boolean; lastFrameAt?: number }> => {
      const response = await object.fetch(`${MAC_INTERNAL}/presence?mac=${macId}`)
      return (await response.json()) as { connected: boolean; lastFrameAt?: number }
    },
  }
}
