// What the tray shows for remote access, as plain data so it is tested without Electron.

import type { RemoteStatus } from './remote'

/** What the tray needs from remote access: the service's RemoteAccess. */
export interface TrayRemote {
  status(): RemoteStatus
  setEnabled(enabled: boolean): Promise<void>
  revokeAllClients(): Promise<number>
}

export interface RemoteTrayState {
  /** Next to the icon. Empty when there is nothing to say. */
  readonly title: string
  readonly tooltip: string
  /** The kill switch, or resuming; null when remote access was never set up. */
  readonly menuItem: { readonly label: string; readonly enable: boolean } | null
  /**
   * "Revoke all remote clients…", the destructive one (relay.md): shown while any client is kept,
   * and it asks before it acts. Pausing keeps clients; this deletes them.
   */
  readonly revokeAll: boolean
}

/**
 * needsYou is how many Needs you items wait (missed ones left out): the icon carries the count, so
 * a confirmation or a login waiting is seen without opening anything (IA section 3).
 */
export function remoteTrayState(status: RemoteStatus, demo: boolean, needsYou = 0): RemoteTrayState {
  const on = status.enabled
  const words = [needsYou > 0 ? String(needsYou) : null, demo ? 'DEMO' : null, on ? 'REMOTE' : null].filter(
    (w) => w !== null,
  )
  const base = demo ? 'Valet (demo)' : 'Valet'
  const waiting = needsYou === 0 ? '' : `, ${needsYou} waiting for you`
  const tooltip = !on
    ? `${base}${waiting}`
    : status.listening
      ? `${base}${waiting}: remote access on, ${status.sessions} remote ${status.sessions === 1 ? 'session' : 'sessions'}`
      : `${base}${waiting}: remote access on, not listening`
  let menuItem: RemoteTrayState['menuItem'] = null
  // Pausing is always offered while on. Resuming only once there is something to resume: a name
  // the tunnel forwards. Until then remote access is set up in the control panel, not here.
  if (on) menuItem = { label: 'Pause remote access', enable: false }
  else if (status.hosts.length > 0) menuItem = { label: 'Resume remote access', enable: true }
  return { title: words.join(' · '), tooltip, menuItem, revokeAll: status.clients > 0 }
}
