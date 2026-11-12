// View models: runtime, store and manifest state turned into the shapes of src/shared/api.ts. They
// copy named fields only, so nothing a store or the runtime holds (an item reference, a cookie, a
// token) can ride along into what the renderer receives.

import {
  type AdapterManifest,
  type AuditRecord,
  type Grant,
  hasLogin,
  MESSAGES_SECRET,
  messagesSourcesIn,
  type Purpose,
  settingToolNames,
} from '@valet/core'
import type { SiteHealthSnapshot } from '@valet/runtime'
import type {
  AdapterDetail,
  AdapterSettingInfo,
  AdapterSummary,
  ApprovalState,
  GrantInfo,
  LoginMissingItem,
  MessagesSourceInfo,
  PendingReview,
  ReviewItem,
  SecretRequestInfo,
  SessionStatus,
  SettingMissingItem,
  SiteHealth,
} from '../../shared/api'
import type { ChosenSetting } from './adapter-settings'
import { grantInfo } from './grants'
import {
  addsPermissions,
  fileChanges,
  limitsInfo,
  lineDiff,
  manifestText,
  permissionDiff,
  probeInfo,
} from './permission-diff'
import type { ApprovedSnapshot, BuiltinAdapter } from './registry'

export interface AdapterState {
  readonly adapter: BuiltinAdapter
  /** Whether the installed hash is approved, and when. */
  readonly approved: boolean
  readonly approvedAt: string | null
  /** The person rejected exactly the installed hash. */
  readonly rejected: boolean
  /** The last approved bundle, when it isn't the installed one. */
  readonly previous: ApprovedSnapshot | null
  readonly grants: readonly Grant[]
  readonly titles: Readonly<Record<string, string>>
  readonly session: SessionStatus
  readonly calls: ReadonlyMap<string, number>
  readonly lastUsed: (grant: Grant) => string | null
  readonly handedOver: { readonly cookies: number; readonly storageKeys: number } | null
  /** What the person chose for the adapter's settings, by setting name. */
  readonly chosen: Readonly<Record<string, ChosenSetting>>
  /** The person paused this site (app-state.ts). Absent: not paused. */
  readonly paused?: boolean
}

/** The manifest's settings with the person's choices. A choice for a setting it no longer declares is not shown. */
export function settingInfos(state: AdapterState): AdapterSettingInfo[] {
  return Object.entries(state.adapter.definition.manifest.settings).map(([name, setting]) => {
    const chosen = Object.hasOwn(state.chosen, name) ? state.chosen[name] : undefined
    return {
      name,
      title: setting.title,
      description: setting.description,
      required: setting.required,
      queryLabel: setting.choices.queryLabel,
      chosen:
        chosen === undefined
          ? null
          : { id: chosen.value, label: chosen.label, detail: chosen.detail, chosenAt: chosen.chosenAt },
    }
  })
}

/** The site a person recognises: the home page's host without a leading www. */
export function siteOf(manifest: AdapterManifest): string {
  const host = new URL(manifest.home).hostname
  return host.startsWith('www.') ? host.slice(4) : host
}

export function approvalState(state: AdapterState): ApprovalState {
  if (state.approved) return 'approved'
  return state.rejected ? 'rejected' : 'unapproved'
}

function grantsForHash(state: AdapterState): Grant[] {
  return state.grants.filter(
    (g) => g.adapterId === state.adapter.definition.manifest.id && g.adapterHash === state.adapter.hash,
  )
}

function info(state: AdapterState, grant: Grant): GrantInfo {
  return grantInfo(grant, state.titles, state.lastUsed(grant))
}

function uniqueSenders(manifest: AdapterManifest): { sender: string; maxAgeSeconds: number }[] {
  const seen = new Map<string, number>()
  for (const { sender, maxAgeSeconds } of messagesSourcesIn(manifest.auth.steps)) {
    if (!seen.has(sender)) seen.set(sender, maxAgeSeconds)
  }
  return [...seen].map(([sender, maxAgeSeconds]) => ({ sender, maxAgeSeconds }))
}

