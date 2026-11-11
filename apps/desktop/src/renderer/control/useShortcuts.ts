// The window's keyboard shortcuts (IA section 4, "App menu"): the six places on mod+1 to mod+6,
// the audit log on mod+shift+3, back and forward on mod+[ and mod+], the palette on mod+K, Pause on
// mod+shift+P. They work while the window is focused; nothing here is system-wide.

import { useEffect } from 'react'
import { useApi } from '../lib/api-context'
import { href, navigate } from '../lib/router'
import { PLACES } from './Sidebar'

function isMac(): boolean {
  return document.documentElement.dataset['platform'] === 'mac'
}

/** Whether the event has the platform's command key (⌘ on macOS, Ctrl elsewhere) and no other. */
function mod(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

export function shortcutTarget(e: KeyboardEvent): string | 'palette' | 'back' | 'forward' | 'pause' | null {
  if (!mod(e)) return null
  const key = e.key.toLowerCase()
  if (key === 'k' && !e.shiftKey && !e.altKey) return 'palette'
  if (key === '[' && !e.shiftKey) return 'back'
  if (key === ']' && !e.shiftKey) return 'forward'
  if (key === 'p' && e.shiftKey && !e.altKey) return 'pause'
  if (key === ',' && !e.shiftKey) return href.settings()
  // With shift, "3" arrives as "#" on many layouts; the code is layout-free.
  if (e.shiftKey && !e.altKey && e.code === 'Digit3') return href.audit()
  if (!e.shiftKey && !e.altKey && /^Digit[1-6]$/.test(e.code)) {
    const place = PLACES[Number(e.code.slice(5)) - 1]
    return place?.to ?? null
  }
  return null
}

export function useShortcuts(openPalette: () => void): void {
  const api = useApi()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = shortcutTarget(e)
      if (target === null) return
      e.preventDefault()
      if (target === 'palette') openPalette()
      else if (target === 'back') window.history.back()
      else if (target === 'forward') window.history.forward()
      else if (target === 'pause')
        void api.app
          .status()
          .then((s) => api.app.setPaused(!s.paused))
          .catch(() => undefined)
      else navigate(target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, openPalette])
}
