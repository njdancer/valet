// macOS notifications for core/notifications.ts. Each one is title and body only: no action buttons
// and no reply field, so the only thing a notification can do is open the window it is about.

import { Notification } from 'electron'
import type { AppNotification, NotificationTarget } from '../core/notifications'

export interface SystemNotifications {
  show(notification: AppNotification): void
  close(key: string): void
}

/**
 * `open` brings forward the window a clicked notification points at. With `off` (an e2e run, which
 * must not post to the machine's Notification Centre) nothing is shown.
 */
export function systemNotifications(
  open: (target: NotificationTarget) => void,
  off: boolean,
): SystemNotifications {
  // Held here so a notification isn't collected (and its click lost) while it is showing.
  const live = new Map<string, Notification>()
  const close = (key: string): void => {
    const notification = live.get(key)
    live.delete(key)
    notification?.close()
  }
  return {
    show(notification) {
      if (off || !Notification.isSupported()) return
      close(notification.key)
      const shown = new Notification({ title: notification.title, body: notification.body })
      shown.on('click', () => {
        if (live.get(notification.key) === shown) live.delete(notification.key)
        open(notification.target)
      })
      shown.on('close', () => {
        if (live.get(notification.key) === shown) live.delete(notification.key)
      })
      live.set(notification.key, shown)
      shown.show()
    },
    close,
  }
}
