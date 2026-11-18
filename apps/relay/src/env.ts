import type { RateLimiter } from './front'

export interface Env {
  /** The bare relay host, e.g. relay.example. */
  readonly RELAY_HOST: string
  /**
   * The base of each Mac's own host, `<macId>.<RELAY_MAC_HOST>`, when it isn't RELAY_HOST: a
   * domain whose names can each have a certificate (workers.dev can't take a name per Mac).
   * Unset, each Mac is `<macId>.<RELAY_HOST>`.
   */
  readonly RELAY_MAC_HOST?: string
  /** https://<RELAY_HOST>, named in every challenge. */
  readonly RELAY_ORIGIN: string
  /** HMAC key for consent wait tokens. A Worker secret. */
  readonly WAIT_SECRET?: string
  readonly MAC_RELAY: DurableObjectNamespace
  /**
   * The hub's host (relay-hub.md), e.g. valet.dncr.me. Unset, there is no hub: Macs hear
   * hub-status `off` and the host serves nothing.
   */
  readonly HUB_HOST?: string
  /** The commit deployed (scripts/live-config.mjs), which /api/version answers from the Hub object. */
  readonly GIT_SHA?: string
  /**
   * The hub's origin when it isn't https://<HUB_HOST>: only for trying the hub locally, at
   * http://localhost:<port>, where browsers allow passkeys without a certificate.
   */
  readonly HUB_ORIGIN?: string
  /** Typed once on the hub's sign-up page to create the account. A Worker secret. */
  readonly HUB_SETUP_SECRET?: string
  /** Seconds without a frame before a node counts as offline. Default 90. */
  readonly HUB_OFFLINE_AFTER_S?: string
  /** Seconds an offline node's tools stay listed, failing fast. Default 120 (used from step 2). */
  readonly HUB_GRACE_S?: string
  readonly HUB?: DurableObjectNamespace
  readonly PUSH?: DurableObjectNamespace
  readonly CONNECT_LIMIT: RateLimiter
  readonly FORWARD_LIMIT: RateLimiter
  readonly SIGN_IN_LIMIT: RateLimiter
  readonly POLL_LIMIT: RateLimiter
  readonly APNS_KEY?: string
  readonly APNS_KEY_ID?: string
  readonly APNS_TEAM_ID?: string
  readonly APNS_TOPIC?: string
  readonly APNS_HOST?: string
}
