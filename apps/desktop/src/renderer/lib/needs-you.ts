// One inbox (IA principle 1): every thing that waits for the person is a Needs you item, with the
// same title in the window, the menu bar, the notification and the tool result. This module turns
// an AttentionItem into what every surface shows: title, a line of context, its deadline, and the
// one action that answers it (IA section 5).

import type { AttentionItem, ValetApi } from '../../shared/api'
import { href } from './routes'
import { needsUserWording } from './wording'

/** What the item's main action does. A confirmation is never answered inline (only its window can). */
export type NeedsYouAction =
  | { readonly kind: 'open-confirmation'; readonly id: string }
  | { readonly kind: 'open-login'; readonly adapterId: string }
  | { readonly kind: 'route'; readonly to: `#/${string}` }

export interface NeedsYouView {
  readonly id: string
  readonly kind: AttentionItem['kind']
  readonly title: string
  readonly description: string | null
  readonly adapterId: string | null
  readonly adapterName: string | null
  readonly callId: string | null
  /** Epoch ms, or null for an item that waits as long as it takes. */
  readonly deadline: number | null
  readonly at: number
  readonly actionLabel: string
  readonly action: NeedsYouAction
  readonly tone: 'accent' | 'warning' | 'danger'
  /** Missed items stay a day, muted, with a follow-up action instead. */
  readonly missed: boolean
}

function time(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** "Log in to Woolworths (verification check)". */
export function loginTitle(adapterName: string, reasonShort: string): string {
  return `Log in to ${adapterName} (${reasonShort.toLowerCase()})`
}

export function confirmTitle(toolTitle: string, adapterName: string): string {
  return `Confirm: ${toolTitle} (${adapterName})`
}

export function reviewTitle(adapterName: string, version: string, firstInstall: boolean): string {
  return firstInstall
    ? `Review ${adapterName} before first use`
    : `Review the ${adapterName} update (${version})`
}

/**
 * The view of one item. Kinds this build doesn't know (a newer main process) still show, as a
 * generic item that opens Needs you, rather than vanishing.
 */
export function needsYouView(
  item: AttentionItem,
  firstInstall: (adapterId: string) => boolean,
): NeedsYouView {
  const base = {
    id: item.id,
    kind: item.kind,
    missed: false,
  }
  switch (item.kind) {
    case 'confirmation':
      return {
        ...base,
        title: confirmTitle(item.toolTitle, item.adapterName),
        description: null,
        adapterId: item.adapterId,
        adapterName: item.adapterName,
        callId: item.callId,
        deadline: time(item.expiresAt),
        at: time(item.requestedAt) ?? 0,
        actionLabel: 'Answer…',
        action: { kind: 'open-confirmation', id: item.id },
        tone: 'danger',
      }
    case 'needs-user': {
      const wording = needsUserWording(item.reason)
      return {
        ...base,
        title: loginTitle(item.adapterName, wording.short),
        description: wording.detail,
        adapterId: item.adapterId,
        adapterName: item.adapterName,
        callId: item.callId,
        deadline: time(item.closesAt),
        at: time(item.at) ?? 0,
        actionLabel: 'Show login window',
        action: { kind: 'open-login', adapterId: item.adapterId },
        tone: 'warning',
      }
    }
    case 'review': {
      const first = firstInstall(item.adapterId)
      return {
        ...base,
        title: reviewTitle(item.adapterName, item.version, first),
        description: item.addsPermissions
          ? 'It asks for more than the version you approved. Calls keep using the approved one until you decide.'
          : 'It asks for nothing new. Calls keep using the approved version until you decide.',
        adapterId: item.adapterId,
        adapterName: item.adapterName,
        callId: null,
        deadline: null,
        at: 0,
        actionLabel: first ? 'Review' : 'Review update',
        action: { kind: 'route', to: href.review(item.adapterId) },
        tone: 'accent',
      }
    }
    default: {
      const unknown = item as { readonly id: string; readonly kind: string }
      return {
        id: unknown.id,
        kind: unknown.kind as AttentionItem['kind'],
        missed: false,
        title: 'Something needs you',
        description: 'This version of the app doesn’t know how to show it. Update Valet to see it.',
        adapterId: null,
        adapterName: null,
        callId: null,
        deadline: null,
        at: 0,
        actionLabel: 'Open Valet',
        action: { kind: 'route', to: href.needsYou() },
        tone: 'accent',
      }
    }
  }
}

/** Soonest deadline first, then items without one by age (IA section 5); missed last. */
export function needsYouOrder(items: readonly NeedsYouView[]): NeedsYouView[] {
  return [...items].sort((a, b) => {
    if (a.missed !== b.missed) return a.missed ? 1 : -1
    if (a.deadline !== null && b.deadline !== null) return a.deadline - b.deadline
    if (a.deadline !== null) return -1
    if (b.deadline !== null) return 1
    return a.at - b.at
  })
}

/** Runs an item's main action. */
export async function runNeedsYouAction(
  api: ValetApi,
  action: NeedsYouAction,
  navigateTo: (to: `#/${string}`) => void,
): Promise<void> {
  switch (action.kind) {
    case 'open-confirmation':
      return api.openConfirmation(action.id)
    case 'open-login':
      return api.openLoginWindow(action.adapterId)
    case 'route':
      navigateTo(action.to)
  }
}
