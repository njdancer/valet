// The adapter manifest: everything about an adapter that is declared rather than coded. It is
// what a person reviews and approves, and what the runtime enforces. See docs/security-model.md.

import { z } from 'zod'
import { canonicalAddress, hostPort, isPrivateHostAddress, parseEndpoint } from './addresses'
import { type CredentialDeclaration, credentialDeclarationSchema, credentialIssues } from './credential'
import { MESSAGES_SECRET } from './credentials'
import { type ERROR_CLASSES, NEEDS_USER_REASONS, type NeedsUserReason } from './errors'
import { hostAllowed, isBareOrigin, isHostname, isHostPattern } from './origins'
import { isScreenedPattern } from './regex-screen'
import {
  BROWSER_METHODS,
  describeDeclaration,
  privateHostKey,
  READ_ONLY_WEBDAV,
  REQUEST_METHODS,
} from './request-surface'
import { type Protocols, protocolIssues, protocolsSchema } from './protocols'
import { sandboxDeclarationSchema } from './sandbox'

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lower snake_case, at most 64 characters')
const origin = z.string().refine(isBareOrigin, 'must be a bare https origin, e.g. https://www.example.com')
const hostPattern = z
  .string()
  .refine(
    isHostPattern,
    'must be a bare hostname such as api.example.com, optionally prefixed with "*.": no https:// and no path',
  )
const selector = z.string().min(1).max(500)
const timeoutMs = z.number().int().min(100).max(120_000)
/** An adapter-supplied regular expression: it must compile and pass the backtracking screen. */
const screenedRegex = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(isScreenedPattern, 'must compile and avoid nested or ambiguous repetition')
/** Shown to the person inside the app only; never sent to the MCP client. */
const note = z.string().min(1).max(200)

export const purposeSchema = z.enum(['read', 'write', 'irreversible'])

export const secretFieldSchema = z.enum(['username', 'password', 'otp'])
export type SecretField = z.infer<typeof secretFieldSchema>

/** A request for a secret. The person binds it to a credential item when granting. */
export const secretRequestSchema = z.object({
  description: z.string().min(1).max(200),
  fields: z.array(secretFieldSchema).min(1),
  origins: z.array(origin).min(1),
})

export const secretRefSchema = z.object({ secret: name, field: secretFieldSchema })
export type SecretRef = z.infer<typeof secretRefSchema>

export type Condition =
  | { readonly visible: string }
  /** The current URL's path and query contain this text. */
  | { readonly urlContains: string }
  /** The current URL's path and query match this regular expression. */
  | { readonly urlRegex: string }
  | { readonly textPresent: string }
  | { readonly not: Condition }
  | { readonly any: readonly Condition[] }
  | { readonly all: readonly Condition[] }

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ visible: selector }).strict(),
    z.object({ urlContains: z.string().min(1).max(500) }).strict(),
    z.object({ urlRegex: screenedRegex(500) }).strict(),
    z.object({ textPresent: z.string().min(1).max(200) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(8) }).strict(),
    z.object({ all: z.array(conditionSchema).min(1).max(8) }).strict(),
  ]),
)

export const otpSourceSchema = z.union([
  z.object({ secret: name }).strict(),
  z
    .object({
      messages: z
        .object({
          /** The sender handle, as Messages shows it; the person approves it when granting. */
          sender: z.string().min(1).max(100),
          /** First capture group (or the whole match) is the code. */
          pattern: screenedRegex(200),
          maxAgeSeconds: z.number().int().min(10).max(900),
        })
        .strict(),
    })
    .strict(),
])
export type OtpSource = z.infer<typeof otpSourceSchema>

/** Error classes an auth flow's fail step may end with. */
export const FAIL_CLASSES = [
  'auth-failed',
  'blocked-by-site',
  'not-logged-in',
  'unexpected-shape',
] as const satisfies readonly (typeof ERROR_CLASSES)[number][]
export type FailClass = (typeof FAIL_CLASSES)[number]

export type AuthStep =
  | { readonly op: 'goto'; readonly url: string }
  | {
      readonly op: 'waitFor'
      readonly condition: Condition
      readonly timeoutMs: number
    }
  | { readonly op: 'click'; readonly selector: string }
  | {
      readonly op: 'fill'
      readonly selector: string
      readonly value: { readonly literal: string } | SecretRef
    }
  | { readonly op: 'otp'; readonly selector: string; readonly source: OtpSource }
  | { readonly op: 'pause'; readonly ms: number }
  | {
      readonly op: 'when'
      readonly condition: Condition
      readonly steps: readonly AuthStep[]
      readonly otherwise?: readonly AuthStep[]
    }
  | { readonly op: 'retry'; readonly times: number; readonly steps: readonly AuthStep[] }
  | { readonly op: 'assertLoggedIn' }
  | { readonly op: 'needsUser'; readonly reason: NeedsUserReason; readonly note?: string }
  | { readonly op: 'fail'; readonly errorClass: FailClass; readonly note?: string }

