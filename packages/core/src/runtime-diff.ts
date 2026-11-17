// The permission-diff lines for an adapter's kind and its private hosts
// (docs/adapter-kinds.md#approval-cards-and-the-permission-diff), in the app's words. Computed by
// the Mac from the old and new manifests; the agent that wrote the adapter never writes these.

import { canonicalAddress, parseEndpoint } from './addresses'
import { type AdapterManifest, type PrivateHost, type RuntimeKind, runtimeOf } from './manifest'
import type { PermissionChange, Risk } from './permission-change'
import type { SftpProtocol } from './protocols'
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
      return 'Runs its own code with network access through Valet'
  }
}

/** How much a change to `kind` widens what an adapter can do. */
function runtimeRisk(kind: RuntimeKind): Risk {
  if (kind === 'raw') return 'critical'
  return kind === 'browser' ? 'low' : 'medium'
}

/** One private host as the card says it: where, how, and whether its certificate is pinned. */
export function describePrivateHost(host: PrivateHost): string {
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
 * The lines for the kind and private hosts between the approved manifest (null for a first
 * install) and the new one. A first install that isn't a browser adapter says what it is; a change
 * of kind is a line at the new kind's risk. Each added private host is high: it reaches a device
 * on the person's own network, which nothing else on the card covers.
 */
export function runtimePermissionChanges(
  before: Pick<AdapterManifest, 'runtime' | 'privateHosts' | 'protocols'> | null,
  after: Pick<AdapterManifest, 'runtime' | 'privateHosts' | 'protocols'>,
): PermissionChange[] {
  const changes: PermissionChange[] = []
  const was = before === null ? null : runtimeOf(before)
  const now = runtimeOf(after)
  if (was !== now && !(was === null && now === 'browser')) {
    changes.push({ area: 'runtime', change: 'added', items: [describeRuntime(now)], risk: runtimeRisk(now) })
  }
  const had = new Set((before?.privateHosts ?? []).map(describePrivateHost))
  const has = new Set((after.privateHosts ?? []).map(describePrivateHost))
  const added = [...has].filter((h) => !had.has(h))
  const removed = [...had].filter((h) => !has.has(h))
  if (added.length > 0) changes.push({ area: 'private-network', change: 'added', items: added, risk: 'high' })
  if (removed.length > 0)
    changes.push({ area: 'private-network', change: 'removed', items: removed, risk: 'low' })
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
  for (const level of ['high', 'medium', 'low'] as const) {
    const added = [...has].filter(([text, r]) => !had.has(text) && rootRisk(r) === level)
    if (added.length > 0)
      changes.push({ area: 'requests', change: 'added', items: added.map(([text]) => text), risk: level })
  }
  const removed = [...had.keys()].filter((text) => !has.has(text))
  if (removed.length > 0) changes.push({ area: 'requests', change: 'removed', items: removed, risk: 'low' })
  return changes
}
