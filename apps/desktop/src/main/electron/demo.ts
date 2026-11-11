// Demo mode's local Woolworths: the fake site in-process over TLS, on www.woolworths.test and
// auth.woolworths.test (mapped to 127.0.0.1 by a host resolver rule set before ready). Its
// certificate is trusted for exactly those two hosts, on exactly the adapter's two partitions;
// everything else keeps Chromium's own verification. Loaded only in demo mode, and bundled only
// into a demo build: app.ts imports it behind __VALET_DEMO_BUILD__, which a production build
// sets to false, so this chunk, the fake site, its certificate generator and the test account are
// left out of it.

import { X509Certificate } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { MESSAGES_SENDER } from '@valet/adapter-woolworths'
import { partitionName } from '@valet/browser-electron'
import { MemoryKeychain, type MemoryKeychainItem } from '@valet/credentials'
import {
  DEMO_SHOP_ITEM_ID,
  type FakeOnePassword,
  type KeyholdApp,
  type Prompt,
  startKeyholdApp,
} from '@valet/fake-onepassword'
import {
  type FakeWoolworths,
  generateTestCertificate,
  startFakeWoolworths,
} from '@valet/fake-woolworths-site'
import { BrowserWindow, session } from 'electron'
import type { Credentials } from '../core/credentials'
import {
  DEMO_ACCOUNT,
  DEMO_PORTS_FILE,
  type DemoPorts,
  demoCredentials,
  demoOnePasswordFake,
  outboxOtpReader,
  savedDemoPorts,
} from '../core/demo'
import { SHOWCASE_HOUSE_BRAND } from '../core/showcase'

export const DEMO_HOSTS = ['www.woolworths.test', 'auth.woolworths.test'] as const

export interface DemoSite {
  readonly site: FakeWoolworths
  readonly fingerprint: string
  readonly otpReader: ReturnType<typeof outboxOtpReader>
  /** The tool partition's proxy dial: only the demo's hosts, all on this machine. */
  readonly dial: (host: string, port: number) => ReturnType<typeof connect>
  /** Valet's 1Password wiring over the fake 1Password and a file-backed Keychain, and the outbox. */
  readonly credentials: Credentials
  /** The fake 1Password ("Keyhold"), and its windows' server. */
  readonly onePassword: FakeOnePassword
  readonly keyhold: KeyholdApp
  /** The demo's Keychain, for the e2e suite. */
  readonly keychain: MemoryKeychain
}

/** The file in userData that keeps the demo's Keychain copies: test values only. */
export const DEMO_KEYCHAIN_FILE = 'demo-keychain.json'
/** The fake 1Password's windows' partition: in memory, and used by nothing else. */
export const KEYHOLD_PARTITION = 'demo-keyhold'

/**
 * Starts the fake on the ports the last demo launch used (kept in `userData`), so the adapter's
 * origins, and with them its hash, its approval and its grants, survive a restart. Ports taken by
 * something else: new ones, and the adapter waits for review again.
 */