export const authStepSchema: z.ZodType<AuthStep> = z.lazy(() =>
  z.discriminatedUnion('op', [
    z.object({ op: z.literal('goto'), url: z.url({ protocol: /^https$/ }) }).strict(),
    z.object({ op: z.literal('waitFor'), condition: conditionSchema, timeoutMs }).strict(),
    z.object({ op: z.literal('click'), selector }).strict(),
    z
      .object({
        op: z.literal('fill'),
        selector,
        value: z.union([z.object({ literal: z.string().max(500) }).strict(), secretRefSchema.strict()]),
      })
      .strict(),
    z.object({ op: z.literal('otp'), selector, source: otpSourceSchema }).strict(),
    z.object({ op: z.literal('pause'), ms: z.number().int().min(0).max(30_000) }).strict(),
    z
      .object({
        op: z.literal('when'),
        condition: conditionSchema,
        steps: z.array(authStepSchema).max(50),
        otherwise: z.array(authStepSchema).max(50).optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal('retry'),
        times: z.number().int().min(1).max(5),
        steps: z.array(authStepSchema).min(1).max(50),
      })
      .strict(),
    z.object({ op: z.literal('assertLoggedIn') }).strict(),
    z
      .object({ op: z.literal('needsUser'), reason: z.enum(NEEDS_USER_REASONS), note: note.optional() })
      .strict(),
    z.object({ op: z.literal('fail'), errorClass: z.enum(FAIL_CLASSES), note: note.optional() }).strict(),
  ]),
)

/** A same-origin path: starts with one "/", never "//" (protocol-relative) or a backslash. */
const sitePath = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^\/(?![/\\])[^\\]*$/, 'must be a path starting with a single "/"')

/**
 * How the runtime decides whether a session is logged in. session.ensure() runs it in the tool
 * partition before deciding to log in; the auth flow's assertLoggedIn step runs it in the auth
 * partition before the hand-off.
 */
export const probeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fetch'),
      path: sitePath(300),
      expectStatus: z.number().int().min(100).max(599),
      /**
       * Statuses that mean "logged out" rather than "something is wrong". Anything else unexpected
       * is an error. The probe follows redirects; listing a redirect status (302, say) means a
       * redirect anywhere on the way, to a sign-in page usually, is logged out.
       */
      loggedOutStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(5).default([401]),
      /** Dot path into the JSON body, e.g. "IsLoggedIn" or "shopper.id". */
      jsonPath: z.string().min(1).max(200).optional(),
      /** When set, the value at jsonPath must equal this. Otherwise it must be present and truthy. */
      equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
      /**
       * How long a "logged in" answer may stand in for the next probe, for `write` tools only and
       * only for a call's first session.ensure(). Unset or 0: every ensure() probes. A read tool
       * and an irreversible tool always probe, so nothing the person is shown and nothing that
       * can't be undone rests on an old answer. The cost of setting it: a session that ends inside
       * the window is not noticed until the window closes, and a write sent meanwhile goes wherever
       * the site sends a logged-out visitor's.
       */
      trustSeconds: z.number().int().min(0).max(300).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('cookie'), name: z.string().min(1).max(200) }).strict(),
  /**
   * The adapter never logs in: its site needs no account. With it, the manifest has no auth steps,
   * no cookie domains, no storage keys and no secrets, and session.ensure() answers at once that
   * there is no login to make, without opening anything.
   */
  z.object({ kind: z.literal('none') }).strict(),
])
export type Probe = z.infer<typeof probeSchema>

const requestMethod = z.enum(REQUEST_METHODS)

/**
 * The kinds of adapter (docs/adapter-kinds.md): where its code runs and how it reaches the outside.
 * `browser` drives a real browser's tool partition; `http` calls APIs through Valet's own HTTPS and
 * WebSocket client, the egress broker; `protocol` and `raw` are designed and not built yet.
 */
export const RUNTIME_KINDS = ['browser', 'http', 'protocol', 'raw'] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]
/** The kinds a manifest may name today. A workstream that builds a kind adds it here. */
export const AVAILABLE_RUNTIMES: readonly RuntimeKind[] = ['browser', 'http', 'protocol']

/** The manifest's kind: `browser` when it doesn't say, so every older manifest means what it did. */
export function runtimeOf(manifest: { readonly runtime?: RuntimeKind | undefined }): RuntimeKind {
  return manifest.runtime ?? 'browser'
}

/**
 * A host on the person's own network (docs/adapter-kinds.md#f1-the-egress-broker). It is an IP
 * literal in a private range, never a name, so DNS can't move it; never loopback or link-local; and
 * never a port Valet itself listens on (refused when the broker connects, since those are chosen
 * at run time). `certSha256` pins a self-signed certificate: the SHA-256 of its DER encoding, in
 * lower-case hex. A secret Valet keeps is never sent to one over plain `http`.
 */
