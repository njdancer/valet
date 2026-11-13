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
