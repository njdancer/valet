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
export function nativeNames(release: boolean): {
  copyService: string
  messagesHelperLabel: string
  /** The packaged app's bundle id (electron-builder.config.ts), which macOS files its caches under. */
  bundleId: string
} {
  const bundleId = release ? 'me.dncr.valet' : 'me.dncr.valet.dev'
  return {
    copyService: release ? 'valet.copy' : 'valet.dev.copy',
    messagesHelperLabel: `${bundleId}.messages-helper`,
    bundleId,
  }
}

/** The 1Password vault every granted item lives in (D6, pending). */
export const VAULT = 'Valet'

/** 1Password's Apple Developer Team ID: the op binary must be signed by it (D44). */
export const ONEPASSWORD_TEAM_ID = '2BUA8C4S2C'

/**
 * How long the person has to answer a confirmation before it counts as declined. Two minutes
 * (D19 and D50, answered 2026-11-10), which is the runtime's default too.
 */
export const CONFIRMATION_TIMEOUT_MS = 2 * 60_000

/** How long a login hand-off window stays up before it is closed and logins wait (D50). */
export const HANDOFF_WINDOW_MS = 15 * 60_000

/**
 * How long the person's own login work (opening the login window, the hand-off after "I'm done")
 * waits for the adapter's tool calls and runs to finish before it gives up; new calls wait meanwhile.
 */
export const LOGIN_WAIT_MS = 30_000

/**
 * The auth flow's own budget, including waiting for a one-time code. The Woolworths login alone
 * takes close to 90 s against the fake under the site's request pacing (D28: four a minute), and
 * longer when a request or two went out in the minute before it, so 90 s cut a good login short.
 * The caller isn't kept for it: a call that has to log in is answered after a few seconds (D50).
 */
export const AUTH_FLOW_TIMEOUT_MS = 180_000
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
  /** When each site's last request went out, so a restart keeps the pace (the runtime's own). */
  readonly budgets: string
  readonly settings: string
  /** What the person chose for each adapter's settings (D69). */
  readonly adapterSettings: string
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
  /** Remote client registrations and their grants, secrets hashed (mcp-server's RemoteClients). */
  readonly remoteClients: string
  /** Run traces and screenshots, one entry per run, pruned after Settings' retention days (D27). */
  readonly traces: string
  /** The app's own diagnostics (diagnostics-log.ts): crashes and failures, never page text. */
  readonly diagnosticsLog: string
  /** Lock down and the sites the person paused (app-state.ts). */
  readonly appState: string
  /** Needs you items nobody answered, kept 24 hours (attention.ts). */
  readonly missed: string
  /** Installed adapter versions, by id and hash (@valet/adapter-store, docs/adapter-packages.md). */
  readonly adapters: string
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
    budgets: join(dir, 'budgets.json'),
    settings: join(dir, 'settings.json'),
    adapterSettings: join(dir, 'adapter-settings.json'),
    clients: join(dir, 'clients.json'),
    clientConfigs: join(dir, 'client-configs'),
    legacyBridgeConfig: join(dir, 'bridge.json'),
    loginMarkers: join(dir, 'login-markers'),
    versions: join(dir, 'versions.json'),
    setup: join(dir, 'setup.json'),
    remote: join(dir, 'remote.json'),
    remoteClients: join(dir, 'remote-clients.json'),
    traces: join(dir, 'traces'),
    diagnosticsLog: join(dir, 'logs', 'valet.log'),
    appState: join(dir, 'app-state.json'),
    missed: join(dir, 'missed.json'),
    adapters: join(dir, 'adapters'),
  }
}