export const privateHostSchema = z
  .object({
    address: z
      .string()
      .refine(
        isPrivateHostAddress,
        'must be a private IP address written in its canonical form, such as 192.168.1.20 or fd00::5: no names, loopback or link-local',
      ),
    port: z.number().int().min(1).max(65_535),
    scheme: z.enum(['https', 'http']).optional(),
    certSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'the SHA-256 of the certificate, 64 lower-case hex characters')
      .optional(),
  })
  .strict()
  .refine((host) => !(host.scheme === 'http' && host.certSha256 !== undefined), {
    message: 'certSha256 pins an https certificate; a plain http host has none',
  })
export type PrivateHost = z.infer<typeof privateHostSchema>

/** A request declaration's `host`: an exact egress host name, or a private host's `address:port`. */
const requestHost = z
  .string()
  .max(60)
  .refine(
    (value) => (isHostname(value) && value === value.toLowerCase()) || isPrivateHostKey(value),
    'must be a bare lower-case hostname such as api.example.com, or a private host as address:port: no https://, no path, no "*."',
  )

function isPrivateHostKey(value: string): boolean {
  const match = /^(?:\[([0-9a-f:]+)\]|([0-9.]+)):(\d{1,5})$/.exec(value)
  if (match === null) return false
  const address = (match[1] ?? match[2]) as string
  const port = Number(match[3])
  return isPrivateHostAddress(address) && port >= 1 && port <= 65_535 && hostPort(address, port) === value
}

export const toolDeclarationSchema = z
  .object({
    name,
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(1000),
    sideEffect: purposeSchema,
    /**
     * `write` tools only (C9): whether the tool can remove or overwrite anything, as MCP's
     * destructiveHint means it. Default true, the safe reading. A claim about the adapter's own
     * code; the runtime can't hold a write to "only adds".
     */
    destructive: z.boolean().optional(),
    /**
     * `write` tools only (C9): whether calling it twice with the same input has no further effect,
     * as MCP's idempotentHint means it. Default false.
     */
    idempotent: z.boolean().optional(),
    /**
     * `irreversible` tools only (C15): the manifest's `irreversible` request declarations this tool
     * may use once the person has confirmed a call to it, each named by method and path exactly as
     * declared. Confirming unlocks these and no others, for that run. Without it, confirming
     * unlocks nothing.
     */
    unlocks: z
      .array(z.object({ method: requestMethod, path: sitePath(300) }).strict())
      .min(1)
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((tool, ctx) => {
    if (tool.sideEffect !== 'irreversible' && tool.unlocks !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['unlocks'],
        message: 'only an irreversible tool may set unlocks',
      })
    }
    // A read changes nothing and an irreversible tool is always destructive and never retried, so
    // only a write may say either.
    if (tool.sideEffect === 'write') return
    for (const key of ['destructive', 'idempotent'] as const) {
      if (tool[key] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `only a write tool may set ${key}` })
      }
    }
  })

/**
 * A setting the person chooses in the app for this adapter (D69): which store a shop's prices come
 * from, say. The adapter never asks free text of the person: it offers choices, and the app saves
 * the one they pick. Both of a setting's tools are the adapter's own declared tools, run by the
 * runtime under every guard a tool call gets. They are never listed to, or callable by, MCP clients.
 */
export const settingSchema = z
  .object({
    title: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    /** While a required setting has no value, every other tool ends needsUser `setting-required`. */
    required: z.boolean().default(false),
    choices: z
      .object({
        /**
         * A `read` tool. Input: settingQuerySchema (what the person typed). Output:
         * settingChoicesSchema.
         */
        tool: name,
        /** What the person is asked to type to find choices, e.g. "Postcode". */
        queryLabel: z.string().min(1).max(60),
      })
      .strict(),
    /**
     * A `read` or `write` tool that makes the site use the chosen value. Input: settingValueSchema.
     * The runtime runs it before the next tool call whenever the value changed, the session may have
     * changed (a login), or the last run of it is old. Without one, the value is only stored.
     */
    apply: z.object({ tool: name }).strict().optional(),
  })
  .strict()
export type SettingDeclaration = z.infer<typeof settingSchema>

