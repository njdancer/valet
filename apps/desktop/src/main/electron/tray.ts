// The menu-bar icon. A click toggles the popover under the icon; a right-click shows a small menu,
// rebuilt on each click with popUpContextMenu (setContextMenu shows a stale menu on macOS).
//
// While remote access is on, the icon says so in its title, so it can't stay on unnoticed, and the
// menu carries the kill switch (relay.md, "Audit and the kill switch"), and, while any remote
// client is kept, "Revoke all remote clients…", which asks first. Pausing needs no network:
// it revokes every remote access token, fails remote calls in flight and closes the listener.

import { dialog, Menu, nativeImage, Tray } from 'electron'
import type { MainApi } from '../core/ipc'
import { remoteTrayState, type TrayRemote } from '../core/tray-remote'
import type { AppWindows } from './windows'

/** A ring with a dot, 36 px, drawn as a template image so macOS tints it for light and dark. */
const ICON_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAdUlEQVR42u2YUQoAIAhDu/+l6wqmU140wb8YD8qpreX4JHYwERAjcFuUKBgJVFVUCqUSk+h03H9as7NCUtp4oG4LkcJkH2z4/I1wxW/kQFUTNJCBDPRc2Y8ZI651uNs/OaAhR1jkkI9cg5CLInKVRn42OBBxAOibomxzt0qSAAAAAElFTkSuQmCC'

export interface AppTray {
  /** Re-reads remote access, for the icon's title and tooltip. */
  refresh(): void
}

export function createTray(windows: AppWindows, api: MainApi, demo: boolean, remote: TrayRemote): AppTray {
  const icon = nativeImage.createFromBuffer(Buffer.from(ICON_PNG, 'base64'), { scaleFactor: 2 })
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  const refresh = (): void => {
    const state = remoteTrayState(remote.status(), demo)
    tray.setToolTip(state.tooltip)
    tray.setTitle(state.title)
  }
  refresh()
  tray.on('click', () => windows.toggleTray(tray.getBounds()))
  tray.on('right-click', () => {
    void api.app.status().then((status) => {
      const state = remoteTrayState(remote.status(), demo)
      const menu = Menu.buildFromTemplate([
        { label: 'Open control panel', click: () => windows.openControlPanel(null) },
        {
          label: status.paused ? 'Resume adapters' : 'Pause all adapters',
          click: () => void api.app.setPaused(!status.paused),
        },
        ...(state.menuItem === null
          ? []
          : [
              {
                label: state.menuItem.label,
                click: () => void remote.setEnabled(state.menuItem?.enable ?? false).catch(() => undefined),
              },
            ]),
        ...(state.revokeAll
          ? [{ label: 'Revoke all remote clients…', click: () => void confirmRevokeAll(remote) }]
          : []),
        { type: 'separator' },
        { label: 'Quit Valet', click: () => void api.app.quit() },
      ])
      tray.popUpContextMenu(menu)
    })
  })
  return { refresh }
}

/** Asks first: every connector then has to be added again, with consent on the Mac. */
async function confirmRevokeAll(remote: TrayRemote): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Revoke all remote clients?',
    detail:
      'Every connector loses access now and has to be added again, with your approval on this Mac. To stop remote access for a while instead, pause it.',
    buttons: ['Cancel', 'Revoke all'],
    defaultId: 0,
    cancelId: 0,
  })
  if (response === 1) await remote.revokeAllClients().catch(() => undefined)
}
