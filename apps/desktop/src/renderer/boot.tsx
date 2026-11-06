// Mounts a renderer page against the preload's API. In a plain browser (vite dev) there is no
// preload, so the in-memory fake stands in; without a preload a production bundle shows an error
// instead of an empty app.

import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { SiteAdapterApi } from '../shared/api'
import { ApiProvider } from './lib/api-context'

export type FakeLoader = () => Promise<SiteAdapterApi>

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

export async function resolveApi(win: Window, fake: FakeLoader | null): Promise<SiteAdapterApi | null> {
  if (win.siteadapter !== undefined) return win.siteadapter
  return fake === null ? null : fake()
}

export async function boot(
  page: ReactNode,
  root: HTMLElement,
  win: Window,
  fake: FakeLoader | null,
): Promise<void> {
  const api = await resolveApi(win, fake)
  createRoot(root).render(
    <StrictMode>
      {api === null ? (
        <div className="empty" role="alert">
          siteadapter couldn’t reach its main process. Quit and open it again.
        </div>
      ) : (
        <ApiProvider api={api}>{page}</ApiProvider>
      )}
    </StrictMode>,
  )
}