/** What a tool declaration means for MCP's hints, with C9's safe defaults filled in. */
export function toolHints(tool: {
  readonly sideEffect: z.infer<typeof purposeSchema>
  readonly destructive?: boolean | undefined
  readonly idempotent?: boolean | undefined
}): { readonly destructive: boolean; readonly idempotent: boolean } {
  if (tool.sideEffect === 'read') return { destructive: false, idempotent: true }
  if (tool.sideEffect === 'irreversible') return { destructive: true, idempotent: false }
  return { destructive: tool.destructive ?? true, idempotent: tool.idempotent ?? false }
}

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    name: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(1000),
    /**
     * `browser` (the default), or another kind of adapter (docs/adapter-kinds.md). Optional with no
     * default, so manifests without it hash exactly as before.
     */
    runtime: z.enum(RUNTIME_KINDS).optional(),
    /**
     * The site's home page, opened in the tool partition before tool code runs. A browser adapter
     * must give it; an `http` adapter must not, and parsing sets it to its first endpoint, which is
     * then only what relative URLs resolve against and the name its pacing and breaker are kept
     * under (nothing opens it). Only a private http host's derived home is plain http.
     */
    home: z.url({ protocol: /^https?$/ }).optional(),
    /**
     * The site's own cart page, which Valet opens in the person's own browser so they can check out
     * there (Valet never places orders). Must be on a navigation origin. Optional.
     */
    cartUrl: z.url({ protocol: /^https$/ }).optional(),
    /**
     * Origins the auth partition may navigate to. Anything else aborts the auth action. At least
     * one for a browser adapter; none for an `http` adapter, which opens no pages.
     */
    navigation: z.array(origin).default([]),
    /**
     * Hosts the tool partition may send any request to. Everything else is blocked. At least one
     * for a browser adapter. For an `http` adapter, the exact hosts (no "*.") its requests go to,
     * on port 443 only; it may have none if it reaches only private hosts.
     */
    egress: z.array(hostPattern).default([]),
    /**
     * `http` adapters only: hosts on the person's own network, by address and port
     * (docs/adapter-kinds.md#f1-the-egress-broker). Each is a high-risk line on the approval card.
     */
    privateHosts: z.array(privateHostSchema).max(10).optional(),
    /**
     * `raw` adapters only: the exact `host:port` pairs its tunnels may reach, as parseEndpoint
     * writes them (docs/adapter-kinds.md#f1-the-egress-broker). Private ones go in privateHosts.
     */
    endpoints: z
      .array(
        z
          .string()
          .max(260)
          .refine((v) => {
            const parsed = parseEndpoint(v)
            return (
              parsed !== null &&
              canonicalAddress(parsed.host) === null &&
              `${parsed.host}:${parsed.port}` === v
            )
          }, 'an endpoint is host:port, in lower case, with a host name (private addresses go in privateHosts)'),
      )
      .max(20)
      .optional(),
    /** Left out, with session and auth, for a site that needs no login. */
    secrets: z.record(name, secretRequestSchema).default({}),
    session: z
      .object({
        /** Cookie domains copied from the auth partition to the tool partition after login. */
        cookieDomains: z.array(hostPattern),
        /** Web-storage keys copied the same way, for sites that keep tokens outside cookies. */
        storage: z
          .array(z.object({ origin, keys: z.array(z.string().min(1).max(200)).min(1) }).strict())
          .default([]),
        probe: probeSchema,
      })
      .strict()
      .default(() => ({ cookieDomains: [], storage: [], probe: { kind: 'none' as const } })),
    auth: z
      .object({
        steps: z.array(authStepSchema).max(200),
        /**
         * Origins, beyond navigation, that subframes of the auth page may load (a CAPTCHA, say).
         * Secrets are never typed into them unless they are also a granted secret origin.
         */
        frameOrigins: z.array(origin).max(10).default([]),
      })
      .strict()
      .default(() => ({ steps: [], frameOrigins: [] })),
    requests: z
      .array(
        z
          .object({
            method: requestMethod,
            /**
             * The egress host this request is sent to, for an API on another host than home's
             * (`hacker-news.firebaseio.com`, say). Left out, the declaration applies on every
             * egress host. An `http` adapter names one on every declaration: an egress host, or a
             * private host as `address:port`.
             */
            host: requestHost.optional(),
            /**
             * `http` adapters only: this GET opens a WebSocket (ctx.http.websocket) and may be used
             * for nothing else. Every message sent on it counts against the run's limits.
             */
            websocket: z.literal(true).optional(),
            path: sitePath(300),
            purpose: purposeSchema,
            /**
             * `read` only: how long the runtime may answer this request again from the session's
             * read cache (D28) instead of asking the site. The cache is dropped at any login and
             * at any write.
             */
            cacheSeconds: z.number().int().min(1).max(3600).optional(),
            /**
             * `write` only: the path of a declared, cached GET read whose answer this write's own
             * response is (D28: a trolley update answers with the trolley). A 2xx JSON response
             * becomes that read's cached answer.
             */
            refreshes: sitePath(300).optional(),
          })
          .strict(),
      )
      .default([]),
    tools: z.array(toolDeclarationSchema).min(1),
    /** Settings the person chooses in the app, by name (D69). */
    settings: z
      .record(name, settingSchema)
      .refine((settings) => Object.keys(settings).length <= 8, 'at most 8 settings')
      .default({}),
    limits: z
      .object({
        requestsPerRun: z.number().int().min(1).max(500).default(50),
        /** Minimum gap between requests to the site, across all of this adapter's runs. */
        minGapMs: z.number().int().min(250).max(60_000).default(2000),
        /**
         * The most requests the runtime sends the site in any hour, across all of this adapter's
         * runs (D28). Checked when a call starts: at the cap, the call is refused with a time to
         * try again and sends nothing; a call already running finishes. Unset: no hourly cap.
         */
        requestsPerHour: z.number().int().min(10).max(3600).optional(),
        /**
         * The most requests the runtime sends the site in any minute (D28). A request past it
         * waits until the oldest of the minute's requests is a minute old. Unset: no such cap.
         */
        requestsPerMinute: z.number().int().min(1).max(240).optional(),
        /**
         * How far each gap between requests is stretched at random, as a percentage of minGapMs
         * (D28): 50 makes every gap between 1 and 1.5 times minGapMs. Never shorter. Unset: none.
         */
        gapJitterPercent: z.number().int().min(0).max(100).optional(),
        /**
         * Adapters other than `browser`: the bytes a `read` tool's run may send, across all its
         * requests and messages (docs/adapter-kinds.md#f1-the-egress-broker). It grows by 1 KB for
         * every 100 KB the run receives. Past it the connection is closed and the call fails
         * `egress/upload-budget`, so a read can't carry much out. Unset: 64 KB.
         */
        uploadBytesPerRun: z.number().int().min(1024).max(16_777_216).optional(),
        /** The same for a `write` or `irreversible` tool's run. Unset: 16 MB. */
        writeUploadBytesPerRun: z.number().int().min(1024).max(67_108_864).optional(),
        /** First circuit-breaker cool-down after the site blocks or rate-limits us; doubles each time. */
        cooldownSeconds: z.number().int().min(60).max(86_400).default(600),
        maxCooldownSeconds: z.number().int().min(60).max(86_400).default(7200),
      })
      .strict()
      .default({ requestsPerRun: 50, minGapMs: 2000, cooldownSeconds: 600, maxCooldownSeconds: 7200 }),
    /**
     * The sandbox and its exceptions (D73). Left out means sandboxed with no exceptions. Optional
     * with no default, so manifests without it hash exactly as before. Not enforced until the
     * sandbox ships (workstream I); until then the permission diff and approval card show it.
     */
    sandbox: sandboxDeclarationSchema.optional(),
    /**
     * Credentials Valet uses on the adapter's behalf outside a browser login (B's contract,
     * docs/adapter-kinds.md#f2-secrets-version-2): kept by Valet, or entrusted to a `raw` adapter.
     * Optional with no default, so manifests without it hash exactly as before.
     */
    credentials: z
      .record(name, credentialDeclarationSchema)
      .refine((credentials) => Object.keys(credentials).length <= 8, 'at most 8 credentials')
      .optional(),
    /**
     * `protocol` adapters only: the protocol clients Valet runs for the adapter, each signed in with
     * one of its kept credentials (docs/imap.md). Optional with no default, so other manifests hash
     * exactly as before.
     */
    protocols: protocolsSchema.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const issue of runtimeIssues(manifest)) ctx.addIssue({ code: 'custom', message: issue })
    // No login is all or nothing: a login needs steps, a probe and somewhere to hand the session.
    const noLogin = manifest.session.probe.kind === 'none'
    const loginParts = [
      manifest.auth.steps.length > 0,
      manifest.session.cookieDomains.length > 0,
      manifest.session.storage.length > 0,
      Object.keys(manifest.secrets).length > 0,
      manifest.auth.frameOrigins.length > 0,
    ]
    if (noLogin && loginParts.some(Boolean)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'an adapter with no login has no auth steps, cookie domains, storage keys, secrets or frame origins',
      })
    }
    if (!noLogin && (manifest.auth.steps.length === 0 || manifest.session.cookieDomains.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'a login needs auth steps and at least one cookie domain' })
    }
    const toolNames = new Set<string>()
    for (const tool of manifest.tools) {
      if (toolNames.has(tool.name)) ctx.addIssue({ code: 'custom', message: `duplicate tool ${tool.name}` })
      toolNames.add(tool.name)
      for (const unlock of tool.unlocks ?? []) {
        if (!unlockedBy(manifest.requests, [unlock]).length) {
          ctx.addIssue({
            code: 'custom',
            message: `tool ${tool.name} unlocks ${unlock.method} ${unlock.path}, which is not a declared irreversible request`,
          })
        }
      }
    }
    const settingTools = new Set<string>()
    for (const [settingName, setting] of Object.entries(manifest.settings)) {
      const roles = [
        { role: 'choices', tool: setting.choices.tool, allowed: ['read'] },
        ...(setting.apply === undefined
          ? []
          : [{ role: 'apply', tool: setting.apply.tool, allowed: ['read', 'write'] }]),
      ]
      for (const { role, tool, allowed } of roles) {
        const declared = manifest.tools.find((t) => t.name === tool)
        if (declared === undefined) {
          ctx.addIssue({ code: 'custom', message: `setting ${settingName} names undeclared tool ${tool}` })
        } else if (!allowed.includes(declared.sideEffect)) {
          ctx.addIssue({
            code: 'custom',
            message: `setting ${settingName}'s ${role} tool ${tool} may not be ${declared.sideEffect}`,
          })
        }
        // One tool, one job: a tool shared between settings or roles would be run with the wrong input.
        if (settingTools.has(tool)) {
          ctx.addIssue({ code: 'custom', message: `tool ${tool} serves more than one setting` })
        }
        settingTools.add(tool)
      }
    }
    if (settingTools.size === manifest.tools.length) {
      ctx.addIssue({ code: 'custom', message: 'every tool serves a setting: none is left for clients' })
    }
    for (const request of manifest.requests) {
      const label = describeDeclaration(request)
      const privateKeys = (manifest.privateHosts ?? []).map(privateHostKey)
      if (
        request.host !== undefined &&
        !privateKeys.includes(request.host) &&
        !(request.host.includes(':') ? false : hostAllowed(request.host, manifest.egress))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${label}: host ${request.host} is not on an egress host or a declared private host`,
        })
      }
      // Only a read may be answered from a cache, and only a write's response may fill one. An
      // irreversible request is never cached, never fills the cache and is never replayed.
      if (request.cacheSeconds !== undefined && request.purpose !== 'read') {
        ctx.addIssue({ code: 'custom', message: `${label}: only a read request may set cacheSeconds` })
      }
      if (request.refreshes === undefined) continue
      if (request.purpose !== 'write') {
        ctx.addIssue({ code: 'custom', message: `${label}: only a write request may set refreshes` })
        continue
      }
      const target = manifest.requests.find(
        (r) => r.method === 'GET' && r.path === request.refreshes && r.host === request.host,
      )
      if (
        target === undefined ||
        target.purpose !== 'read' ||
        target.cacheSeconds === undefined ||
        !isLiteralPath(target.path)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${label}: refreshes must name a declared GET read on the same host, with cacheSeconds and no ":param" or "*"`,
        })
      }
    }
    if (Object.hasOwn(manifest.secrets, MESSAGES_SECRET)) {
      ctx.addIssue({ code: 'custom', message: `secret name ${MESSAGES_SECRET} is reserved` })
    }
    for (const ref of secretRefsIn(manifest.auth.steps)) {
      const request = Object.hasOwn(manifest.secrets, ref.secret) ? manifest.secrets[ref.secret] : undefined
      if (request === undefined) {
        ctx.addIssue({ code: 'custom', message: `auth step uses undeclared secret ${ref.secret}` })
      } else if (!request.fields.includes(ref.field)) {
        ctx.addIssue({ code: 'custom', message: `secret ${ref.secret} does not request field ${ref.field}` })
      }
    }
    for (const message of credentialIssues(
      manifest.credentials,
      runtimeOf(manifest),
      Object.keys(manifest.secrets),
    )) {
      ctx.addIssue({ code: 'custom', path: ['credentials'], message })
    }
    if (manifest.limits.cooldownSeconds > manifest.limits.maxCooldownSeconds) {
      ctx.addIssue({ code: 'custom', message: 'cooldownSeconds exceeds maxCooldownSeconds' })
    }
    if (
      manifest.cartUrl !== undefined &&
      runtimeOf(manifest) === 'browser' &&
      !manifest.navigation.includes(new URL(manifest.cartUrl).origin)
    ) {
      ctx.addIssue({ code: 'custom', message: `cartUrl ${manifest.cartUrl} is not on a navigation origin` })
    }
    for (const [secretName, request] of Object.entries(manifest.secrets)) {
      for (const secretOrigin of request.origins) {
        if (!manifest.navigation.includes(secretOrigin)) {
          ctx.addIssue({
            code: 'custom',
            message: `secret ${secretName} origin ${secretOrigin} is not in navigation`,
          })
        }
      }
    }
  })
  .transform((manifest) => ({ ...manifest, home: manifest.home ?? endpointHome(manifest) }))