export async function startDemoSite(
  userData: string,
  { showcase = false }: { readonly showcase?: boolean } = {},
): Promise<DemoSite> {
  // Needs the openssl CLI; the certificate lives as long as this launch.
  const tls = await generateTestCertificate([...DEMO_HOSTS])
  const portsFile = join(userData, DEMO_PORTS_FILE)
  const saved = savedDemoPorts(await readFile(portsFile, 'utf8').catch(() => null))
  // A showcase shows only the fake's made-up brand, and its test phone for signing in on the shop.
  const options = {
    tls,
    hostname: DEMO_HOSTS[0],
    accounts: [DEMO_ACCOUNT],
    ...(showcase ? { houseBrand: SHOWCASE_HOUSE_BRAND, demoPhone: true } : {}),
  }
  const site =
    saved === null
      ? await startFakeWoolworths(options)
      : await startFakeWoolworths({ ...options, ...saved }).catch(() => startFakeWoolworths(options))
  const ports: DemoPorts = { port: site.port, authPort: site.authPort }
  await writeFile(portsFile, `${JSON.stringify(ports)}\n`, { mode: 0o600 }).catch(() => undefined)
  const otpReader = outboxOtpReader(
    () => site.outbox,
    MESSAGES_SENDER,
    () => Date.now(),
  )
  // The copies outlive a relaunch, as a real Keychain's do, so a grant made before one still logs in.
  const keychainFile = join(userData, DEMO_KEYCHAIN_FILE)
  const keychain = new MemoryKeychain({
    items: savedKeychain(await readFile(keychainFile, 'utf8').catch(() => null)),
    persist: (items) => {
      try {
        writeFileSync(keychainFile, `${JSON.stringify(items)}\n`, { mode: 0o600 })
      } catch {
        // The copy is still in memory for this launch.
      }
    },
  })
  const onePassword = demoOnePasswordFake(site.authOrigin)
  const keyhold = await startKeyholdApp(onePassword)
  return {
    site,
    fingerprint: tls.fingerprint,
    otpReader,
    onePassword,
    keyhold,
    keychain,
    credentials: demoCredentials(otpReader, { onePassword, keychain }),
    dial: (host, port) => {
      if (!(DEMO_HOSTS as readonly string[]).includes(host))
        throw new Error('demo mode stays on this machine')
      return connect({ host: '127.0.0.1', port })
    },
  }
}

/** The saved copies, or none for anything but an array of items. Each item is checked again on load. */
export function savedKeychain(text: string | null): MemoryKeychainItem[] {
  if (text === null) return []
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) ? (value as MemoryKeychainItem[]) : []
  } catch {
    return []
  }
}

/**
 * Shows the fake 1Password's prompt in a window of its own each time an integration asks, as the
 * desktop app does, and closes it a moment after the person answers. The window is on its own
 * in-memory partition, may load only the fake's loopback origin, and gets no preload, permissions or
 * new windows. Closing it unanswered denies the prompt. Returns a function that stops listening.
 */
export function showKeyholdPrompts(demo: DemoSite, { e2e }: { readonly e2e: boolean }): () => void {
  const partition = session.fromPartition(KEYHOLD_PARTITION)
  const origin = new URL(demo.keyhold.url).origin
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !(details.url === origin || details.url.startsWith(`${origin}/`)) }),
  )
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  const open = new Map<string, BrowserWindow>()
  const onPrompt = (prompt: Prompt): void => {
    const window = new BrowserWindow({
      width: 420,
      height: 520,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: e2e ? 'Keyhold [keyhold]' : 'Keyhold',
      backgroundColor: '#f7f5ef',
      webPreferences: { partition: KEYHOLD_PARTITION, sandbox: true, contextIsolation: true },
    })
    window.on('page-title-updated', (event) => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault()
    })
    window.on('closed', () => {
      open.delete(prompt.id)
      if (prompt.state === 'pending') demo.onePassword.deny(prompt.id)
    })
    open.set(prompt.id, window)
    void window.loadURL(demo.keyhold.promptUrl(prompt.id))
  }
  const onSettled = (prompt: Prompt): void => {
    const window = open.get(prompt.id)
    // Long enough to read "Access allowed".
    if (window !== undefined) setTimeout(() => window.isDestroyed() || window.close(), 1200)
  }
  demo.onePassword.on('prompt', onPrompt)
  demo.onePassword.on('settled', onSettled)
  return () => {
    demo.onePassword.off('prompt', onPrompt)
    demo.onePassword.off('settled', onSettled)
    for (const window of open.values()) if (!window.isDestroyed()) window.close()
  }
}

/**
 * What the end-to-end suite may do to the fake site from Playwright's `app.evaluate` (the main
 * process's global scope): make it block every request (the site's Access Denied page), read the
 * demo account's trolley as the site holds it, and turn on the fake's hostile page beacon (every www
 * page then carries the site's own script sending its cookies to `target`; null turns it off). Set
 * only in an e2e launch of a demo build: this chunk isn't in a production build at all, and no
 * renderer can reach the main process's globals.
 */
