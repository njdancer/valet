// The control panel: one window with a sidebar of six places (docs/ux/information-architecture.md),
// plus the chromeless routes the main process opens in windows of their own (the confirmation and
// the login hand-off banner), and first-run setup, which takes the whole window.
//
// The shell owns what every page shares: the sidebar, the title bar (back, forward, search, Pause and
// Lock down), the paused / locked-down strip, the command palette, the keyboard shortcuts, focus on
// the page heading after navigation, and redirecting old addresses to their new place.

import { AppShell } from '@valet/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { canonicalHref, type Route, useRoute } from '../lib/router'
import { ConfirmationWindow } from '../screens/windows/ConfirmationWindow'
import { LoginBannerWindow } from '../screens/windows/LoginBannerWindow'
import { SetupWindow } from '../screens/windows/SetupWindow'
import { MainView } from './MainView'
import { CommandMenu } from './Palette'
import { Sidebar } from './Sidebar'
import { TitleArea } from './TitleArea'
import { useShortcuts } from './useShortcuts'

export function ControlPanel() {
  const route = useRoute()
  useCanonicalAddress(route)
  return <RouteView route={route} />
}

/** An old address (#/adapters/…, #/audit, #/clients, #/remote, #/credentials) becomes the new one. */
function useCanonicalAddress(route: Route): void {
  useEffect(() => {
    const canonical = canonicalHref(route)
    if (canonical !== null && canonical !== window.location.hash && window.location.hash !== '') {
      window.history.replaceState(null, '', canonical)
    }
  }, [route])
}

export function RouteView({ route }: { readonly route: Route }) {
  switch (route.page) {
    case 'confirm':
      return <ConfirmationWindow confirmationId={route.confirmationId} />
    case 'needs-user':
      return <LoginBannerWindow adapterId={route.adapterId} />
    case 'setup':
      return <SetupWindow route={route} />
    default:
      return <Shell route={route} />
  }
}

function Shell({ route }: { readonly route: Route }) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  useShortcuts(openPalette)
  const main = useRef<HTMLDivElement>(null)
  useHeadingFocus(route, main)
  return (
    <>
      <AppShell sidebar={<Sidebar route={route} />}>
        <TitleArea onSearch={openPalette} />
        <div ref={main} className="flex min-h-0 flex-1 flex-col">
          <MainView route={route} />
        </div>
      </AppShell>
      <CommandMenu open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  )
}

/**
 * Every page takes focus on its heading after a navigation (IA principle 11), so a screen reader
 * hears where it landed and Tab starts from the top of the page. Not on first load: the window
 * opening shouldn't announce twice.
 */
function useHeadingFocus(route: Route, main: React.RefObject<HTMLDivElement | null>): void {
  const key = canonicalHref(route)?.split('?')[0] ?? route.page
  const first = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on each new address
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    // After the page has rendered its header.
    const id = requestAnimationFrame(() => {
      const heading = main.current?.querySelector<HTMLElement>('h1')
      if (heading === null || heading === undefined) return
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
      heading.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(id)
  }, [key, main])
}
