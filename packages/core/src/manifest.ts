// The adapter manifest: everything about an adapter that is declared rather than coded. It is
// what a person reviews and approves, and what the runtime enforces. See docs/security-model.md.

import { z } from 'zod'
import { isBareOrigin, isHostPattern } from './origins'

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lower snake_case, at most 64 characters')
const origin = z.string().refine(isBareOrigin, 'must be a bare https origin, e.g. https://www.example.com')
const hostPattern = z.string().refine(isHostPattern, 'must be a hostname, optionally prefixed with "*."')
const selector = z.string().min(1).max(500)
const timeoutMs = z.number().int().min(100).max(120_000)

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
  | { readonly urlMatches: string }
  | { readonly textPresent: string }
  | { readonly not: Condition }
  | { readonly any: readonly Condition[] }
  | { readonly all: readonly Condition[] }

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ visible: selector }).strict(),
    z.object({ urlMatches: z.string().min(1).max(500) }).strict(),
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
          sender: z.string().min(1).max(100).optional(),
          pattern: z.string().min(1).max(200),
          maxAgeSeconds: z.number().int().min(10).max(900),
        })
        .strict(),
    })
    .strict(),
])
export type OtpSource = z.infer<typeof otpSourceSchema>

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
  | { readonly op: 'needsUser'; readonly reason: string }
  | { readonly op: 'fail'; readonly reason: string }

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
    z.object({ op: z.literal('needsUser'), reason: z.string().min(1).max(200) }).strict(),
    z.object({ op: z.literal('fail'), reason: z.string().min(1).max(200) }).strict(),
  ]),
)

/** How the runtime decides whether a session is logged in. Runs in the tool partition. */
export const probeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('fetch'),
      path: z.string().startsWith('/'),
      expectStatus: z.number().int().min(100).max(599),
      /** Dot path into the JSON body, e.g. "IsLoggedIn" or "shopper.id". */
      jsonPath: z.string().min(1).max(200).optional(),
      /** When set, the value at jsonPath must equal this. Otherwise it must be present and truthy. */
      equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('cookie'), name: z.string().min(1).max(200) }).strict(),
])
export type Probe = z.infer<typeof probeSchema>

export const toolDeclarationSchema = z
  .object({
    name,
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(1000),
    sideEffect: purposeSchema,
  })
  .strict()

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
    auth: z.object({ steps: z.array(authStepSchema).min(1).max(200) }).strict(),
    requests: z
      .array(
        z
          .object({
            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
            path: z.string().startsWith('/').max(300),
            purpose: purposeSchema,
          })
          .strict(),
      )
      .default([]),
    tools: z.array(toolDeclarationSchema).min(1),
    limits: z
      .object({ requestsPerRun: z.number().int().min(1).max(500).default(50) })
      .strict()
      .default({ requestsPerRun: 50 }),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const toolNames = new Set<string>()
    for (const tool of manifest.tools) {
      if (toolNames.has(tool.name)) ctx.addIssue({ code: 'custom', message: `duplicate tool ${tool.name}` })
      toolNames.add(tool.name)
    }
    for (const ref of secretRefsIn(manifest.auth.steps)) {
      const request = manifest.secrets[ref.secret]
      if (request === undefined) {
        ctx.addIssue({ code: 'custom', message: `auth step uses undeclared secret ${ref.secret}` })
      } else if (!request.fields.includes(ref.field)) {
        ctx.addIssue({ code: 'custom', message: `secret ${ref.secret} does not request field ${ref.field}` })
      }
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

export type AdapterManifest = z.infer<typeof manifestSchema>
export type ManifestInput = z.input<typeof manifestSchema>
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>

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

export function parseManifest(input: unknown): AdapterManifest {
  return manifestSchema.parse(input)
}
