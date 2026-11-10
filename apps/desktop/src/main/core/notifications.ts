// System notifications for the moments Valet needs the person and they may be looking elsewhere: a
// confirmation waiting for a yes, a sign-in a call handed to them, a site's breaker opening, and a
// downloaded update. Plain data in and out, so it is tested without Electron.
//
// A notification only ever opens a window of the app (D52's recommendation): it has no action
// buttons, so nothing can be approved from the notification, the lock screen or a Focus summary.
// Its text is the app's own wording plus names the person already approved (the adapter's name, the
// site's host). An adapter's tool titles, notes and confirm() messages, a client's reported name and
// anything from a page never appear: a notification is shown outside the app, where nothing
// attributes text to the adapter.

import type { AttentionItem, HashRoute } from '../../shared/api'

/** What a click on the notification opens. Never an action. */
export type NotificationTarget =
  | { readonly kind: 'confirmation'; readonly id: string }
  | { readonly kind: 'needs-user'; readonly adapterId: string }
  | { readonly kind: 'panel'; readonly route: HashRoute }

export interface AppNotification {
  /** Stable for the thing it is about: showing the same key again replaces the earlier one. */
  readonly key: string
  readonly title: string
  readonly body: string
  readonly target: NotificationTarget
}

export interface NotifierOptions {
  /** The person's setting, read each time. */
  readonly enabled: () => boolean
  readonly show: (notification: AppNotification) => void
  /** Takes a notification down once what it was about is over. */
  readonly close: (key: string) => void
  readonly now: () => number
}

const MAX_NAME = 60

/** A name for a notification: one line, no control or formatting characters, bounded. */
export function plainName(text: string): string {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > MAX_NAME ? `${plain.slice(0, MAX_NAME - 1)}…` : plain
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.ceil(ms / 60_000))
  return count === 1 ? '1 minute' : `${count} minutes`
}

/** The notification for something waiting on the person, or null for what gets none. */
export function attentionNotification(item: AttentionItem): AppNotification | null {
  switch (item.kind) {
    case 'confirmation': {
      const wait = Date.parse(item.expiresAt) - Date.parse(item.requestedAt)
      return {
        key: `confirmation:${item.id}`,
        title: 'Valet needs your approval',
        body: `${plainName(item.adapterName)}: an agent asked for something that needs your yes. Unanswered, it is declined in ${minutes(wait)}.`,
        target: { kind: 'confirmation', id: item.id },
      }
    }
    case 'needs-user': {
      // A window the person opened themselves is already in front of them.
      if (item.startedBy !== 'call') return null
      const open = item.closesAt === null ? null : Date.parse(item.closesAt) - Date.parse(item.at)
      return {
        key: `needs-user:${item.adapterId}:${item.at}`,
        title: 'Valet needs you to sign in',
        body: `${plainName(item.adapterName)}: signing in stopped and is waiting for you.${
          open === null ? '' : ` The window closes in ${minutes(open)}.`
        }`,
        target: { kind: 'needs-user', adapterId: item.adapterId },
      }
    }
    case 'review':
      // A bundle waiting for review is found at launch, when the control panel opens on it anyway.
      return null
  }
}

export class Notifier {
  /** Attention items already handled, and whether a notification went up for each. */
  private readonly attention_ = new Map<string, boolean>()
  /** Every key showing, so quitting can take them down. */
  private readonly showing = new Set<string>()

  constructor(private readonly options: NotifierOptions) {}

  /**
   * Everything waiting on the person now. Each new item is notified once; one that is over has its
   * notification taken down. An item that arrived while notifications were off stays quiet if they
   * are turned on later: by then it is old news with its own window.
   */
  attention(items: readonly AttentionItem[]): void {
    const current = new Map<string, AppNotification>()
    for (const item of items) {
      const notification = attentionNotification(item)
      if (notification !== null) current.set(notification.key, notification)
    }
    for (const key of [...this.attention_.keys()]) {
      if (current.has(key)) continue
      this.attention_.delete(key)
      this.takeDown(key)
    }
    for (const [key, notification] of current) {
      if (this.attention_.has(key)) continue
      this.attention_.set(key, this.put(notification))
    }
  }

  /** A site's breaker opened: calls to it are refused until `retryAt`. */
  breakerOpened(host: string, cause: 'blocked-by-site' | 'rate-limited', retryAt: string): void {
    const site = plainName(host)
    const wait = Date.parse(retryAt) - this.options.now()
    this.put({
      key: `breaker:${host}`,
      title: `Valet stopped calling ${site}`,
      body: `${
        cause === 'rate-limited' ? 'The site said Valet was asking too often.' : 'The site refused Valet.'
      }${Number.isFinite(wait) && wait > 0 ? ` Calls to it wait ${minutes(wait)}.` : ' Calls to it wait.'}`,
      target: { kind: 'panel', route: '#/adapters' },
    })
  }

  breakerClosed(host: string): void {
    this.takeDown(`breaker:${host}`)
  }

  /** A verified update finished downloading. */
  updateDownloaded(version: string, installsOnQuit: boolean): void {
    this.put({
      key: 'update',
      title: `Valet ${plainName(version)} is downloaded`,
      body: installsOnQuit
        ? 'It installs when Valet quits.'
        : 'Turn on automatic installs in Settings to apply it.',
      target: { kind: 'panel', route: '#/settings' },
    })
  }

  /**
   * Remote connectors waiting for consent on the Mac: one notification for all of them, taken down
   * once none is waiting. It says nothing a client chose: not its name, not even its host.
   */
  remoteConsent(pending: number): void {
    if (pending === 0) return this.takeDown('remote-consent')
    this.put({
      key: 'remote-consent',
      title:
        pending === 1 ? 'A connector wants access to Valet' : `${pending} connectors want access to Valet`,
      body: 'Type the code your browser shows. If you didn’t just add a connector, decline it.',
      target: { kind: 'panel', route: '#/remote' },
    })
  }

  /** Takes everything down, when the app stops. */
  clear(): void {
    this.attention_.clear()
    for (const key of [...this.showing]) this.takeDown(key)
  }

  private put(notification: AppNotification): boolean {
    if (!this.options.enabled()) return false
    this.showing.add(notification.key)
    try {
      this.options.show(notification)
    } catch {
      // A notification is a courtesy: the window it points at is up either way.
    }
    return true
  }

  private takeDown(key: string): void {
    if (!this.showing.delete(key)) return
    try {
      this.options.close(key)
    } catch {
      // As above.
    }
  }
}
