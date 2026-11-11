// Rendering helpers for the Connections, Secrets and Settings tests: the providers the app's root
// gives every page, the browser APIs jsdom lacks that Radix reaches for, and the fake's call log.

import { render } from '@testing-library/react'
import { Toaster, TooltipProvider, toast } from '@valet/ui'
import type { ReactNode } from 'react'
import { afterEach } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import type { FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { ValetApi } from '../src/shared/api'

export const NOW = Date.parse('2026-11-07T21:48:00+11:00')

if (typeof window !== 'undefined') {
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver ??= ResizeObserver as unknown as typeof window.ResizeObserver
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// Toasts live in a module-level store: one test's Undo must not show up in the next.
afterEach(() => {
  toast.dismiss()
})

export function renderPage(api: ValetApi, page: ReactNode) {
  return render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TooltipProvider>
        {page}
        <Toaster />
      </TooltipProvider>
    </ApiProvider>,
  )
}

/** The whole control panel at a route, as the window shows it. */
export function renderAt(hash: string, api: ValetApi) {
  window.location.hash = hash
  return renderPage(api, <ControlPanel />)
}

export function called(api: FakeApi, method: string): (readonly unknown[])[] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => c.args)
}
