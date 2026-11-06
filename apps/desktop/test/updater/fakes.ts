// Fakes for the updater tests: an autoUpdater that behaves like electron-updater's where the
// policy depends on it (the channel setter turning allowDowngrade on), and a manual clock.

import type { OutgoingHttpHeaders } from 'node:http'
import type { AutoUpdaterLike, UpdaterClock } from '../../src/main/updater'

type CheckResult = Awaited<ReturnType<AutoUpdaterLike['checkForUpdates']>>

/** What the updater had configured at the moment it asked the feed. */
export interface CheckSnapshot {
  readonly channel: string | null
  readonly allowDowngrade: boolean
  readonly allowPrerelease: boolean
  readonly autoDownload: boolean
  readonly autoInstallOnAppQuit: boolean
  readonly requestHeaders: OutgoingHttpHeaders | null
  readonly logger: unknown
}

export class FakeAutoUpdater implements AutoUpdaterLike {
  private currentChannel: string | null = null
  allowDowngrade = false
  allowPrerelease = false
  autoDownload = true
  autoInstallOnAppQuit = true
  logger: unknown = console
  requestHeaders: OutgoingHttpHeaders | null = null

  readonly feedUrls: Array<{ provider: 'generic'; url: string }> = []
  readonly checks: CheckSnapshot[] = []
  downloads = 0
  readonly quitAndInstallCalls: Array<[boolean | undefined, boolean | undefined]> = []
  private readonly listeners = new Map<string, Array<(arg: never) => void>>()

  /** What the next checkForUpdates() does. */
  onCheck: () => Promise<CheckResult> = async () => ({
    isUpdateAvailable: false,
    updateInfo: { version: '1.0.0' },
  })
  /** What the next downloadUpdate() does. */
  onDownload: () => Promise<unknown> = async () => []
  onQuitAndInstall: () => void = () => {}

  get channel(): string | null {
    return this.currentChannel
  }

  // As electron-updater's AppUpdater does: "allowDowngrade will be automatically set to true".
  set channel(value: string | null) {
    this.currentChannel = value
    this.allowDowngrade = true
  }

  setFeedURL(options: { provider: 'generic'; url: string }): void {
    this.feedUrls.push(options)
  }

  checkForUpdates(): Promise<CheckResult> {
    this.checks.push({
      channel: this.channel,
      allowDowngrade: this.allowDowngrade,
      allowPrerelease: this.allowPrerelease,
      autoDownload: this.autoDownload,
      autoInstallOnAppQuit: this.autoInstallOnAppQuit,
      requestHeaders: this.requestHeaders === null ? null : { ...this.requestHeaders },
      logger: this.logger,
    })
    return this.onCheck()
  }

  downloadUpdate(): Promise<unknown> {
    this.downloads++
    return this.onDownload()
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallCalls.push([isSilent, isForceRunAfter])
    this.onQuitAndInstall()
  }

  on(event: 'download-progress', listener: (info: { percent: number }) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: string, listener: (arg: never) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: 'download-progress' | 'error', arg: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) (listener as (arg: unknown) => void)(arg)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0
  }
}

/** A clock whose timers run only when the test advances it. */
export class ManualClock implements UpdaterClock {
  time = 1_700_000_000_000
  private nextId = 1
  readonly timers = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  /** Delays of the timers now pending, relative to now. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.at - this.time).sort((a, b) => a - b)
  }

  /** Moves time forward, running each timer that falls due, in order, and letting promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      const [id, timer] = due
      this.timers.delete(id)
      this.time = timer.at
      timer.callback()
      await flush()
    }
    this.time = end
    await flush()
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A promise the test resolves or rejects by hand. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** An error shaped like electron-updater's (builder-util-runtime's newError): a message and a code. */
export function codedError(
  code: string,
  message = `failed fetching https://updates.example/mac/latest-mac.yml?token=s3cret`,
) {
  return Object.assign(new Error(message), { code })
}
