// "My Cloudflare account" (docs/cloudflare-tunnel.md): remote access through a Cloudflare Tunnel in
// the person's own account instead of Valet's relay. They give an API token that may edit tunnels
// and DNS, and the public name to use; Valet makes a named tunnel that sends that name to its remote
// listener on 127.0.0.1, adds the DNS record, and runs the bundled cloudflared with the tunnel's
// token. Cloudflare ends TLS at its edge in this mode, so it can read the traffic: the settings say
// so. The tokens stay in Valet's own Keychain item; cloudflared gets its token in its environment,
// never on its command line.

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { normaliseRemoteHost } from '@valet/mcp-server'
import { z } from 'zod'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/** What went wrong, in words the settings can show. */
export type CloudflareProblem =
  /** Cloudflare refused the token: wrong, expired or revoked. */
  | 'token'
  /** The token works but may not edit tunnels or this zone's DNS. */
  | 'permission'
  /** No zone in the account holds this name. */
  | 'zone'
  /** The name already has a DNS record Valet didn't make; Valet won't overwrite it. */
  | 'name-taken'
  | 'network'
  | 'cloudflare'

export class CloudflareSetupError extends Error {
  constructor(
    readonly problem: CloudflareProblem,
    message: string,
  ) {
    super(message)
    this.name = 'CloudflareSetupError'
  }
}

const storedSchema = z.object({
  version: z.literal(1),
  apiToken: z.string().min(1).max(512),
  hostname: z.string().refine((h) => normaliseRemoteHost(h) === h),
  accountId: z.string().regex(/^[0-9a-f]{32}$/),
  zoneId: z.string().regex(/^[0-9a-f]{32}$/),
  tunnelId: z.string().uuid(),
  tunnelToken: z.string().min(1).max(4096),
  dnsRecordId: z.string().regex(/^[0-9a-f]{32}$/),
  /** Where the tunnel sends the name: the listener's loopback URL when it was configured. */
  origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/),
})

/** Everything Valet keeps about the tunnel it made, in its Keychain item. */
export type StoredCloudflareTunnel = z.infer<typeof storedSchema>

export function parseStoredTunnel(text: string): StoredCloudflareTunnel | null {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const envelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string().optional() })).default([]),
  result: z.unknown(),
})

const zoneSchema = z.object({ id: z.string(), name: z.string(), account: z.object({ id: z.string() }) })
const tunnelSchema = z.object({ id: z.string() })
const recordSchema = z.object({ id: z.string(), type: z.string(), content: z.string().optional() })

export interface CloudflareApiOptions {
  readonly token: string
  readonly fetch?: typeof fetch
  readonly base?: string
}

/** The few Cloudflare API calls Valet makes, with their failures sorted into problems. */
export class CloudflareApi {
  private readonly fetch: typeof fetch
  private readonly base: string

