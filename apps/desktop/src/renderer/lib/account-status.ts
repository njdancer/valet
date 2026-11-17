// One line saying where this Mac stands with the Valet account (docs/relay-hub.md), for the Needs you
// status card. It answers "did connecting work?" without opening Settings, Devices.

import type { PhonesStatus } from '../../shared/api'

export interface AccountLine {
  readonly tone: 'success' | 'warning' | 'neutral'
  readonly text: string
}

/** Null when there's nothing to say: no relay, a relay without a hub, or one that hasn't answered. */
export function accountLine(status: PhonesStatus): AccountLine | null {
  const hub = status.hub
  if (hub === null || hub.state === 'off') return null
  if (hub.state === 'unlinked') return { tone: 'neutral', text: 'Valet account · this Mac isn’t on it' }
  if (hub.state === 'linking')
    return { tone: 'neutral', text: 'Valet account · waiting for the code to be typed on the hub’s page' }
  const who = `${hub.account}’s account as ${hub.slug}`
  if (status.relay !== 'online')
    return {
      tone: 'warning',
      text: `Valet account · on ${who}, but not connected to the hub now, so agents can’t reach this Mac`,
    }
  if (status.roster.state === 'needs-you' || status.roster.state === 'not-added')
    return { tone: 'warning', text: `Valet account · on ${who} · the device list needs you` }
  if (status.roster.state === 'refused')
    return { tone: 'warning', text: `Valet account · on ${who} · the device list doesn’t check` }
  return { tone: 'success', text: `Valet account · connected to ${who}` }
}
