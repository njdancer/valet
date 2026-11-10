// The adapter manifest: everything about an adapter that is declared rather than coded. It is
// what a person reviews and approves, and what the runtime enforces. See docs/security-model.md.

import { z } from 'zod'
import { MESSAGES_SECRET } from './credentials'
import { type ERROR_CLASSES, NEEDS_USER_REASONS, type NeedsUserReason } from './errors'
import { isBareOrigin, isHostPattern } from './origins'
import { isScreenedPattern } from './regex-screen'

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lower snake_case, at most 64 characters')
const origin = z.string().refine(isBareOrigin, 'must be a bare https origin, e.g. https://www.example.com')
const hostPattern = z.string().refine(isHostPattern, 'must be a hostname, optionally prefixed with "*."')
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
      /** Statuses that mean "logged out" rather than "something is wrong". Anything else unexpected is an error. */
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
])
export type Probe = z.infer<typeof probeSchema>

const requestMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

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
    /** The site's home page, opened in the tool partition before tool code runs. */
    home: z.url({ protocol: /^https$/ }),
    /** Origins the auth partition may navigate to. Anything else aborts the auth action. */
    navigation: z.array(origin).min(1),
    /** Hosts the tool partition may send any request to. Everything else is blocked. */
    egress: z.array(hostPattern).min(1),
    secrets: z.record(name, secretRequestSchema),
    session: z
      .object({
        /** Cookie domains copied from the auth partition to the tool partition after login. */
        cookieDomains: z.array(hostPattern).min(1),
        /** Web-storage keys copied the same way, for sites that keep tokens outside cookies. */
        storage: z
          .array(z.object({ origin, keys: z.array(z.string().min(1).max(200)).min(1) }).strict())
          .default([]),
        probe: probeSchema,
      })
      .strict(),
    auth: z
      .object({
        steps: z.array(authStepSchema).min(1).max(200),
        /**
         * Origins, beyond navigation, that subframes of the auth page may load (a CAPTCHA, say).
         * Secrets are never typed into them unless they are also a granted secret origin.
         */
        frameOrigins: z.array(origin).max(10).default([]),
      })
      .strict(),
    requests: z
      .array(
        z
          .object({
            method: requestMethod,
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
        /** First circuit-breaker cool-down after the site blocks or rate-limits us; doubles each time. */
        cooldownSeconds: z.number().int().min(60).max(86_400).default(600),
        maxCooldownSeconds: z.number().int().min(60).max(86_400).default(7200),
      })
      .strict()
      .default({ requestsPerRun: 50, minGapMs: 2000, cooldownSeconds: 600, maxCooldownSeconds: 7200 }),
  })
  .strict()
  .superRefine((manifest, ctx) => {
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
    for (const request of manifest.requests) {
      const label = `${request.method} ${request.path}`
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
      const target = manifest.requests.find((r) => r.method === 'GET' && r.path === request.refreshes)
      if (
        target === undefined ||
        target.purpose !== 'read' ||
        target.cacheSeconds === undefined ||
        !isLiteralPath(target.path)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `${label}: refreshes must name a declared GET read with cacheSeconds and no ":param" or "*"`,
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
    if (manifest.limits.cooldownSeconds > manifest.limits.maxCooldownSeconds) {
      ctx.addIssue({ code: 'custom', message: 'cooldownSeconds exceeds maxCooldownSeconds' })
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

/** A declared path with no ":param" or "*" segment and no query: it names exactly one URL. */
function isLiteralPath(path: string): boolean {
  return !path.includes('?') && path.split('/').every((part) => !part.startsWith(':') && part !== '*')
}

export type AdapterManifest = z.infer<typeof manifestSchema>
export type ManifestInput = z.input<typeof manifestSchema>
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>

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

export function parseManifest(input: unknown): AdapterManifest {
  return manifestSchema.parse(input)
}
