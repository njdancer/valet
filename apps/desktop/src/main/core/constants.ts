// Names and numbers the app decides once. Keychain and vault names outlive renames (D43), so they
// live here and nowhere else; D1 named the product Valet; D6 and D43 are still pending.

import { join } from 'node:path'

/** Keychain item holding the 1Password service-account token (D43, pending). */
export const KEYCHAIN_SERVICE = 'valet'
export const KEYCHAIN_ACCOUNT = 'onepassword-service-account'
/**
 * Where Keychain copies of granted 1Password items live (D6), and the Messages helper's launchd
 * label (D8, the plist in build/launch-agents). A development build keeps its own of each, so it
 * never reads or replaces the release build's.
 */
export function nativeNames(release: boolean): { copyService: string; messagesHelperLabel: string } {
  return release
    ? { copyService: 'valet.copy', messagesHelperLabel: 'me.dncr.valet.messages-helper' }
    : { copyService: 'valet.dev.copy', messagesHelperLabel: 'me.dncr.valet.dev.messages-helper' }
}

/** The 1Password vault every granted item lives in (D6, pending). */
export const VAULT = 'Valet'

/** 1Password's Apple Developer Team ID: the op binary must be signed by it (D44). */
export const ONEPASSWORD_TEAM_ID = '2BUA8C4S2C'

/**
 * How long the person has to answer a confirmation before it counts as declined. D50 recommends
 * two minutes, below the clients' own tool-call timeouts; the runtime's default is five.
 */
export const CONFIRMATION_TIMEOUT_MS = 2 * 60_000

/** How long a login hand-off window stays up before it is closed and logins wait (D50). */
export const HANDOFF_WINDOW_MS = 15 * 60_000

/**
 * How long the person's own login work (opening the login window, the hand-off after "I'm done")
 * waits for the adapter's tool calls and runs to finish before it gives up; new calls wait meanwhile.
 */
export const LOGIN_WAIT_MS = 30_000

/** The auth flow's own budget, including waiting for a one-time code. */
export const AUTH_FLOW_TIMEOUT_MS = 90_000
export const TYPING_DELAY_MS = 60

/** Runs whose input and output previews are kept in memory for the run trace. Nothing is persisted. */
export const RUN_MEMORY = 200

export const MCP_SERVER_NAME = 'valet'

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
  /** One bridge config file per client (clients.ts), each mode 0600. */
  readonly clientConfigs: string
  /** The one shared bridge config from before per-client tokens; deleted at start. */
  readonly legacyBridgeConfig: string
  readonly loginMarkers: string
  /** The last and highest versions this install has run (updates.ts). */
  readonly versions: string
  /** Whether first-run setup is finished (setup.ts). */
  readonly setup: string
  /** Remote access: on or paused, its names and port, and the remote-enabled tools (remote.ts). */
  readonly remote: string
  /** Run traces and screenshots, one entry per run, pruned after Settings' retention days (D27). */
  readonly traces: string
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
    clientConfigs: join(dir, 'client-configs'),
    legacyBridgeConfig: join(dir, 'bridge.json'),
    loginMarkers: join(dir, 'login-markers'),
    versions: join(dir, 'versions.json'),
    setup: join(dir, 'setup.json'),
    remote: join(dir, 'remote.json'),
    traces: join(dir, 'traces'),
  }
}
