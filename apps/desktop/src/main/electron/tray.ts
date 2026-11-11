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
  /** Re-reads remote access and the Needs you count, for the icon's title and tooltip. */
  refresh(): void
}

export function createTray(windows: AppWindows, api: MainApi, demo: boolean, remote: TrayRemote): AppTray {
  const icon = nativeImage.createFromBuffer(Buffer.from(ICON_PNG, 'base64'), { scaleFactor: 2 })
  icon.setTemplateImage(true)
  const tray = new Tray(icon)
  let needsYou = 0
  const show = (): void => {
    const state = remoteTrayState(remote.status(), demo, needsYou)
    tray.setToolTip(state.tooltip)
    tray.setTitle(state.title)
  }
  const refresh = (): void => {
    show()
    void api.attention
      .list()
      .then((items) => {
        needsYou = items.filter((i) => i.kind !== 'missed').length
        show()
      })
      .catch(() => undefined)
  }
  refresh()
  tray.on('click', () => windows.toggleTray(tray.getBounds()))
  tray.on('right-click', () => {
    void api.app.status().then((status) => {
      const state = remoteTrayState(remote.status(), demo)
      const menu = Menu.buildFromTemplate([
        { label: 'Open control panel', click: () => windows.openControlPanel(null) },
        {
          label: status.paused ? 'Resume Valet' : 'Pause Valet',
          enabled: !status.lockedDown,
          click: () => void api.app.setPaused(!status.paused),
        },
        // The second kill switch (IA 2.10): unlocking asks first, as locking can't be undone for
        // the cloud agents it removed.
        status.lockedDown
          ? { label: 'Unlock Valet…', click: () => void confirmUnlock(api) }
          : { label: 'Lock down…', click: () => void confirmLockDown(api) },
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

/** Asks first, and says up front what can't be undone. */
async function confirmLockDown(api: MainApi): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Lock down Valet?',
    detail:
      'Every call is refused until you unlock, and agents are told why. Cloud agents are removed now and have to be approved again; unlocking doesn’t bring them back.',
    buttons: ['Cancel', 'Lock down'],
    defaultId: 0,
    cancelId: 0,
  })
  if (response === 1) await api.app.setLockedDown(true).catch(() => undefined)
}

async function confirmUnlock(api: MainApi): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: 'Unlock Valet?',
    detail: 'Calls go through again. Cloud agents that were removed stay removed.',
    buttons: ['Cancel', 'Unlock'],
    defaultId: 0,
    cancelId: 0,
  })
  if (response === 1) await api.app.setLockedDown(false).catch(() => undefined)
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
