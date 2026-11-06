// The IPC surface: one invoke channel per SiteAdapterApi method and one event channel. The preload
// builds window.siteadapter from this list and nothing else, and the main process validates every
// channel's arguments (ipc.ts). Plain data with no imports, so the sandboxed preload can bundle it.

/** Every invoke method, as its dotted path in SiteAdapterApi. */
export const INVOKE_METHODS = [
  'adapters.list',
  'adapters.get',
  'approvals.pending',
  'approvals.approve',
  'approvals.reject',
  'grants.list',
  'grants.providers',
  'grants.vaultItems',
  'grants.make',
  'grants.revoke',
  'runs.list',
  'runs.trace',
  'runs.statsToday',
  'audit.page',
  'audit.verify',
  'audit.chainStatus',
  'audit.exportJsonl',
  'endpoint.status',
  'endpoint.setListening',
  'endpoint.rotateToken',
  'endpoint.snippets',
  'endpoint.copyClientConfig',
  'endpoint.copyUrl',
  'clients.list',
  'clients.revoke',
  'attention.list',
  'answerConfirmation',
  'openLoginWindow',
  'finishLogin',
  'closeLoginWindow',
  'settings.get',
  'settings.set',
  'settings.chooseOpPath',
  'settings.clearOpPath',
  'updates.status',
  'updates.check',
  'health.sites',
  'app.status',
  'app.setPaused',
  'app.openControlPanel',
  'app.copyText',
  'app.quit',
] as const

export type InvokeMethod = (typeof INVOKE_METHODS)[number]

/** The prefix keeps our channels apart from anything Electron or a library registers. */
export const CHANNEL_PREFIX = 'siteadapter:'

export function invokeChannel(method: InvokeMethod): string {
  return `${CHANNEL_PREFIX}${method}`
}

/** Main to renderer: live-update notices, which carry no data beyond their type (and a seq). */
export const EVENT_CHANNEL = 'siteadapter:event'

export const APP_EVENT_TYPES = [
  'adapters-changed',
  'approvals-changed',
  'grants-changed',
  'runs-changed',
  'audit-appended',
  'endpoint-changed',
  'clients-changed',
  'attention-changed',
  'settings-changed',
  'health-changed',
  'app-changed',
] as const
