// Mounts a renderer page against the preload's API. In a plain browser (vite dev) there is no
// preload, so the in-memory fake stands in; a production bundle never loads the fake, and without a
// preload shows an error instead of an empty app.

import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { SiteAdapterApi } from '../shared/api'
import { ApiProvider } from './lib/api-context'

export async function resolveApi(win: Window, dev: boolean): Promise<SiteAdapterApi | null> {
  if (win.siteadapter !== undefined) return win.siteadapter
  if (!dev) return null
  const { createFakeApi } = await import('./dev/fake-api')
  return createFakeApi()
}

export async function boot(page: ReactNode, root: HTMLElement, win: Window, dev: boolean): Promise<void> {
  const api = await resolveApi(win, dev)
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
