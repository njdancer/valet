// The tier of every action an agent can take on Valet through its own MCP tools (D74, workstream
// E). The Mac looks the tier up here from the action it is about to do; the agent can't choose or
// lower it. Anything not in this table is refused.
//
// - none: done at once, audited.
// - notify: done at once, audited, and the person is told on the Mac and phone.
// - approve: an ApprovalRequest of the named kind; nothing happens until a device signs it.
// - approve-each-use: as approve, never remembered (only irreversible tool calls).
//
// The rule behind the table: reading, and anything that only makes Valet stricter, runs; anything
// that widens what an adapter, a client or an agent can reach waits for the person.

import type { ApprovalKind, ApprovalTier } from './approvals'

export type AdminTier =
  | { readonly tier: 'none' }
  | { readonly tier: 'notify' }
  | { readonly tier: 'approve' | 'approve-each-use'; readonly kind: ApprovalKind }

const none = { tier: 'none' } as const
const notify = { tier: 'notify' } as const
const approve = (kind: ApprovalKind) => ({ tier: 'approve', kind }) as const

export const ADMIN_ACTION_TIERS = {
  // Reading Valet's state. Results mark page and adapter text as data.
  'status.read': none,
  'adapters.read': none,
  'tools.read': none,
  'health.read': none,
  'repairs.read': none,
  'calls.read': none,
  'traces.read': none,
  'audit.read': none,
  'settings.read': none,
  'devices.read': none,
  // Authoring in the anonymous scratch browser and the draft workspace (workstream F).
  'scratch.browse': none,
  'draft.create': notify,
  'draft.edit': none,
  'draft.build': none,
  'draft.test': none,
  'draft.trial': notify,
  'draft.delete': none,
  'draft.submit': approve('adapter-install'),
  'authoring.signed-in-session': approve('authoring-session'),
  'authoring.private-network': approve('private-network'),
  // Adapters and tools.
  'adapter.rollback': approve('adapter-install'),
  'adapter.remove': notify,
  'tool.disable': notify,
  'tool.enable': approve('tool-enable'),
  'tool.remote-enable': approve('tool-enable'),
  'tool.remote-disable': notify,
  // Secrets. An agent can ask for a grant; it can never see or choose the item's contents.
  'secret.request-grant': approve('secret-grant'),
  'secret.revoke': notify,
  // Settings. The Mac classifies each change; an adapter's own settings (D69, the store) only
  // choose between values the adapter already declared, so they are tightening-neutral.
  'setting.tighten': notify,
  'setting.adapter-choice': notify,
  'setting.loosen': approve('setting'),
  // Remote clients and safety switches (J7).
  'client.revoke': notify,
  'remote.pause': notify,
  'valet.lockdown': notify,
  'device.revoke': notify,
} as const satisfies Record<string, AdminTier>

export type AdminAction = keyof typeof ADMIN_ACTION_TIERS

/**
 * Actions no MCP tool may offer at all, at any tier: pairing a device (the person scans a QR
 * code at the Mac), answering an approval, anything that reads a secret's value, and lifting a
 * pause or lockdown (only the person at the Mac, J7; an agent never even asks).
 */
export const NEVER_OVER_MCP = ['device.pair', 'approval.answer', 'secret.read', 'valet.resume'] as const

export function adminTier(action: string): AdminTier | null {
  return Object.hasOwn(ADMIN_ACTION_TIERS, action) ? ADMIN_ACTION_TIERS[action as AdminAction] : null
}

/** True if the tier means the action happens without a device's signature. */
export function runsWithoutApproval(tier: ApprovalTier): boolean {
  return tier === 'none' || tier === 'notify'
}
