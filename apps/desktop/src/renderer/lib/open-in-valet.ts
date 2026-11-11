// The windows outside the control panel (the menu bar popover, the confirmation, the login hand-off
// banner) show links to Valet's pages: a site, a call, an app. Followed in place, such a link would
// load that page inside the small window. So a click on any in-app link there goes to the main
// process instead, which opens the page in the control panel; a confirmation or a login hand-off
// opens its own window, the only place either can be answered.

import type { MouseEvent } from 'react'
import type { HashRoute, ValetApi } from '../../shared/api'
import type { NeedsYouView } from './needs-you'
import { href, parseRoute } from './routes'

/** Opens `to` where it belongs: its own window for a confirmation or a login, else the control panel. */
export function openRoute(api: ValetApi, to: HashRoute): Promise<void> {
  const route = parseRoute(to)
  if (route.page === 'confirm') return api.openConfirmation(route.confirmationId)
  if (route.page === 'needs-user') return api.openLoginWindow(route.adapterId)
  return api.app.openControlPanel(to)
}

/** The in-app route an ordinary click is following, or null for anything else. */
export function followedRoute(event: MouseEvent): HashRoute | null {
  if (event.defaultPrevented || event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null
  const target = event.target as Element | null
  const link = target?.closest?.('a[href]')
  const to = link?.getAttribute('href') ?? null
  return to !== null && to.startsWith('#/') ? (to as HashRoute) : null
}

/**
 * An onClick for a window's root: in-app links open in Valet. `onResult` hears whether it worked,
 * so the window can say when the main process refused.
 */
export function linksOpenInValet(
  api: ValetApi,
  onResult?: (ok: boolean) => void,
): (event: MouseEvent) => void {
  return (event) => {
    const to = followedRoute(event)
    if (to === null) return
    event.preventDefault()
    openRoute(api, to).then(
      () => onResult?.(true),
      () => onResult?.(false),
    )
  }
}

/** Where a Needs you item's main action goes, as an in-app link: its own window, or a page. */
export function needsYouHref(view: NeedsYouView): HashRoute {
  switch (view.action.kind) {
    case 'open-confirmation':
      return href.confirm(view.action.id)
    case 'open-login':
      return href.needsUser(view.action.adapterId)
    case 'route':
      return view.action.to
  }
}
