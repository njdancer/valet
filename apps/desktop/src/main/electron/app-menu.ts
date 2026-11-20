// The menu bar Valet shows while it has a Dock icon (the control panel is open). Without one of its
// own, Electron's default menu would show, with a developer View menu and Help links to Electron.

import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export function appMenuTemplate(name: string, devTools: boolean): MenuItemConstructorOptions[] {
  return [
    {
      label: name,
      submenu: [
        { role: 'about', label: `About ${name}` },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${name}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${name}` },
      ],
    },
    // Copy and paste reach a page's fields only through these roles on macOS.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(devTools
          ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const)
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
}

export function setAppMenu(devTools: boolean): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.getName(), devTools)))
}
