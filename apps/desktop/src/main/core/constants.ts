// Names and numbers the app decides once. Keychain and vault names outlive renames (D43), so they
// live here and nowhere else; each is still pending Nick's decision on D1/D6/D43.

import { join } from 'node:path'

/** Keychain item holding the 1Password service-account token (D43, pending). */
export const KEYCHAIN_SERVICE = 'siteadapter'
export const KEYCHAIN_ACCOUNT = 'onepassword-service-account'
/** The 1Password vault every granted item lives in (D6, pending). */
export const VAULT = 'siteadapter'

/** 1Password's Apple Developer Team ID: the op binary must be signed by it (D44). */
export const ONEPASSWORD_TEAM_ID = '2BUA8C4S2C'

/**
 * How long the person has to answer a confirmation before it counts as declined. D50 recommends
 * two minutes, below the clients' own tool-call timeouts; the runtime's default is five.
 */
export const CONFIRMATION_TIMEOUT_MS = 2 * 60_000

/** How long a login hand-off window stays up before it is closed and logins wait (D50). */
export const HANDOFF_WINDOW_MS = 15 * 60_000

/** The auth flow's own budget, including waiting for a one-time code. */
export const AUTH_FLOW_TIMEOUT_MS = 90_000
export const TYPING_DELAY_MS = 60

/** Runs whose input and output previews are kept in memory for the run trace. Nothing is persisted. */
export const RUN_MEMORY = 200

/** A client counts as connected while it has called within this window. */
export const CONNECTED_WINDOW_MS = 10 * 60_000

export const MCP_SERVER_NAME = 'siteadapter'

export interface DataPaths {
  readonly dir: string
  readonly grants: string
  readonly grantItems: string
  readonly approvals: string
  readonly manifests: string
  readonly audit: string
  readonly breakers: string
  readonly settings: string
  readonly clients: string
  readonly endpoint: string
  readonly bridgeConfig: string
  readonly loginMarkers: string
}

/** Every file the app keeps, under one owner-only directory (D45). */
export function dataPaths(dir: string): DataPaths {
  return {
    dir,
    grants: join(dir, 'grants.json'),
    grantItems: join(dir, 'grant-items.json'),
    approvals: join(dir, 'approvals.json'),
    manifests: join(dir, 'approved-manifests.json'),
    audit: join(dir, 'audit.jsonl'),
    breakers: join(dir, 'breakers.json'),
    settings: join(dir, 'settings.json'),
    clients: join(dir, 'clients.json'),
    endpoint: join(dir, 'endpoint.json'),
    bridgeConfig: join(dir, 'bridge.json'),
    loginMarkers: join(dir, 'login-markers'),
  }
}
