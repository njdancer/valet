// The menu-bar icon. A click toggles the popover under the icon; a right-click shows a small menu,
// rebuilt on each click with popUpContextMenu (setContextMenu shows a stale menu on macOS).

// Electron glue: covered by the smoke test (test/smoke) and the e2e suite, not by unit tests.
/* v8 ignore start */

import { Menu, nativeImage, Tray } from 'electron'
import type { MainApi } from '../core/ipc'
import type { AppWindows } from './windows'

/** A ring with a dot, 36 px, drawn as a template image so macOS tints it for light and dark. */
const ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAdUlEQVR42u2YUQoAIAhDu/+l6wqmU140wb8YD8qpreX4JHYwERAjcFuUKBgJVFVUCqUSk+h03H9as7NCUtp4oG4LkcJkH2z4/I1wxW/kQFUTNJCBDPRc2Y8ZI651uNs/OaAhR1jkkI9cg5CLInKVRn42OBBxAOibomxzt0qSAAAAAElFTkSuQmCC'

export function createTray(windows: AppWindows, api: MainApi, demo: boolean): Tray {
  const icon = nativeImage.createFromBuffer(Buffer.from(ICON_PNG, 'base64'), { scaleFactor: 2 })
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  tray.setToolTip(demo ? 'siteadapter (demo)' : 'siteadapter')
  if (demo) tray.setTitle('DEMO')
  tray.on('click', () => windows.toggleTray(tray.getBounds()))
  tray.on('right-click', () => {
    void api.app.status().then((status) => {
      const menu = Menu.buildFromTemplate([
        { label: 'Open control panel', click: () => windows.openControlPanel(null) },
        {
          label: status.paused ? 'Resume adapters' : 'Pause all adapters',
          click: () => void api.app.setPaused(!status.paused),
        },
        { type: 'separator' },
        { label: 'Quit siteadapter', click: () => void api.app.quit() },
      ])
      tray.popUpContextMenu(menu)
    })
  })
  return tray
}
/* v8 ignore stop */
