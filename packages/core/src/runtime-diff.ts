// The permission-diff lines for an adapter's kind and its private hosts
// (docs/adapter-kinds.md#approval-cards-and-the-permission-diff), in the app's words. Computed by
// the Mac from the old and new manifests; the agent that wrote the adapter never writes these.

import { canonicalAddress, parseEndpoint } from './addresses'
import { type DependencyLock, dependencySummary } from './dependencies'
import { type AdapterManifest, type PrivateHost, type RuntimeKind, runtimeOf } from './manifest'
import type { PermissionChange, Risk } from './permission-change'
import {
  narrowedImapFolders,
  type Protocols,
  type SftpProtocol,
  widenedImapFolders,
  widenedRecipients,
} from './protocols'
import { privateHostKey } from './request-surface'
import { rootAllows } from './sftp-policy'

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
  before: Pick<AdapterManifest, 'runtime' | 'privateHosts' | 'endpoints' | 'protocols'> | null,
  after: Pick<AdapterManifest, 'runtime' | 'privateHosts' | 'endpoints' | 'protocols'>,
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
  changes.push(...sftpPermissionChanges(before?.protocols?.sftp ?? null, after.protocols?.sftp ?? null))
  return changes
}

/**
 * The SFTP server as the card says it: who Valet signs in as and where, then the pinned host key,
 * as two items so each fits a card line whole.
 */
export function describeSftpServer(sftp: SftpProtocol): [string, string] {
  const as = sftp.username === undefined ? '' : ` as ${sftp.username}`
  const host = parseEndpoint(sftp.endpoint)?.host ?? ''
  const local = canonicalAddress(host) === null ? '' : ' on your network'
  return [`SFTP${as} to ${sftp.endpoint}${local}`, `host key ${sftp.hostKeySha256}`]
}

const ROOT_WORDS: Readonly<Record<SftpProtocol['roots'][number]['access'], string>> = {
  read: 'Read files in',
  write: 'Read, add, append to and rename files in',
  irreversible: 'Read, add, append to, rename, replace and delete files in',
}

/** One root as the card says it. */
export function describeSftpRoot(root: SftpProtocol['roots'][number]): string {
  return `${ROOT_WORDS[root.access]} ${root.path === '/' ? '/ (everything this account can reach)' : root.path}`
}

const ROOT_RISK: Readonly<Record<SftpProtocol['roots'][number]['access'], Risk>> = {
  read: 'low',
  write: 'medium',
  irreversible: 'high',
}

/** A root that may change everything the account reaches (`/`) is high, whatever else it allows. */
function rootRisk(root: SftpProtocol['roots'][number]): Risk {
  return root.path === '/' && root.access !== 'read' ? 'high' : ROOT_RISK[root.access]
}

/**
 * The SFTP lines (docs/sftp.md#the-card): the server, under `private-network` (high) when it is
 * an address on the person's own network and `egress` (medium) otherwise; then the roots under
 * `requests`, each added at its own risk by the most it allows. A changed account, server or host
 * key is a new server: the new one is added and the old one removed. Removals are low.
 */
export function sftpPermissionChanges(
  before: SftpProtocol | null,
  after: SftpProtocol | null,
): PermissionChange[] {
  const changes: PermissionChange[] = []
  const areaOf = (sftp: SftpProtocol) =>
    canonicalAddress(parseEndpoint(sftp.endpoint)?.host ?? '') === null ? 'egress' : 'private-network'
  const was = before === null ? null : describeSftpServer(before)
  const now = after === null ? null : describeSftpServer(after)
  const same = was !== null && now !== null && was.join('\n') === now.join('\n')
  if (now !== null && after !== null && !same) {
    const area = areaOf(after)
    changes.push({ area, change: 'added', items: now, risk: area === 'egress' ? 'medium' : 'high' })
  }
  if (was !== null && before !== null && !same)
    changes.push({ area: areaOf(before), change: 'removed', items: was, risk: 'low' })
  const had = new Map((before?.roots ?? []).map((r) => [describeSftpRoot(r), r]))
  const has = new Map((after?.roots ?? []).map((r) => [describeSftpRoot(r), r]))
  // A root the old list already allowed at that access (on the same server) is a narrowing, not a
  // new permission: `/inbox` read where `/inbox` was write.
  const covered = (r: SftpProtocol['roots'][number]) =>
    same && before !== null && rootAllows(r.path, before.roots, r.access)
  const fresh = [...has].filter(([text]) => !had.has(text))
  for (const level of ['high', 'medium', 'low'] as const) {
    const added = fresh.filter(([, r]) => !covered(r) && rootRisk(r) === level)
    if (added.length > 0)
      changes.push({ area: 'requests', change: 'added', items: added.map(([text]) => text), risk: level })
  }
  const narrowed = fresh.filter(([, r]) => covered(r)).map(([text]) => text)
  if (narrowed.length > 0)
    changes.push({ area: 'requests', change: 'narrowed', items: narrowed, risk: 'low' })
  const removed = [...had.keys()].filter((text) => !has.has(text))
  if (removed.length > 0) changes.push({ area: 'requests', change: 'removed', items: removed, risk: 'low' })
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
