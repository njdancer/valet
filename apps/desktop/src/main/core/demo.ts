// Demo mode's credentials: the real 1Password wiring (realCredentials) over the fake 1Password
// (fakes/onepassword) and a MemoryKeychain, with one-time codes read from the fake site's outbox in
// place of Messages. The person's 1Password is the fake's "Tess Tester" account; the Keychain copy
// (D6) is made through the fake desktop app's prompt, exactly as a real one is. Nothing here can
// reach a real account: no process is started, no file outside userData is read, and the SDK is
// the fake's. Imported only by electron/demo.ts, which only a demo build bundles (see
// electron.vite.config.ts).

import {
  CredentialError,
  isScreenedPattern,
  type MessagesOtpQuery,
  type OtpReader,
  SecretValue,
} from '@valet/core'
import {
  desktopAuthClientFactory,
  type KeychainStore,
  MemoryKeychain,
  nodeTimers,
  type OnePasswordSdk,
  type Spawner,
  serviceAccountClientFactory,
} from '@valet/credentials'
import {
  DEMO_ONEPASSWORD_ACCOUNT,
  DEMO_SHOP_ITEM_ID,
  DEMO_SHOP_ITEM_TITLE,
  DEMO_VAULTS,
  demoOnePassword,
  FakeOnePassword,
  fakeSdk,
} from '@valet/fake-onepassword'
import type { VaultItem } from '../../shared/api'
import { type Credentials, type FileFacts, realCredentials } from './credentials'

/** The fake site's account with SMS MFA (its CLI's second dev account). Test values only. */
export const DEMO_ACCOUNT = {
  username: 'twofactor@example.test',
  password: 'fake-password-2',
  otpCode: '246810',
  mfa: 'sms',
  firstName: 'Tess',
} as const

/** The fake 1Password account demo mode's setup names (Settings' onePasswordAccount). */
export const DEMO_ONEPASSWORD = DEMO_ONEPASSWORD_ACCOUNT

/** The shop's login in the fake 1Password, as the grant sheet lists it for a Keychain copy. */
export const DEMO_ITEM: VaultItem = {
  id: `${DEMO_VAULTS.personal.id}-${DEMO_SHOP_ITEM_ID}`,
  title: `${DEMO_SHOP_ITEM_TITLE} (${DEMO_VAULTS.personal.title})`,
}

/** The demo's Keychain copies' service, apart from both real builds'. */
export const DEMO_COPY_SERVICE = 'valet.demo.copy'

/** The fake 1Password holding the fake site's account, its login typed only at `signInOrigin`. */
export function demoOnePasswordFake(signInOrigin?: string): FakeOnePassword {
  return new FakeOnePassword(
    demoOnePassword({
      username: DEMO_ACCOUNT.username,
      password: DEMO_ACCOUNT.password,
      ...(signInOrigin === undefined ? {} : { website: signInOrigin }),
    }),
  )
}

/** Who the fake's SMS codes come from: the sender the adapter's manifest declares. */
export interface OutboxMessage {
  readonly channel: 'sms' | 'email'
  readonly text: string
  readonly at: number
}

/**
 * An OtpReader over the fake site's outbox: the newest SMS since `notBefore` (and within the
 * query's maximum age) whose text the pattern matches. Every SMS the fake sends is taken to be from
 * `sender`, the one sender it impersonates; a query for any other sender finds nothing.
 */
export function outboxOtpReader(
  outbox: () => readonly OutboxMessage[],
  sender: string,
  now: () => number,
): OtpReader {
  return {
    async latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue> {
      if (query.sender !== sender || !isScreenedPattern(query.pattern)) throw new CredentialError('not-found')
      const oldest = Math.max(notBefore.getTime(), now() - query.maxAgeSeconds * 1000)
      const pattern = new RegExp(query.pattern)
      for (const message of [...outbox()].reverse()) {
        if (message.channel !== 'sms' || message.at < oldest) continue
        const match = pattern.exec(message.text.slice(0, 2000))
        const code = match?.[1] ?? match?.[0]
        if (code !== undefined && /^(?=.*\d)[A-Za-z0-9]{4,10}$/.test(code))
          return SecretValue.fromString(code)
      }
      throw new CredentialError('not-found')
    },
  }
}

/** The fake site's two ports, kept in userData from one demo launch to the next. */
export interface DemoPorts {
  readonly port: number
  readonly authPort: number
}

/** The file in userData that keeps the demo site's ports. */
export const DEMO_PORTS_FILE = 'demo-site.json'

/**
 * The saved ports, or null for anything but two distinct unprivileged port numbers. The ports are in
 * the adapter's origins, and so in its manifest and its hash: a demo site on new ports each launch
 * was a new bundle each launch, waiting for review again with no grants (the e2e suite found it).
 */
export function savedDemoPorts(text: string | null): DemoPorts | null {
  if (text === null) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const { port, authPort } = value as Record<string, unknown>
  const ok = (p: unknown): p is number =>
    Number.isInteger(p) && (p as number) >= 1024 && (p as number) <= 65535
  return ok(port) && ok(authPort) && port !== authPort ? { port, authPort } : null
}

// Demo mode starts no process and reads no file for its credentials: op is never found, and the
// Keychain helper is never run.
const noProcesses: Spawner = () => {
  throw Object.assign(new Error('demo mode starts no processes'), { code: 'ENOENT' })
}
const noFiles: FileFacts = {
  lstat: () => Promise.reject(new Error('demo mode reads no files')),
  realpath: () => Promise.reject(new Error('demo mode reads no files')),
}

export interface DemoCredentialsOptions {
  /** The fake 1Password; one with the fake site's account by default. */
  readonly onePassword?: FakeOnePassword
  /** Where the copies live; an empty MemoryKeychain by default. */
  readonly keychain?: KeychainStore
}

export function demoCredentials(otp: OtpReader, options: DemoCredentialsOptions = {}): Credentials {
  const fake = options.onePassword ?? demoOnePasswordFake()
  const sdk = async () => fakeSdk(fake) as unknown as OnePasswordSdk
  const base = realCredentials({
    files: noFiles,
    spawner: noProcesses,
    timers: nodeTimers,
    uid: -1,
    groups: [],
    keychain: options.keychain ?? new MemoryKeychain(),
    copyService: DEMO_COPY_SERVICE,
    serviceAccountReady: async () => true,
    serviceAccountClient: serviceAccountClientFactory(sdk),
    desktopClient: desktopAuthClientFactory(sdk),
    messagesHelper: null,
    messagesReader: () => otp,
    ownsToken: false,
  })
  return {
    ...base,
    // Codes come from the fake's outbox whatever the Messages setting says: there is no Messages
    // database to grant access to.
    otpReader: () => otp,
    async status() {
      return (await base.status()).map((s) =>
        s.kind === 'messages' ? { ...s, available: true, unavailableReason: null } : s,
      )
    },
  }
}