/**
 * What an `http` adapter's `home` is set to: its first endpoint as an https URL. Nothing opens it;
 * the runtime keys the site's pacing and breaker by its host, and the app shows it.
 */
function homeIsDerived(manifest: {
  readonly home?: string | undefined
  readonly egress: readonly string[]
  readonly privateHosts?: readonly PrivateHost[] | undefined
  readonly protocols?: Protocols | undefined
}): boolean {
  if (
    manifest.egress.length === 0 &&
    (manifest.privateHosts ?? []).length === 0 &&
    manifest.protocols?.imap === undefined
  )
    return false
  return manifest.home === endpointHome(manifest)
}

function endpointHome(manifest: {
  readonly egress: readonly string[]
  readonly privateHosts?: readonly PrivateHost[] | undefined
  readonly protocols?: Protocols | undefined
}): string {
  // A protocol adapter's home is its server's name: only the key its pacing and breaker are kept under.
  const imap = manifest.protocols?.imap
  if (imap !== undefined) return `https://${imap.endpoint.slice(0, imap.endpoint.lastIndexOf(':'))}/`
  const host = manifest.egress[0]
  if (host !== undefined) return `https://${host}/`
  const first = manifest.privateHosts?.[0]
  // runtimeIssues refuses a manifest with neither, so this is never reached with one.
  if (first === undefined) throw new Error('an http adapter needs an endpoint')
  // Relative URLs resolve against it, so it carries the host's own scheme and port.
  return new URL(`${first.scheme ?? 'https'}://${hostPort(first.address, first.port)}/`).href
}