function messagesInfo(state: AdapterState): MessagesSourceInfo[] {
  const manifest = state.adapter.definition.manifest
  const granted = grantsForHash(state).filter(
    (g) => g.provider === 'messages' && g.secret === MESSAGES_SECRET,
  )
  return uniqueSenders(manifest).map(({ sender, maxAgeSeconds }) => {
    // Only the sender the grant names is granted, character for character.
    const grant = granted.find((g) => g.itemRef === sender)
    return {
      sender,
      maxAgeSeconds,
      requestedOrigins: [...manifest.navigation],
      grant: grant === undefined ? null : info(state, grant),
    }
  })
}

function secretRequests(state: AdapterState): SecretRequestInfo[] {
  const grants = grantsForHash(state)
  return Object.entries(state.adapter.definition.manifest.secrets).map(([name, request]) => {
    const grant = grants.find((g) => g.secret === name && g.provider !== 'messages')
    return {
      name,
      description: request.description,
      fields: [...request.fields],
      origins: [...request.origins],
      grant: grant === undefined ? null : info(state, grant),
    }
  })
}

function toolCounts(manifest: AdapterManifest): Record<Purpose, number> {
  const counts: Record<Purpose, number> = { read: 0, write: 0, irreversible: 0 }
  // Only the tools a client can call: a setting's own tools are Valet's to run.
  const internal = settingToolNames(manifest)
  for (const tool of manifest.tools) if (!internal.has(tool.name)) counts[tool.sideEffect]++
  return counts
}

export function adapterSummary(state: AdapterState): AdapterSummary {
  const manifest = state.adapter.definition.manifest
  const secrets = secretRequests(state)
  return {
    id: manifest.id,
    name: manifest.name,
    site: siteOf(manifest),
    version: manifest.version,
    hash: state.adapter.hash,
    approval: approvalState(state),
    // A built-in bundle replaces the old one when the app updates, so a changed hash is both the
    // installed bundle and the one waiting for review.
    pendingUpdate:
      !state.approved && !state.rejected && state.previous !== null
        ? { version: manifest.version, hash: state.adapter.hash }
        : null,
    toolCounts: toolCounts(manifest),
    secrets: secrets.map((s) => ({ name: s.name, granted: s.grant !== null })),
    messagesSources: messagesInfo(state).map((m) => ({ sender: m.sender, granted: m.grant !== null })),
    session: state.session,
    calls7d: state.calls.get(manifest.id) ?? 0,
    settingsNeeded: settingInfos(state)
      .filter((s) => s.required && s.chosen === null)
      .map((s) => s.title),
    cartUrl: approvalState(state) === 'approved' ? (manifest.cartUrl ?? null) : null,
    paused: state.paused ?? false,
  }
}

export function adapterDetail(state: AdapterState): AdapterDetail {
  const manifest = state.adapter.definition.manifest
  const internal = settingToolNames(manifest)
  return {
    ...adapterSummary(state),
    description: manifest.description,
    home: manifest.home,
    approvedAt: state.approved ? state.approvedAt : null,
    partitions: { auth: `persist:auth:${manifest.id}`, tool: `persist:tool:${manifest.id}` },
    navigation: [...manifest.navigation],
    frameOrigins: [...manifest.auth.frameOrigins],
    egress: [...manifest.egress],
    cookieDomains: [...manifest.session.cookieDomains],
    storage: manifest.session.storage.map(({ origin, keys }) => ({ origin, keys: [...keys] })),
    probe: probeInfo(manifest),
    requests: manifest.requests.map(({ method, path, purpose }) => ({ method, path, purpose })),
    limits: limitsInfo(manifest),
    tools: manifest.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      sideEffect: t.sideEffect,
      calls7d: state.calls.get(`${manifest.id}/${t.name}`) ?? 0,
      internal: internal.has(t.name),
    })),
    settings: settingInfos(state),
    secretRequests: secretRequests(state),
    messages: messagesInfo(state),
    handedOver: state.handedOver,
  }
}

