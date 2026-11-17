// The permission-diff lines for an adapter's kind and its private hosts
// (docs/adapter-kinds.md#approval-cards-and-the-permission-diff), in the app's words. Computed by
// the Mac from the old and new manifests; the agent that wrote the adapter never writes these.

import { type AdapterManifest, type PrivateHost, type RuntimeKind, runtimeOf } from './manifest'
import type { PermissionChange, Risk } from './permission-change'
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
  before: Pick<AdapterManifest, 'runtime' | 'privateHosts'> | null,
  after: Pick<AdapterManifest, 'runtime' | 'privateHosts'>,
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
  return changes
}