/**
 * Why a manifest's fields don't fit its kind (docs/adapter-kinds.md#the-kinds-in-detail), as
 * messages. A browser adapter keeps every rule it had; an `http` adapter opens no pages, so it has
 * no home, navigation, login or cart, reaches only exact hosts, and names a host on every request.
 */
function runtimeIssues(manifest: {
  readonly runtime?: RuntimeKind | undefined
  readonly home?: string | undefined
  readonly cartUrl?: string | undefined
  readonly navigation: readonly string[]
  readonly egress: readonly string[]
  readonly privateHosts?: readonly PrivateHost[] | undefined
  readonly endpoints?: readonly string[] | undefined
  readonly requests: readonly {
    readonly method: string
    readonly host?: string | undefined
    readonly path: string
    readonly purpose: string
    readonly websocket?: true | undefined
  }[]
  readonly limits: {
    readonly uploadBytesPerRun?: number | undefined
    readonly writeUploadBytesPerRun?: number | undefined
  }
  readonly protocols?: Protocols | undefined
  readonly credentials?: Readonly<Record<string, CredentialDeclaration>> | undefined
}): string[] {
  const kind = runtimeOf(manifest)
  if (!AVAILABLE_RUNTIMES.includes(kind)) return [`runtime ${kind} is not available yet`]
  const issues: string[] = []
  const nonBrowser = (field: string) => `${field} is only for adapters whose runtime is not browser`
  if (manifest.endpoints !== undefined) issues.push('endpoints is only for raw adapters')
  if (kind === 'protocol') {
    // Parsing sets home to the server's name, so a parsed manifest parses again unchanged.
    if (manifest.home !== undefined && !homeIsDerived(manifest))
      issues.push('a protocol adapter has no home: it opens no pages')
    return [...issues, ...protocolIssues(manifest)]
  }
  if (manifest.protocols !== undefined) issues.push('protocols is only for protocol adapters')
  if (kind === 'browser') {
    if (manifest.home === undefined) issues.push('a browser adapter needs home')
    else if (!manifest.home.startsWith('https:')) issues.push('home must be https')
    if (manifest.navigation.length === 0)
      issues.push('a browser adapter needs at least one navigation origin')
    if (manifest.egress.length === 0) issues.push('a browser adapter needs at least one egress host')
    if (manifest.privateHosts !== undefined) issues.push(nonBrowser('privateHosts'))
    if (manifest.limits.uploadBytesPerRun !== undefined) issues.push(nonBrowser('limits.uploadBytesPerRun'))
    if (manifest.limits.writeUploadBytesPerRun !== undefined)
      issues.push(nonBrowser('limits.writeUploadBytesPerRun'))
    for (const request of manifest.requests) {
      const label = describeDeclaration(request)
      if (!(BROWSER_METHODS as readonly string[]).includes(request.method))
        issues.push(`${label}: ${request.method} is only for http adapters`)
      if (request.websocket !== undefined) issues.push(`${label}: websocket is only for http adapters`)
    }
    return issues
  }
  // http
  // Parsing sets home to the first endpoint, so a parsed manifest parses again unchanged.
  if (manifest.home !== undefined && !homeIsDerived(manifest))
    issues.push('an http adapter has no home: it opens no pages')
  if (manifest.navigation.length > 0) issues.push('an http adapter has no navigation origins')
  if (manifest.cartUrl !== undefined) issues.push('an http adapter has no cartUrl')
  for (const host of manifest.egress)
    if (host.startsWith('*.')) issues.push(`egress ${host}: an http adapter names exact hosts, no "*."`)
  const privateHosts = manifest.privateHosts ?? []
  if (manifest.egress.length === 0 && privateHosts.length === 0)
    issues.push('an http adapter needs an egress host or a private host')
  const keys = privateHosts.map(privateHostKey)
  if (new Set(keys).size !== keys.length) issues.push('privateHosts lists the same address and port twice')
  for (const request of manifest.requests) {
    const label = describeDeclaration(request)
    if (request.host === undefined) issues.push(`${label}: an http adapter names the host of every request`)
    if (request.websocket !== undefined && request.method !== 'GET')
      issues.push(`${label}: a websocket is opened with GET`)
    const webdav = !(BROWSER_METHODS as readonly string[]).includes(request.method)
    if (webdav && request.purpose === 'read' && !READ_ONLY_WEBDAV.includes(request.method))
      issues.push(`${label}: ${request.method} changes something, so it can't be a read`)
  }
  return issues
}