  constructor(private readonly options: CloudflareApiOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.base = options.base ?? CLOUDFLARE_API
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      })
    } catch {
      throw new CloudflareSetupError('network', 'Couldn’t reach Cloudflare.')
    }
    if (res.status === 401) throw new CloudflareSetupError('token', 'Cloudflare didn’t accept the token.')
    if (res.status === 403)
      throw new CloudflareSetupError('permission', 'The token may not make this change in Cloudflare.')
    let parsed: z.infer<typeof envelope>
    try {
      parsed = envelope.parse(await res.json())
    } catch {
      throw new CloudflareSetupError('cloudflare', `Cloudflare answered ${res.status}.`)
    }
    if (!res.ok || !parsed.success) {
      const first = parsed.errors[0]
      // 10000 is Cloudflare's "Authentication error", sent for a token without the permission too.
      if (first?.code === 10000)
        throw new CloudflareSetupError('permission', 'The token may not make this change in Cloudflare.')
      throw new CloudflareSetupError('cloudflare', `Cloudflare said: ${first?.message ?? res.status}`)
    }
    return parsed.result
  }

  /** The zone that holds `hostname`: the longest suffix the token can see. */
  async findZone(hostname: string): Promise<{ zoneId: string; accountId: string }> {
    const labels = hostname.split('.')
    for (let i = 0; i <= labels.length - 2; i++) {
      const name = labels.slice(i).join('.')
      const zones = z
        .array(zoneSchema)
        .parse(await this.call('GET', `/zones?name=${encodeURIComponent(name)}`))
      const zone = zones.find((candidate) => candidate.name === name)
      if (zone !== undefined) return { zoneId: zone.id, accountId: zone.account.id }
    }
    throw new CloudflareSetupError('zone', `No zone the token can see holds ${hostname}.`)
  }

  async findTunnel(accountId: string, name: string): Promise<string | null> {
    const tunnels = z
      .array(tunnelSchema.extend({ name: z.string() }))
      .parse(
        await this.call(
          'GET',
          `/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}`,
        ),
      )
    return tunnels.find((t) => t.name === name)?.id ?? null
  }

  async createTunnel(accountId: string, name: string): Promise<string> {
    return tunnelSchema.parse(
      await this.call('POST', `/accounts/${accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' }),
    ).id
  }

  async tunnelToken(accountId: string, tunnelId: string): Promise<string> {
    return z
      .string()
      .min(1)
      .parse(await this.call('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`))
  }

  /** The tunnel's whole configuration: this one name to the listener, everything else 404. */
  async configure(accountId: string, tunnelId: string, hostname: string, origin: string): Promise<void> {
    await this.call('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
      config: { ingress: [{ hostname, service: origin, originRequest: {} }, { service: 'http_status:404' }] },
    })
  }

  async findRecord(zoneId: string, hostname: string): Promise<z.infer<typeof recordSchema> | null> {
    const records = z
      .array(recordSchema)
      .parse(await this.call('GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`))
    return records[0] ?? null
  }

  async createRecord(zoneId: string, hostname: string, tunnelId: string): Promise<string> {
    return recordSchema.parse(
      await this.call('POST', `/zones/${zoneId}/dns_records`, {
        type: 'CNAME',
        name: hostname,
        content: tunnelTarget(tunnelId),
        proxied: true,
        comment: 'Valet remote access',
      }),
    ).id
  }

  async deleteRecord(zoneId: string, recordId: string): Promise<void> {
    await this.call('DELETE', `/zones/${zoneId}/dns_records/${recordId}`)
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
    // A tunnel with connections can't be deleted; cloudflared is stopped first, and this ends the
    // connections Cloudflare still remembers.
    await this.call('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`)
    await this.call('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`)
  }
}

const tunnelTarget = (tunnelId: string) => `${tunnelId}.cfargotunnel.com`

export interface ProvisionOptions {
  readonly api: CloudflareApi
  readonly apiToken: string
  readonly hostname: string
  /** The tunnel's name in the account, e.g. valet-<macId>; one tunnel per Mac, found again by it. */
  readonly tunnelName: string
  /** Where cloudflared sends the name: the remote listener, http://127.0.0.1:<port>. */
  readonly origin: string
}

/**
 * Makes (or finds again) the tunnel, points it at the listener and adds the DNS record. Safe to run
 * again: an existing tunnel of the same name and a record already pointing at it are reused. A
 * record for the name that points anywhere else is the person's, and is left alone.
 */
export async function provisionCloudflareTunnel(options: ProvisionOptions): Promise<StoredCloudflareTunnel> {
  const hostname = normaliseRemoteHost(options.hostname)
  if (hostname === null) throw new CloudflareSetupError('zone', 'That isn’t a name like valet.example.com.')
  const { api } = options
  const { zoneId, accountId } = await api.findZone(hostname)
  const tunnelId =
    (await api.findTunnel(accountId, options.tunnelName)) ??
    (await api.createTunnel(accountId, options.tunnelName))
  await api.configure(accountId, tunnelId, hostname, options.origin)
  const existing = await api.findRecord(zoneId, hostname)
  let dnsRecordId: string
  if (existing === null) dnsRecordId = await api.createRecord(zoneId, hostname, tunnelId)
  else if (existing.type === 'CNAME' && existing.content === tunnelTarget(tunnelId)) dnsRecordId = existing.id
  else
    throw new CloudflareSetupError(
      'name-taken',
      `${hostname} already has a DNS record. Choose another name, or remove that record in Cloudflare first.`,
    )
  const tunnelToken = await api.tunnelToken(accountId, tunnelId)
  return storedSchema.parse({
    version: 1,
    apiToken: options.apiToken,
    hostname,
    accountId,
    zoneId,
    tunnelId,
    tunnelToken,
    dnsRecordId,
    origin: options.origin,
  })
}

/** Takes away what provisioning made: the DNS record, then the tunnel. */
export async function removeCloudflareTunnel(
  api: CloudflareApi,
  stored: StoredCloudflareTunnel,
): Promise<void> {
  await api.deleteRecord(stored.zoneId, stored.dnsRecordId)
  await api.deleteTunnel(stored.accountId, stored.tunnelId)
}

// ---------- cloudflared ----------

export type CloudflaredStatus =
  | { readonly state: 'starting' }
  | { readonly state: 'connected' }
  /** It exited; it starts again at `at`. */
  | { readonly state: 'restarting'; readonly at: Date; readonly exitCode: number | null }
  | { readonly state: 'stopped' }

export interface CloudflaredOptions {
  /** The bundled binary, and any arguments before cloudflared's own (tests run a script with node). */
  readonly command: {
    readonly file: string
    readonly args?: readonly string[]
    /** Extra environment for a stand-in (Electron's binary running a script as Node). */
    readonly env?: Readonly<Record<string, string>>
  }
  readonly token: string
  readonly onStatus?: (status: CloudflaredStatus) => void
  readonly log?: (line: string) => void
  readonly spawn?: typeof nodeSpawn
  readonly backoff?: { readonly minMs: number; readonly maxMs: number }
}

const CONNECTED = /Registered tunnel connection/

/** Runs cloudflared for the tunnel, starting it again with backoff whenever it exits. */
export class Cloudflared {
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private delay: number
  private stopped = true
  private current: CloudflaredStatus = { state: 'stopped' }

  constructor(private readonly options: CloudflaredOptions) {
    this.delay = options.backoff?.minMs ?? 1000
  }

  get status(): CloudflaredStatus {
    return this.current
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.run()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 5000)
      force.unref()
      child.once('exit', () => clearTimeout(force))
    }
    this.set({ state: 'stopped' })
  }

  private set(status: CloudflaredStatus): void {
    this.current = status
    this.options.onStatus?.(status)
  }

  private run(): void {
    const { command } = this.options
    const spawn = this.options.spawn ?? nodeSpawn
    this.set({ state: 'starting' })
    const child = spawn(command.file, [...(command.args ?? []), 'tunnel', '--no-autoupdate', 'run'], {
      // Its token in its environment, not its arguments: anyone on the Mac can read a process's
      // arguments. Nothing else of Valet's environment goes with it.
      env: {
        ...command.env,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env['HOME'] ?? '/',
        TUNNEL_TOKEN: this.options.token,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.child = child
    let buffered = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (CONNECTED.test(line) && this.child === child && this.current.state !== 'connected') {
          this.delay = this.options.backoff?.minMs ?? 1000
          this.set({ state: 'connected' })
        }
        this.options.log?.(`[cloudflared] ${line.slice(0, 300)}`)
        newline = buffered.indexOf('\n')
      }
    })
    const ended = (code: number | null) => {
      if (this.child !== child) return
      this.child = null
      if (this.stopped) return
      const wait = this.delay
      this.delay = Math.min(this.delay * 2, this.options.backoff?.maxMs ?? 60_000)
      this.set({ state: 'restarting', at: new Date(Date.now() + wait), exitCode: code })
      this.timer = setTimeout(() => {
        this.timer = null
        if (!this.stopped) this.run()
      }, wait)
    }
    child.once('error', (error) => {
      this.options.log?.(`[cloudflared] couldn’t start: ${error.message}`)
      ended(null)
    })
    child.once('exit', (code) => ended(code))
  }
}
