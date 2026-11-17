// The permission-diff lines for an adapter's kind and its private hosts
// (docs/adapter-kinds.md#approval-cards-and-the-permission-diff), in the app's words. Computed by
// the Mac from the old and new manifests; the agent that wrote the adapter never writes these.

import { type DependencyLock, dependencySummary } from './dependencies'
import { type AdapterManifest, type PrivateHost, type RuntimeKind, runtimeOf } from './manifest'
import type { PermissionChange, Risk } from './permission-change'
import { narrowedImapFolders, type Protocols, widenedImapFolders, widenedRecipients } from './protocols'
import { privateHostKey } from './request-surface'

/** What a kind means, as the card says it. */
export function describeRuntime(kind: RuntimeKind): string {
  switch (kind) {
    case 'browser':
      return 'Runs in a browser that Valet drives'
    case 'http':
      return 'Calls web APIs through Valet, with no browser'
    case 'protocol':
      return 'Uses mail or file protocols through Valet'
    case 'raw':
      return 'Runs its own code and npm packages in its own sandbox, reaching only the endpoints listed'
  }
}

/**
 * How much a change to `kind` widens what an adapter can do. `raw` is high, not critical: it is
 * approved on the phone or the Mac like everything else (Nick, 2026-11-17), and the card's other
 * lines (endpoints, credentials, packages) say what it can reach.
 */
function runtimeRisk(kind: RuntimeKind): Risk {
  if (kind === 'raw') return 'high'
  return kind === 'browser' ? 'low' : 'medium'
}

/** One raw endpoint as the card says it. Valet checks a TLS connection's server name, not its contents. */
export function describeRawEndpoint(endpoint: string): string {
  return `${endpoint} (its own encrypted connection; Valet checks the server name)`
}

/** One private host as the card says it: where, how, and whether its certificate is pinned. */
export function describePrivateHost(host: PrivateHost, kind: RuntimeKind = 'http'): string {
  // A raw adapter speaks whatever it likes to the host: Valet carries the bytes, unread.
  if (kind === 'raw') return `${privateHostKey(host)} on your network (its own connection)`
  const scheme = host.scheme ?? 'https'
  const how =
    scheme === 'http'
      ? 'unencrypted http'
      : host.certSha256 === undefined
        ? 'https'
        : `https, certificate ${host.certSha256.slice(0, 12)}…`
  return `${privateHostKey(host)} on your network (${how})`
}

/**
 * The lines for the kind, a raw adapter's endpoints and the private hosts between the approved
 * manifest (null for a first install) and the new one. A first install that isn't a browser
 * adapter says what it is; a change of kind is a line at the new kind's risk. Each added private
 * host is high: it reaches a device on the person's own network, which nothing else on the card
 * covers. Each added raw endpoint is high: Valet can't see inside the adapter's connections.
 */
export function runtimePermissionChanges(
  before: Pick<AdapterManifest, 'runtime' | 'privateHosts' | 'endpoints'> | null,
  after: Pick<AdapterManifest, 'runtime' | 'privateHosts' | 'endpoints'>,
): PermissionChange[] {
  const changes: PermissionChange[] = []
  const was = before === null ? null : runtimeOf(before)
  const now = runtimeOf(after)
  if (was !== now && !(was === null && now === 'browser')) {
    changes.push({ area: 'runtime', change: 'added', items: [describeRuntime(now)], risk: runtimeRisk(now) })
  }
  const diff = (area: PermissionChange['area'], had: Set<string>, has: Set<string>) => {
    const added = [...has].filter((h) => !had.has(h))
    const removed = [...had].filter((h) => !has.has(h))
    if (added.length > 0) changes.push({ area, change: 'added', items: added.slice(0, 50), risk: 'high' })
    if (removed.length > 0)
      changes.push({ area, change: 'removed', items: removed.slice(0, 50), risk: 'low' })
  }
  const endpoints = (m: typeof after | null) =>
    new Set(m === null || runtimeOf(m) !== 'raw' ? [] : (m.endpoints ?? []).map(describeRawEndpoint))
  diff('egress', endpoints(before), endpoints(after))
  const hosts = (m: typeof after | null) =>
    new Set((m?.privateHosts ?? []).map((h) => describePrivateHost(h, runtimeOf(m ?? {}))))
  diff('private-network', hosts(before), hosts(after))
  return changes
}

/**
 * The lines for a protocol adapter's scope (cross-kind red team, workstream I): the IMAP folders its
 * tools may use and who its SMTP tools may send to. Without these an update that drops a folder
 * list (every folder, INBOX included) or a recipients list (anyone) had no line at all, and the
 * card read "no new permissions". Every folder, INBOX and any recipient are high; another folder
 * is medium. A first install lists its scope the same way.
 */
export function protocolPermissionChanges(
  before: { readonly protocols?: Protocols | undefined } | null,
  after: { readonly protocols?: Protocols | undefined },
): PermissionChange[] {
  const changes: PermissionChange[] = []
  const had = before?.protocols
  const has = after.protocols
  const how = (present: boolean): PermissionChange['change'] => (present ? 'widened' : 'added')
  const folders = widenedImapFolders(had, has)
  if (folders === 'every') {
    changes.push({
      area: 'runtime',
      change: how(had?.imap !== undefined),
      items: ['Mail: every folder, INBOX included'],
      risk: 'high',
    })
  } else {
    const inbox = folders.filter((f) => f.toUpperCase() === 'INBOX')
    const others = folders.filter((f) => f.toUpperCase() !== 'INBOX')
    if (inbox.length > 0)
      changes.push({
        area: 'runtime',
        change: how(had?.imap !== undefined),
        items: ['Mail folder INBOX'],
        risk: 'high',
      })
    if (others.length > 0)
      changes.push({
        area: 'runtime',
        change: how(had?.imap !== undefined),
        items: others.slice(0, 50).map((f) => `Mail folder ${f}`),
        risk: 'medium',
      })
  }
  const dropped = narrowedImapFolders(had, has)
  if (dropped.length > 0)
    changes.push({
      area: 'runtime',
      change: 'narrowed',
      items: dropped.slice(0, 50).map((f) => `Mail folder ${f}`),
      risk: 'low',
    })
  const recipients = widenedRecipients(had, has)
  if (recipients === 'anyone') {
    changes.push({
      area: 'runtime',
      change: how(had?.smtp !== undefined),
      items: ['Sends mail to anyone (you confirm each message)'],
      risk: 'high',
    })
  } else if (recipients.length > 0) {
    changes.push({
      area: 'runtime',
      change: how(had?.smtp !== undefined),
      items: recipients
        .slice(0, 50)
        .map((r) => `Sends mail to ${r.startsWith('@') ? `anyone at ${r.slice(1)}` : r}`),
      risk: 'high',
    })
  }
  return changes
}

/**
 * A raw adapter's npm packages, on every card for one of its versions (the lockfile isn't in the
 * manifest, and the code is new each time anyway): the direct ones by name and version, and a
 * count of the rest. Empty for an adapter without any.
 */
export function dependencyPermissionChanges(lock: DependencyLock | null): PermissionChange[] {
  const summary = dependencySummary(lock)
  if (summary.direct.length === 0) return []
  const names = summary.direct.slice(0, 48).map((d) => `npm package ${d.name} ${d.version}`)
  const rest = summary.direct.length - names.length + summary.others
  return [
    {
      area: 'runtime',
      change: 'added',
      items: rest === 0 ? names : [...names, `and ${rest} package${rest === 1 ? '' : 's'} they use`],
      risk: 'high',
    },
  ]
}