/** The default upload budgets (docs/adapter-kinds.md#f1-the-egress-broker), in bytes. */
export const DEFAULT_READ_UPLOAD_BYTES = 64 * 1024
export const DEFAULT_WRITE_UPLOAD_BYTES = 16 * 1024 * 1024

/**
 * The bytes one run of a tool with this side effect may send, before what it receives earns it
 * more: the manifest's limit or the default. A read's budget is the tighter one.
 */
export function uploadBudget(
  manifest: {
    readonly limits: {
      readonly uploadBytesPerRun?: number | undefined
      readonly writeUploadBytesPerRun?: number | undefined
    }
  },
  sideEffect: 'read' | 'write' | 'irreversible',
): number {
  return sideEffect === 'read'
    ? (manifest.limits.uploadBytesPerRun ?? DEFAULT_READ_UPLOAD_BYTES)
    : (manifest.limits.writeUploadBytesPerRun ?? DEFAULT_WRITE_UPLOAD_BYTES)
}

/**
 * Why every call of this manifest's tools would fail before tool code runs, or null. The tool page
 * opens home first, so home's host must be on the egress list. Not a schema rule, so that a stored
 * package written before it still loads; drafts are checked against it (valet_check_draft).
 */
export function homeUnreachable(
  manifest: Pick<AdapterManifest, 'home' | 'egress'> & { readonly runtime?: RuntimeKind | undefined },
): string | null {
  // Only a browser adapter opens home.
  if (runtimeOf(manifest) !== 'browser') return null
  const host = new URL(manifest.home).hostname
  return hostAllowed(host, manifest.egress)
    ? null
    : `egress must allow ${host}, home's host: every call opens home first`
}

