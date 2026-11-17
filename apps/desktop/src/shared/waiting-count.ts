// How many things wait for the person: the number on the menu bar and beside Needs you. Missed items
// don't count. Agents asking to connect are one thing to do (one sheet, where the code picks the
// request), so however many are asking they count once, as Needs you shows them.

import type { AttentionItem } from './api'

export function waitingCount(items: readonly Pick<AttentionItem, 'kind'>[]): number {
  let count = 0
  let consent = false
  for (const item of items) {
    if (item.kind === 'missed') continue
    if (item.kind === 'remote-consent') consent = true
    else count += 1
  }
  return count + (consent ? 1 : 0)
}
