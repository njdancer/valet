// What first-run setup knows and decides (AC2, AC3): whether each step is done, read from the same
// API as the rest of the app (so a step done elsewhere shows as done here), and where setup resumes.
// The menu bar's "Finish setup (N steps left)" row counts from the same facts.

import type {
  AdapterDetail,
  ClientInfo,
  ClientKind,
  EndpointStatus,
  PendingReview,
  ProviderStatus,
  Settings,
} from '../../../shared/api'
import { type Loaded, useLoad } from '../../lib/api-context'
import { SETUP_STEPS, type SetupStep } from '../../lib/routes'

/** The adapter setup approves and grants: the bundled one. */
export const SETUP_ADAPTER = 'woolworths'

/** The clients setup offers, each added under this name with its own token (D42). */
export const SETUP_CLIENTS: readonly { readonly kind: ClientKind; readonly name: string }[] = [
  { kind: 'claude-code', name: 'Claude Code' },
  { kind: 'claude-desktop', name: 'Claude Desktop' },
]

/** The steps that ask the person to do something (all but the welcome). */
export const ACTION_STEPS = SETUP_STEPS.filter((s) => s !== 'welcome')

/** What setup knows once everything has loaded. */
export interface SetupFacts {
  readonly providers: readonly ProviderStatus[]
  readonly adapter: AdapterDetail | null
  /** The adapter's pending review, if any. */
  readonly review: PendingReview | null
  readonly clients: readonly ClientInfo[]
  readonly endpoint: EndpointStatus
  readonly settings: Settings
}

export type StepsDone = Readonly<Record<SetupStep, boolean>>

/** The providers a login secret can come from: everything but Messages, which only has codes. */
export function vaultProviders(providers: readonly ProviderStatus[]): readonly ProviderStatus[] {
  return providers.filter((p) => p.kind !== 'messages')
}

/** The non-revoked client setup added for `kind`, by the name it gave it. */
export function setupClient(clients: readonly ClientInfo[], kind: ClientKind): ClientInfo | null {
  const name = SETUP_CLIENTS.find((c) => c.kind === kind)?.name
  return clients.find((c) => c.name === name && c.revokedAt === null) ?? null
}

/** Whether each step is done. Welcome is done once the person has done something in a later one. */
export function stepsDone(facts: SetupFacts): StepsDone {
  const adapter = facts.adapter
  const onepassword = vaultProviders(facts.providers).some((p) => p.available)
  const approve = adapter !== null && adapter.approval === 'approved'
  // Every secret, and the one-time codes when the adapter reads any: a login that needs a code it
  // may not read stops at the code page, so setup isn't done without that grant either.
  const grant =
    approve &&
    adapter.secretRequests.every((s) => s.grant !== null) &&
    (adapter.messages.length === 0 || adapter.messages.some((m) => m.grant !== null))
  // Every required setting (the store, D69): until it is chosen every tool ends needsUser. Its own
  // step (D-setup), so the login step isn't also the place a store hides.
  const store = approve && adapter.settings.every((s) => !s.required || s.chosen !== null)
  // Connected, not just added: copying a config isn't the client using it.
  const clients = facts.clients.some((c) => c.revokedAt === null && c.lastSeen !== null)
  // A provider can be ready before the person has done anything (set up outside the app, or demo
  // mode's test provider), so it alone doesn't skip the welcome.
  return { welcome: approve || grant || clients, onepassword, approve, grant, store, clients }
}

/** Where `#/setup` with no step lands: the first step not done, or the last if all are. */
export function resumeStep(done: StepsDone): SetupStep {
  return SETUP_STEPS.find((s) => !done[s]) ?? 'clients'
}

/** How many action steps are left: the "N" of "Finish setup (N steps left)". */
export function stepsLeft(done: StepsDone): number {
  return ACTION_STEPS.filter((s) => !done[s]).length
}

/** Loads the facts, refreshed as each part changes. */
export function useSetupFacts(): Loaded<SetupFacts> {
  const providers = useLoad((a) => a.grants.providers(), [], ['grants-changed', 'settings-changed'])
  const adapter = useLoad(
    (a) => a.adapters.get(SETUP_ADAPTER),
    [],
    ['adapters-changed', 'approvals-changed', 'grants-changed'],
  )
  const reviews = useLoad((a) => a.approvals.pending(), [], ['approvals-changed'])
  const clients = useLoad((a) => a.clients.list(), [], ['clients-changed'])
  const endpoint = useLoad((a) => a.endpoint.status(), [], ['endpoint-changed'])
  const settings = useLoad((a) => a.settings.get(), [], ['settings-changed'])
  const all = [providers, adapter, reviews, clients, endpoint, settings]
  if (all.some((l) => l.status === 'error')) return { status: 'error' }
  if (
    providers.status !== 'ready' ||
    adapter.status !== 'ready' ||
    reviews.status !== 'ready' ||
    clients.status !== 'ready' ||
    endpoint.status !== 'ready' ||
    settings.status !== 'ready'
  )
    return { status: 'loading' }
  return {
    status: 'ready',
    data: {
      providers: providers.data,
      adapter: adapter.data,
      review: reviews.data.find((r) => r.adapterId === SETUP_ADAPTER) ?? null,
      clients: clients.data,
      endpoint: endpoint.data,
      settings: settings.data,
    },
  }
}