/** A declared path with no ":param" or "*" segment and no query: it names exactly one URL. */
function isLiteralPath(path: string): boolean {
  return !path.includes('?') && path.split('/').every((part) => !part.startsWith(':') && part !== '*')
}

export type AdapterManifest = z.infer<typeof manifestSchema>
export type ManifestInput = z.input<typeof manifestSchema>
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>

/**
 * The names of the tools that serve the manifest's settings. The runtime runs them itself: they are
 * never listed to an MCP client, and a client's call to one is refused as not found.
 */
export function settingToolNames(manifest: Pick<AdapterManifest, 'settings'>): Set<string> {
  const names = new Set<string>()
  for (const setting of Object.values(manifest.settings)) {
    names.add(setting.choices.tool)
    if (setting.apply !== undefined) names.add(setting.apply.tool)
  }
  return names
}

/**
 * The `irreversible` declarations among `requests` that `unlocks` names (C15): same method, same
 * path, character for character. A path pattern is matched as text, never expanded, so a tool
 * can't name a wider pattern than the manifest declared.
 */
export function unlockedBy<
  R extends { readonly method: string; readonly path: string; readonly purpose: string },
>(
  requests: readonly R[],
  unlocks: readonly { readonly method: string; readonly path: string }[] | undefined,
): R[] {
  return requests.filter(
    (request) =>
      request.purpose === 'irreversible' &&
      (unlocks ?? []).some((u) => u.method === request.method && u.path === request.path),
  )
}

/** Every secret reference an auth flow makes, including OTP sources and nested steps. */
export function secretRefsIn(steps: readonly AuthStep[]): SecretRef[] {
  const refs: SecretRef[] = []
  const visit = (list: readonly AuthStep[]): void => {
    for (const step of list) {
      if (step.op === 'fill' && 'secret' in step.value) refs.push(step.value)
      if (step.op === 'otp' && 'secret' in step.source)
        refs.push({ secret: step.source.secret, field: 'otp' })
      if (step.op === 'when') {
        visit(step.steps)
        if (step.otherwise) visit(step.otherwise)
      }
      if (step.op === 'retry') visit(step.steps)
    }
  }
  visit(steps)
  return refs
}

/** The Messages OTP sources an auth flow uses, including nested steps. Each needs a messages grant. */
export function messagesSourcesIn(
  steps: readonly AuthStep[],
): { readonly sender: string; readonly pattern: string; readonly maxAgeSeconds: number }[] {
  const sources: { sender: string; pattern: string; maxAgeSeconds: number }[] = []
  const visit = (list: readonly AuthStep[]): void => {
    for (const step of list) {
      if (step.op === 'otp' && 'messages' in step.source) sources.push(step.source.messages)
      if (step.op === 'when') {
        visit(step.steps)
        if (step.otherwise) visit(step.otherwise)
      }
      if (step.op === 'retry') visit(step.steps)
    }
  }
  visit(steps)
  return sources
}

/** A manifest's credentials, or none. */
export function credentialsOf(manifest: {
  readonly credentials?: Readonly<Record<string, CredentialDeclaration>> | undefined
}): Readonly<Record<string, CredentialDeclaration>> {
  return manifest.credentials ?? {}
}

export function parseManifest(input: unknown): AdapterManifest {
  return manifestSchema.parse(input)
}

/** Whether the adapter logs in at all. One with no login runs every tool on the site anonymously. */
export function hasLogin(manifest: AdapterManifest): boolean {
  return manifest.session.probe.kind !== 'none'
}
