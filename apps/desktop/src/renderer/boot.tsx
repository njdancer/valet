// Mounts a renderer page against the preload's API. In a plain browser (vite dev) there is no
// preload, so the in-memory fake stands in; without a preload a production bundle shows an error
// instead of an empty app.
//
// Every page sits inside the design system's providers (tooltips, toasts, the glass filter), and
// <html> carries what the stylesheet needs to know about the window: data-platform picks the
// floating material (Liquid Glass on macOS, frost elsewhere), data-frame="inset" leaves room for
// macOS's traffic lights, data-vibrancy says the window itself is translucent.

import { applyPlatform, detectPlatform, GlassFilter, Toaster } from '@valet/ui'
import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ValetApi, WindowChrome } from '../shared/api'
import { ApiProvider } from './lib/api-context'

export type FakeLoader = () => Promise<ValetApi>

/**
 * The dev fake, or null in a production build. The condition is the compile-time constant at the
 * import site, so a build drops the import and never emits the fake's chunk (test/build.test.ts).
 */
export const devFake: FakeLoader | null = import.meta.env.DEV
  ? async () => {
      const { createFakeApi } = await import('./dev/fake-api')
      return createFakeApi()
    }
  : null

export async function resolveApi(win: Window, fake: FakeLoader | null): Promise<ValetApi | null> {
  if (win.valet !== undefined) return win.valet
  return fake === null ? null : fake()
}

/**
 * Marks <html> for the stylesheet. The preload's answer (from the main process's process.platform
 * and how it made the window) wins; a plain browser falls back to the user agent and a framed,
 * opaque window.
 */
export function applyChrome(root: HTMLElement, win: Window): void {
  const chrome: WindowChrome | undefined = win.valetChrome
  applyPlatform(root, chrome?.platform ?? detectPlatform(win.navigator?.userAgent ?? ''))
  if (chrome?.frame === 'inset') root.dataset['frame'] = 'inset'
  else delete root.dataset['frame']
  if (chrome?.vibrancy) root.dataset['vibrancy'] = chrome.vibrancy
  else delete root.dataset['vibrancy']
}

export async function boot(
  page: ReactNode,
  root: HTMLElement,
  win: Window,
  fake: FakeLoader | null,
): Promise<void> {
  applyChrome(document.documentElement, win)
  const api = await resolveApi(win, fake)
  createRoot(root).render(
    <StrictMode>
      {api === null ? (
        <div role="alert" className="flex h-full items-center justify-center p-6 text-md text-fg-muted">
          Valet couldn’t reach its main process. Quit and open it again.
        </div>
      ) : (
        <ApiProvider api={api}>{page}</ApiProvider>
      )}
      <Toaster />
      <GlassFilter />
    </StrictMode>,
  )
}
