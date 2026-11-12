// System notifications for the moments Valet needs the person and they may be looking elsewhere: a
// confirmation waiting for a yes, a sign-in a call handed to them, a site that changed under its
// adapter, a connection request, something nobody answered in time, a site's breaker opening and
// a downloaded update. Plain data in and out, so it is tested without Electron.
//
// The title is the Needs you item's own title (@valet/core/vocabulary), the same words the window,
// the menu bar and the tool result use; the body is the site and the deadline as a clock time
// (docs/ux/information-architecture.md, section 4). When an item runs out unanswered, its
// notification is replaced by "Missed: …" under the same key.
//
// A notification only ever opens what it is about (D52's recommendation): it has no action
// buttons, so nothing can be approved from the notification, the lock screen or a Focus summary.
// Its text is the app's own wording plus names the person approved with the adapter (its name, a
// tool's or a setting's title) and the site's host. A client's reported name, an adapter's notes and
// confirm() messages, and anything from a page never appear.

import { clockTime, needsYouTitle, plainName, siteLimitingLabel } from '@valet/core'
import { href } from '../../renderer/lib/routes'
import type { AttentionItem, HashRoute } from '../../shared/api'

export { plainName }

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
  /** For clock times; the machine's own zone when absent. Tests pass one. */
  readonly timeZone?: string
}

/** The title an item has everywhere (Needs you, the menu bar, the notification, the tool result). */
export function attentionTitle(item: AttentionItem): string {
  switch (item.kind) {
    case 'confirmation':
      return needsYouTitle({ kind: 'confirmation', adapterName: item.adapterName, toolTitle: item.toolTitle })
    case 'needs-user':
      return needsYouTitle({ kind: 'needs-user', adapterName: item.adapterName, reason: item.reason })
    case 'review':
      return needsYouTitle({
        kind: 'review',
        adapterName: item.adapterName,
        version: item.version,
        ...(item.firstInstall === undefined ? {} : { firstInstall: item.firstInstall }),
      })
    case 'remote-consent':
      return needsYouTitle({ kind: 'remote-consent' })
    case 'setting-missing':
      return needsYouTitle({
        kind: 'setting-missing',
        adapterName: item.adapterName,
        settingTitle: item.settingTitle,
      })
    case 'login-missing':
      return needsYouTitle({ kind: 'login-missing', adapterName: item.adapterName })
    case 'repair':
      return needsYouTitle({ kind: 'repair', adapterName: item.adapterName })
    case 'missed':
      return item.title
  }
}

/** Where a click on an item (in a notification, the menu bar or Needs you) takes the person. */
export function attentionTarget(item: AttentionItem): NotificationTarget {
  switch (item.kind) {
    case 'confirmation':
      return { kind: 'confirmation', id: item.id }
    case 'needs-user':
      return { kind: 'needs-user', adapterId: item.adapterId }
    case 'review':
      return { kind: 'panel', route: href.review(item.adapterId) }
    case 'remote-consent':
      return { kind: 'panel', route: href.approveConnection() }
    case 'setting-missing':
      return { kind: 'panel', route: href.setting(item.adapterId, item.setting) }
    case 'login-missing':
      return { kind: 'panel', route: href.grant(item.adapterId, item.secret) }
    case 'repair':
      return { kind: 'panel', route: href.call(item.callId) }
    case 'missed':
      return { kind: 'panel', route: href.needsYou(item.id) }
  }
}

/**
 * The key an item's notification goes under. A missed item takes its original's key, so its
 * notification replaces the original's; a later hand-off for the same site is a new one.
 */
function keyOf(item: AttentionItem): string | null {
  switch (item.kind) {
    case 'confirmation':
      return `confirmation:${item.id}`
    case 'needs-user':
      return `needs-user:${item.adapterId}:${item.at}`
    case 'repair':
      return `repair:${item.adapterId}:${item.callId}`
    case 'missed':
      if (item.of === 'confirmation') return `confirmation:${item.originalId}`
      if (item.of === 'needs-user') return `needs-user:${item.adapterId ?? ''}:${item.at}`
      return null
    default:
      return null
  }
}

/**
 * The notification for something waiting on the person, or null for what gets none: a login
 * window the person opened themselves (it is already in front of them), a review, a missing
 * setting or login (all found at launch or in setup, with the window open on them), connection
 * requests (one notification covers them all: Notifier.remoteConsent), and a missed request.
 */