/** The review waiting for the installed bundle, or null when it is approved or rejected. */
export function pendingReview(state: AdapterState, submittedAt: string): PendingReview | null {
  if (state.approved || state.rejected) return null
  const manifest = state.adapter.definition.manifest
  const before = state.previous
  return {
    adapterId: manifest.id,
    name: manifest.name,
    site: siteOf(manifest),
    from: before === null ? null : { version: before.version, hash: before.hash },
    to: { version: manifest.version, hash: state.adapter.hash },
    submittedAt,
    // Built-in bundles arrive with the app. The API's sources are for imported bundles.
    source: 'import',
    diff: permissionDiff(before?.manifest ?? null, manifest),
    manifestDiff: lineDiff(before === null ? [] : manifestText(before.manifest), manifestText(manifest)),
    files: fileChanges(before?.files ?? null, state.adapter.files),
    origin: state.adapter.source ?? 'builtin',
    takesSession: (state.adapter.source ?? 'builtin') !== 'builtin' && hasLogin(manifest),
  }
}

export function reviewItem(review: PendingReview): ReviewItem {
  return {
    kind: 'review',
    id: `rv_${review.adapterId}`,
    adapterId: review.adapterId,
    adapterName: review.name,
    version: review.to.version,
    addsPermissions: addsPermissions(review.diff),
    firstInstall: review.from === null,
  }
}

/**
 * What an approved site still needs before its calls can work: each required setting with no
 * choice ("Choose your Woolworths store") and each declared login with no grant for the installed
 * hash ("Give Valet your Woolworths login"). An unapproved site has its review instead.
 */
export function missingItems(state: AdapterState): (SettingMissingItem | LoginMissingItem)[] {
  if (approvalState(state) !== 'approved') return []
  const manifest = state.adapter.definition.manifest
  const settings: SettingMissingItem[] = settingInfos(state)
    .filter((s) => s.required && s.chosen === null)
    .map((s) => ({
      kind: 'setting-missing',
      id: `sm_${manifest.id}_${s.name}`.slice(0, 64),
      adapterId: manifest.id,
      adapterName: manifest.name,
      setting: s.name,
      settingTitle: s.title,
    }))
  const logins: LoginMissingItem[] = secretRequests(state)
    .filter((s) => s.grant === null)
    .map((s) => ({
      kind: 'login-missing',
      id: `lm_${manifest.id}_${s.name}`.slice(0, 64),
      adapterId: manifest.id,
      adapterName: manifest.name,
      secret: s.name,
    }))
  return [...settings, ...logins]
}

/**
 * Per site host: the breaker as the runtime holds it (ToolHost.siteHealth, persisted state
 * included), with the cause and time of its last opening from the audit log, which the runtime
 * doesn't keep.
 */
export function siteHealth(
  snapshots: readonly SiteHealthSnapshot[],
  records: readonly AuditRecord[],
): SiteHealth[] {
  return snapshots.map((site) => {
    const retryAt = site.breaker === 'open' ? site.retryAt : null
    const lastOpened = [...records]
      .reverse()
      .find((r) => r.event.type === 'breaker-opened' && r.event.host === site.host)
    const opened = lastOpened?.event.type === 'breaker-opened' ? lastOpened.event : null
    return {
      host: site.host,
      adapterIds: [...site.adapterIds],
      breaker: retryAt !== null ? 'open' : 'closed',
      retryAt: retryAt !== null ? new Date(retryAt).toISOString() : null,
      cause: retryAt !== null ? (opened?.cause ?? 'blocked-by-site') : null,
      lastOpenedAt: lastOpened?.at ?? null,
      nextCooldownSeconds: Math.round(site.nextCooldownMs / 1000),
      calls: site.calls,
    }
  })
}