export interface DemoE2eHook {
  blockAll(on: boolean): void
  trolley(): readonly { readonly stockcode: number; readonly quantity: number }[]
  pageBeacon(target: { readonly host: string; readonly port: number } | null): void
  /** Ends every www and Auth0 session, and makes Auth0 refuse every password while on. */
  wrongPassword(on: boolean): void
  /** How many times the password form has been posted to Auth0 since launch (AC10). */
  passwordPosts(): number
  /** The pick-up store (by address id) of each session logged in to the demo account; null: none. */
  pickupStores(): readonly (number | null)[]
  /** The fake 1Password: allow every prompt at once (unlocking first), or stop. */
  onePasswordAutoApprove(on: boolean): void
  /** Locks the fake 1Password, which ends its approvals. */
  onePasswordLock(): void
  /** Every prompt the fake 1Password has raised: kind, integration and answer. */
  onePasswordPrompts(): readonly {
    readonly kind: string
    readonly integration: string
    readonly state: string
  }[]
  /** The demo Keychain's items: service and account, never the value. */
  keychainItems(): readonly { readonly service: string; readonly account: string }[]
  /** Changes the shop login's password in the fake 1Password, as the person editing it would. */
  onePasswordChangePassword(password: string): void
  /** Whether the demo Keychain's copy of the shop login's password is the fake 1Password's now. */
  copyIsCurrent(): boolean
}

export function exposeToE2e(demo: DemoSite): void {
  const hook: DemoE2eHook = {
    blockAll: (on) => demo.site.blockAll(on === true),
    trolley: () => demo.site.trolleyFor(DEMO_ACCOUNT.username).map((l) => ({ ...l })),
    pageBeacon: (target) =>
      demo.site.setPageBeacon(target === null ? null : { host: target.host, port: target.port }),
    wrongPassword: (on) => {
      demo.site.expireSessions()
      demo.site.expireAuthSessions()
      demo.site.rejectPasswords(on === true)
    },
    passwordPosts: () =>
      demo.site.authRequests.filter((r) => r.method === 'POST' && r.path.startsWith('/u/login/password'))
        .length,
    pickupStores: () => [...demo.site.pickupAddresses(DEMO_ACCOUNT.username)],
    onePasswordAutoApprove: (on) => {
      demo.onePassword.autoApprove = on === true
    },
    onePasswordLock: () => demo.onePassword.lock(),
    onePasswordPrompts: () =>
      demo.onePassword.prompts.map((p) => ({ kind: p.kind, integration: p.integration, state: p.state })),
    keychainItems: () => demo.keychain.items().map((i) => ({ service: i.service, account: i.account })),
    onePasswordChangePassword: (password) =>
      demo.onePassword.updateItem(DEMO_SHOP_ITEM_ID, { password: String(password) }),
    copyIsCurrent: () => {
      const item = demo.onePassword.items.find((i) => i.id === DEMO_SHOP_ITEM_ID)
      const copy = demo.keychain.items().find((i) => i.account.endsWith(`/${DEMO_SHOP_ITEM_ID}#password`))
      return copy !== undefined && copy.secret === item?.password
    },
  }
  Object.defineProperty(globalThis, '__valetE2e', { value: Object.freeze(hook) })
}

/** Trusts the demo certificate for the demo hosts on the adapter's partitions. Call before any load. */
export function trustDemoCertificate(adapterId: string, fingerprint: string): void {
  for (const role of ['auth', 'tool'] as const) {
    session.fromPartition(partitionName(role, adapterId)).setCertificateVerifyProc((request, callback) => {
      if (!(DEMO_HOSTS as readonly string[]).includes(request.hostname)) {
        callback(-3) // Chromium's own verification
        return
      }
      let matches = false
      try {
        matches = new X509Certificate(request.certificate.data).fingerprint256 === fingerprint
      } catch {
        matches = false
      }
      callback(matches ? 0 : -2)
    })
  }
}
