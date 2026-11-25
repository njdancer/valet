// Wakes a paired phone with Apple's push service (APNs), straight from this Mac. The push holds
// only fixed text ("Valet needs you"): the card itself still travels sealed through the relay,
// and the phone fetches it when the person taps the notification (docs/ios-app.md#notifications).
//
// Set up once by putting apns.json and the key Apple gave (AuthKey_<keyId>.p8) in Valet's data
// folder. Without them nothing is sent and phones keep fetching cards when opened, as before.

import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { connect } from 'node:http2'
import { isAbsolute, join } from 'node:path'
import { pushPayloadSchema } from '@valet/core'
import { z } from 'zod'

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const
export type ApnsEnvironment = keyof typeof APNS_HOSTS

/** apns.json in Valet's data folder. */
export const apnsConfigSchema = z
  .object({
    teamId: z.string().regex(/^[A-Z0-9]{10}$/),
    keyId: z.string().regex(/^[A-Z0-9]{10}$/),
    /** The phone app's bundle id, which APNs calls the topic. */
    bundleId: z
      .string()
      .regex(/^[A-Za-z0-9.-]{3,155}$/)
      .default('me.dncr.valet'),
    /** The .p8 file, absolute or relative to the data folder. Defaults to AuthKey_<keyId>.p8. */
    keyFile: z.string().min(1).max(500).optional(),
  })
  .strict()
export type ApnsConfig = z.infer<typeof apnsConfigSchema>

/** One push, as sent: what came back from Apple. */
export interface ApnsResponse {
  readonly status: number
  readonly reason: string | null
}

export type ApnsPost = (
  host: string,
  path: string,
  headers: Readonly<Record<string, string>>,
  body: string,
) => Promise<ApnsResponse>

export interface ApnsOptions {
  /** Valet's data folder: apns.json, the key, and push-tokens.json live here. */
  readonly dir: string
  readonly now?: () => number
  readonly log?: (line: string) => void
  /** Tests swap Apple's servers for a fake. */
  readonly post?: ApnsPost
  /** Overrides apns.json (tests). */
  readonly config?: { readonly config: ApnsConfig; readonly key: KeyObject } | null
}

/** At most one push a phone in this long: one wake brings every waiting card. */
export const PUSH_GAP_MS = 30_000
/** Apple refuses tokens older than an hour and asks for no more than one new one every 20 minutes. */
const JWT_LIFE_MS = 40 * 60_000

const tokensSchema = z.record(
  z.string(),
  z.object({ token: z.string(), environment: z.enum(['production', 'sandbox']).nullable() }).strict(),
)
type Tokens = z.infer<typeof tokensSchema>

/** Fixed text only: Apple sees everything in a push. */
export const NEEDS_YOU_PAYLOAD = JSON.stringify(
  pushPayloadSchema.parse({
    aps: { alert: { title: 'Valet', body: 'Valet needs you' }, sound: 'default' },
  }),
)

export class ApnsSender {
  private readonly now: () => number
  private readonly post: ApnsPost
  private loaded: Promise<{ readonly config: ApnsConfig; readonly key: KeyObject } | null> | null = null
  private tokens: Tokens | null = null
  private jwt: { readonly value: string; readonly at: number } | null = null
  private readonly lastPush = new Map<string, number>()

  constructor(private readonly options: ApnsOptions) {
    this.now = options.now ?? Date.now
    this.post = options.post ?? http2Post
    if (options.config !== undefined) this.loaded = Promise.resolve(options.config)
  }

  /** Whether apns.json and its key are there and readable. */
  async configured(): Promise<boolean> {
    return (await this.load()) !== null
  }

  /** The token a phone sent after it connected. A new one replaces the old. */
  async setToken(deviceId: string, token: string): Promise<void> {
    const tokens = await this.readTokens()
    if (tokens[deviceId]?.token === token) return
    tokens[deviceId] = { token, environment: null }
    await this.saveTokens()
  }

  /** A phone was removed: its token goes too. */
  async forget(deviceId: string): Promise<void> {
    const tokens = await this.readTokens()
    if (!(deviceId in tokens)) return
    delete tokens[deviceId]
    this.lastPush.delete(deviceId)
    await this.saveTokens()
  }

