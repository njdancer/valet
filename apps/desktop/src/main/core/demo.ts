// Demo mode's credentials: the fake site's own test account behind the fake provider, and one-time
// codes read from the fake site's outbox in place of Messages. Nothing here can reach a real
// account: the fake provider holds fixed test values, and real 1Password and Messages are off.
// Imported only by electron/demo.ts, which only a demo build bundles (see electron.vite.config.ts).

import {
  CredentialError,
  isScreenedPattern,
  type MessagesOtpQuery,
  type OtpReader,
  SecretValue,
} from '@siteadapter/core'
import { FakeCredentialProvider } from '@siteadapter/credentials'
import type { VaultItem } from '../../shared/api'
import type { Credentials } from './credentials'

/** The fake site's account with SMS MFA (its CLI's second dev account). Test values only. */
export const DEMO_ACCOUNT = {
  username: 'twofactor@example.test',
  password: 'fake-password-2',
  otpCode: '246810',
  mfa: 'sms',
  firstName: 'Tess',
} as const

export const DEMO_ITEM: VaultItem = { id: 'demo-woolworths', title: 'Woolworths (demo account)' }

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

export function demoCredentials(otp: OtpReader): Credentials {
  const fake = new FakeCredentialProvider({
    items: { [DEMO_ITEM.id]: { username: DEMO_ACCOUNT.username, password: DEMO_ACCOUNT.password } },
  })
  return {
    providers: () => ({ fake }),
    otpReader: () => otp,
    async status() {
      return [
        { kind: 'fake', available: true, unavailableReason: null },
        { kind: 'onepassword-service-account', available: false, unavailableReason: 'disabled' },
        { kind: 'onepassword-cli', available: false, unavailableReason: 'disabled' },
        { kind: 'messages', available: true, unavailableReason: null },
      ]
    },
    async vaultItems(provider) {
      return provider === 'fake' ? [DEMO_ITEM] : []
    },
    async configure() {},
  }
}
