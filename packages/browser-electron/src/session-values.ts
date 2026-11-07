// Every value a session cookie or a handed-off storage key has held in the tool partition, for
// output redaction. A snapshot isn't enough: tool code can read a value (document.cookie,
// localStorage) and then overwrite or expire it before the runtime asks, and the site may rotate
// one mid-run. So the driver records each value as it appears: what the handoff copied, every
// cookie change event (which carries the old value of a removed or overwritten cookie), and every
// storage write to a key it was asked to hand off or redact.

import { hostAllowed } from '@valet/core'
import { cookieHost } from './cookies'
import type { CookieRecord, StorageValue } from './platform'

/** Values kept per cookie or storage key, newest last. Older ones are dropped first. */
const VALUES_PER_NAME = 16
/** Cookie names kept, so a site that sets endless distinct names can't grow this without bound. */
const MAX_COOKIE_NAMES = 2000

export class SessionValues {
  private readonly cookies = new Map<string, { readonly host: string; readonly values: string[] }>()
  private readonly storage = new Map<string, string[]>()
  private readonly watched = new Set<string>()

  /** Records a cookie's value, whatever happened to it. */
  cookie(cookie: CookieRecord): void {
    const host = cookieHost(cookie)
    if (host === null || cookie.value.length === 0) return
    const name = `${host}\n${cookie.name}`
    let entry = this.cookies.get(name)
    if (entry === undefined) {
      if (this.cookies.size >= MAX_COOKIE_NAMES) {
        const oldest = this.cookies.keys().next().value
        if (oldest !== undefined) this.cookies.delete(oldest)
      }
      entry = { host, values: [] }
      this.cookies.set(name, entry)
    }
    remember(entry.values, cookie.value)
  }

  /** Every value recorded for a cookie on `cookieDomains`. */
  cookieValues(cookieDomains: readonly string[]): string[] {
    const values: string[] = []
    for (const { host, values: held } of this.cookies.values()) {
      if (hostAllowed(host, cookieDomains)) values.push(...held)
    }
    return values
  }

  /** From now on, storage writes to these keys on `origin` are recorded. */
  watch(origin: string, keys: readonly string[]): void {
    for (const key of keys) this.watched.add(`${origin}\n${key}`)
  }

  watchedKeys(origin: string): string[] {
    const prefix = `${origin}\n`
    return [...this.watched]
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
  }

  /** Records a storage write the page made, if its key is watched. */
  storageValue({ origin, key, value }: StorageValue): void {
    if (this.watched.has(`${origin}\n${key}`)) this.rememberStorage(origin, key, value)
  }

  /** Records a value for a storage key, watched or not: the handoff's own writes. */
  rememberStorage(origin: string, key: string, value: string): void {
    if (value.length === 0) return
    const name = `${origin}\n${key}`
    this.watched.add(name)
    let values = this.storage.get(name)
    if (values === undefined) {
      values = []
      this.storage.set(name, values)
    }
    remember(values, value)
  }

  storageValues(origin: string, keys: readonly string[]): string[] {
    return keys.flatMap((key) => this.storage.get(`${origin}\n${key}`) ?? [])
  }
}

function remember(values: string[], value: string): void {
  const index = values.indexOf(value)
  if (index >= 0) values.splice(index, 1)
  values.push(value)
  if (values.length > VALUES_PER_NAME) values.shift()
}