  /**
   * Wakes one phone. Never throws: a phone that can't be woken still gets the card when it opens.
   * Returns what happened, for the log and tests.
   */
  async wake(
    deviceId: string,
  ): Promise<'sent' | 'not-set-up' | 'no-token' | 'too-soon' | 'refused' | 'failed'> {
    try {
      const loaded = await this.load()
      if (loaded === null) return 'not-set-up'
      const tokens = await this.readTokens()
      const entry = tokens[deviceId]
      if (entry === undefined) return 'no-token'
      const now = this.now()
      const last = this.lastPush.get(deviceId)
      if (last !== undefined && now - last < PUSH_GAP_MS) return 'too-soon'
      this.lastPush.set(deviceId, now)
      // A build from Xcode has a sandbox token; TestFlight and the App Store, production. The
      // phone doesn't say which, so the first push tries production and falls back once.
      const order: ApnsEnvironment[] =
        entry.environment === null ? ['production', 'sandbox'] : [entry.environment]
      for (const environment of order) {
        const response = await this.send(loaded, environment, entry.token, now)
        if (response.status === 200) {
          if (entry.environment !== environment) {
            entry.environment = environment
            await this.saveTokens()
          }
          this.log(`[apns] woke ${deviceId.slice(0, 8)} (${environment})`)
          return 'sent'
        }
        this.log(`[apns] ${environment} answered ${response.status} ${response.reason ?? ''}`.trim())
        // 410: the app was removed or turned notifications off for good. Stop until a new token.
        if (response.status === 410 || response.reason === 'Unregistered') {
          delete tokens[deviceId]
          await this.saveTokens()
          return 'refused'
        }
        const wrongPlace =
          response.reason === 'BadDeviceToken' || response.reason === 'DeviceTokenNotForTopic'
        if (!wrongPlace) return 'refused'
      }
      return 'refused'
    } catch (error) {
      this.log(`[apns] push failed: ${error instanceof Error ? error.message : String(error)}`)
      return 'failed'
    }
  }

  private send(
    loaded: { readonly config: ApnsConfig; readonly key: KeyObject },
    environment: ApnsEnvironment,
    token: string,
    now: number,
  ): Promise<ApnsResponse> {
    return this.post(
      APNS_HOSTS[environment],
      `/3/device/${token}`,
      {
        authorization: `bearer ${this.token(loaded, now)}`,
        'apns-topic': loaded.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        // A wake an hour late is no use: the card has likely gone by then.
        'apns-expiration': String(Math.floor(now / 1000) + 3600),
        // Later wakes replace earlier ones on the lock screen.
        'apns-collapse-id': 'valet-needs-you',
      },
      NEEDS_YOU_PAYLOAD,
    )
  }

  /** The provider token Apple asks for: an ES256 JWT signed with the .p8 key. */
  private token(loaded: { readonly config: ApnsConfig; readonly key: KeyObject }, now: number): string {
    if (this.jwt !== null && now - this.jwt.at < JWT_LIFE_MS) return this.jwt.value
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: loaded.config.keyId }))
    const claims = base64url(JSON.stringify({ iss: loaded.config.teamId, iat: Math.floor(now / 1000) }))
    const input = `${header}.${claims}`
    const signature = sign('sha256', Buffer.from(input), { key: loaded.key, dsaEncoding: 'ieee-p1363' })
    const value = `${input}.${signature.toString('base64url')}`
    this.jwt = { value, at: now }
    return value
  }

  private load(): Promise<{ readonly config: ApnsConfig; readonly key: KeyObject } | null> {
    if (this.loaded === null)
      this.loaded = (async () => {
        let raw: string
        try {
          raw = await readFile(join(this.options.dir, 'apns.json'), 'utf8')
        } catch {
          return null
        }
        const parsed = apnsConfigSchema.safeParse(JSON.parse(raw))
        if (!parsed.success) {
          this.log('[apns] apns.json is not valid; phones are not woken')
          return null
        }
        const config = parsed.data
        const file = config.keyFile ?? `AuthKey_${config.keyId}.p8`
        try {
          const pem = await readFile(isAbsolute(file) ? file : join(this.options.dir, file), 'utf8')
          return { config, key: createPrivateKey(pem) }
        } catch {
          this.log('[apns] the push key could not be read; phones are not woken')
          return null
        }
      })().catch(() => null)
    return this.loaded
  }

  private async readTokens(): Promise<Tokens> {
    if (this.tokens !== null) return this.tokens
    try {
      const parsed = tokensSchema.safeParse(
        JSON.parse(await readFile(join(this.options.dir, 'push-tokens.json'), 'utf8')),
      )
      this.tokens = parsed.success ? parsed.data : {}
    } catch {
      this.tokens = {}
    }
    return this.tokens
  }

  private async saveTokens(): Promise<void> {
    const path = join(this.options.dir, 'push-tokens.json')
    await writeFile(`${path}.tmp`, JSON.stringify(this.tokens ?? {}), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }

  private log(line: string): void {
    this.options.log?.(line)
  }
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url')
}

/** One HTTP/2 request to Apple; a new connection each time, since wakes are rare. */
const http2Post: ApnsPost = (host, path, headers, body) =>
  new Promise((resolve, reject) => {
    const session = connect(host)
    const timer = setTimeout(() => {
      session.destroy()
      reject(new Error('APNs timed out'))
    }, 15_000)
    session.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    const request = session.request({ ':method': 'POST', ':path': path, ...headers })
    let status = 0
    let data = ''
    request.on('response', (h) => {
      status = Number(h[':status'] ?? 0)
    })
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      data += chunk
    })
    request.on('end', () => {
      clearTimeout(timer)
      session.close()
      let reason: string | null = null
      try {
        reason = data === '' ? null : ((JSON.parse(data) as { reason?: string }).reason ?? null)
      } catch {
        reason = null
      }
      resolve({ status, reason })
    })
    request.on('error', (error) => {
      clearTimeout(timer)
      session.destroy()
      reject(error)
    })
    request.end(body)
  })
