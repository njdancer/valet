// View models: runtime, store and manifest state turned into the shapes of src/shared/api.ts. They
// copy named fields only, so nothing a store or the runtime holds (an item reference, a cookie, a
// token) can ride along into what the renderer receives.

import {
  type AdapterManifest,
  type AuditRecord,
  type Grant,
  MESSAGES_SECRET,
  messagesSourcesIn,
  type Purpose,
} from '@siteadapter/core'
import { parseBreakerFile } from '@siteadapter/runtime'
import type {
  AdapterDetail,
  AdapterSummary,
  ApprovalState,
  GrantInfo,
  MessagesSourceInfo,
  PendingReview,
  ReviewItem,
  SecretRequestInfo,
  SessionStatus,
  SiteHealth,
} from '../../shared/api'
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
  for (const tool of manifest.tools) counts[tool.sideEffect]++
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
  }
}

export function adapterDetail(state: AdapterState): AdapterDetail {
  const manifest = state.adapter.definition.manifest
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
    })),
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
  }
}

/**
 * Per site host: the breaker as the runtime persisted it (breakers.json), and its cause and last
 * opening from the audit log. Hosts and limits follow the runtime: adapters sharing a host get the
 * most cautious numbers any of them declares.
 */
export function siteHealth(
  manifests: readonly AdapterManifest[],
  breakerFile: string | null,
  records: readonly AuditRecord[],
  now: number,
): SiteHealth[] {
  const states = breakerFile === null ? new Map() : (parseBreakerFile(breakerFile) ?? new Map())
  const hosts = new Map<string, AdapterManifest[]>()
  for (const manifest of manifests) {
    const host = new URL(manifest.home).hostname
    hosts.set(host, [...(hosts.get(host) ?? []), manifest])
  }
  return [...hosts].map(([host, list]) => {
    const base = Math.max(...list.map((m) => m.limits.cooldownSeconds))
    const max = Math.max(...list.map((m) => m.limits.maxCooldownSeconds))
    const state = states.get(host) as { retryAt: number; cooldownMs: number } | undefined
    const open = state !== undefined && state.retryAt > now
    const lastOpened = [...records]
      .reverse()
      .find((r) => r.event.type === 'breaker-opened' && r.event.host === host)
    const opened = lastOpened?.event.type === 'breaker-opened' ? lastOpened.event : null
    const doubled = state !== undefined && state.cooldownMs > 0 ? (state.cooldownMs * 2) / 1000 : base
    return {
      host,
      adapterIds: list.map((m) => m.id),
      breaker: open ? 'open' : 'closed',
      retryAt: open ? new Date(state.retryAt).toISOString() : null,
      cause: open ? (opened?.cause ?? 'blocked-by-site') : null,
      lastOpenedAt: lastOpened?.at ?? null,
      nextCooldownSeconds: Math.min(max, Math.max(base, Math.round(doubled))),
    }
  })
}