export function attentionNotification(item: AttentionItem, timeZone?: string): AppNotification | null {
  const key = keyOf(item)
  if (key === null) return null
  const title = attentionTitle(item)
  const target = attentionTarget(item)
  switch (item.kind) {
    case 'confirmation':
      return {
        key,
        title,
        body: `${plainName(item.adapterName)} · answer by ${clockTime(item.expiresAt, timeZone)}`,
        target,
      }
    case 'needs-user':
      if (item.startedBy !== 'call') return null
      return {
        key,
        title,
        body:
          item.closesAt === null
            ? `${plainName(item.adapterName)} · login window open`
            : `${plainName(item.adapterName)} · login window open until ${clockTime(item.closesAt, timeZone)}`,
        target,
      }
    case 'repair':
      return { key, title, body: `${plainName(item.adapterName)} · see what broke`, target }
    case 'missed':
      return {
        key,
        title,
        body: `${item.adapterName === null ? 'Valet' : plainName(item.adapterName)} · nobody answered by ${clockTime(item.missedAt, timeZone)}`,
        target,
      }
    default:
      return null
  }
}

export class Notifier {
  /** Attention items already handled: what went up under each key (null: nothing did). */
  private readonly attention_ = new Map<string, string | null>()
  /** Every key showing, so quitting can take them down. */
  private readonly showing = new Set<string>()

  constructor(private readonly options: NotifierOptions) {}

  /**
   * Everything waiting on the person now. Each new item is notified once; one that is over has its
   * notification taken down; one whose title changed under the same key (it was missed) is
   * replaced. An item that arrived while notifications were off stays quiet if they are turned on
   * later: by then it is old news with its own window.
   */
  attention(items: readonly AttentionItem[]): void {
    const current = new Map<string, AppNotification>()
    for (const item of items) {
      const notification = attentionNotification(item, this.options.timeZone)
      if (notification !== null) current.set(notification.key, notification)
    }
    for (const key of [...this.attention_.keys()]) {
      if (current.has(key)) continue
      this.attention_.delete(key)
      this.takeDown(key)
    }
    for (const [key, notification] of current) {
      if (!this.attention_.has(key)) {
        this.attention_.set(key, this.put(notification) ? notification.title : null)
        continue
      }
      const shown = this.attention_.get(key)
      // Replaced only when something went up for it: a missed item doesn't surface one that never
      // showed (notifications were off when it arrived).
      if (shown !== null && shown !== undefined && shown !== notification.title) {
        this.attention_.set(key, this.put(notification) ? notification.title : null)
      }
    }
  }

  /** A site's breaker opened: calls to it are refused until `retryAt`. `name` is the site's, if known. */
  breakerOpened(
    host: string,
    cause: 'blocked-by-site' | 'rate-limited',
    retryAt: string,
    name?: string,
  ): void {
    const site = plainName(name ?? host)
    const at = Date.parse(retryAt)
    const future = Number.isFinite(at) && at > this.options.now()
    this.put({
      key: `breaker:${host}`,
      title: future ? siteLimitingLabel(site, at, this.options.timeZone) : `${site} is limiting requests`,
      body:
        cause === 'rate-limited' ? 'The site said Valet was asking too often.' : 'The site refused Valet.',
      target: { kind: 'panel', route: href.sites() },
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
      target: { kind: 'panel', route: href.settings('updates') },
    })
  }

  /**
   * Cloud agents waiting for consent on the Mac: one notification for all of them (relay.md: a
   * flood must not bury the screen), taken down once none is waiting. It says nothing a client
   * chose: not its name, not even its host. `expiresAt` is the soonest request's end.
   */
  remoteConsent(pending: number, expiresAt?: string): void {
    if (pending === 0) {
      this.takeDown('remote-consent')
      return
    }
    const ends =
      expiresAt === undefined || !Number.isFinite(Date.parse(expiresAt))
        ? ''
        : ` · ends ${clockTime(expiresAt, this.options.timeZone)}`
    this.put({
      key: 'remote-consent',
      title: pending === 1 ? needsYouTitle({ kind: 'remote-consent' }) : `Approve ${pending} connections`,
      body: `Type the code your browser shows${ends}. If you didn’t just add a connector, decline it.`,
      target: { kind: 'panel', route: href.approveConnection() },
    })
  }

  /**
   * An agent started or submitted a draft adapter (the Notify tier, docs/authoring-tools.md). The
   * text is the app's own fixed wording with the client's name; nothing the agent wrote.
   */
  draftActivity(text: string): void {
    this.put({
      key: 'draft',
      title: 'An agent is writing an adapter',
      body: text,
      target: { kind: 'panel', route: href.audit() },
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
