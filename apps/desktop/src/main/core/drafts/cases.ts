// The agent's cases (docs/authoring-tools.md#the-agents-cases): `test/*.json` files in a draft, each
// a list of tool calls with the fixtures the page serves and what the call must return. Valet owns
// the harness: the draft's compiled tool code runs in a fresh sandbox process with no local
// exceptions, through the runtime's own GuardedToolPage (the request surface, the side effect, the
// deny segments, method overrides, block pages), over a page that answers only from the case's
// fixtures. So a case can't pass by serving a response the real guard would cancel, and the output
// is held to the tool's own output schema before the expectation is compared.
//
// Electron-free. A case with `pages` runs its DOM calls (goto, extract, evaluate, click, fill) in the
// fixture browser the app gives it: the case's pages served from memory, their scripts off, nothing
// sent. A case without pages that calls the DOM fails with a reason saying to add them.

import {
  type AdapterManifest,
  CREDENTIAL_FIELDS,
  checkPackagePath,
  credentialHeaderNames,
  credentialTargets,
  type EnsureResult,
  type ErrorClass,
  type FetchInit,
  type FetchResult,
  homeUnreachable,
  type LocalAccess,
  type MailMessage,
  NeedsUserError,
  OPERATION_PURPOSE,
  type Operation,
  type PackageFiles,
  runtimeOf,
  SecretValue,
  SFTP_OPERATION_PURPOSE,
  type SftpOperation,
  type Stage,
  type ToolContext,
  type ToolPage,
  uploadBudget,
  ValetError,
} from '@valet/core'
import { type ExchangeResult, type RunContext, RunMeter, requestSize } from '@valet/egress'
import {
  CallState,
  CredentialGate,
  type EgressSocket,
  failureDetail,
  GuardedHttp,
  GuardedImap,
  GuardedSftp,
  GuardedSmtp,
  GuardedToolPage,
  type HttpEgress,
  NO_HTTP_ACCESS,
  NO_PAGE,
  runIsolated,
  SecretRedactionSet,
  type SiteGuards,
  type ToolProcessFactory,
} from '@valet/runtime'
import { z } from 'zod'

/**
 * What a case's kept credentials hold, by field: placeholders, so a tool that names a credential
 * runs in a case as it would installed, through the same gate, and never with a real value. The
 * case's fixtures don't check headers, so these only have to be there.
 */
export const CASE_CREDENTIAL_VALUES: Readonly<Record<string, string>> = {
  username: 'case-username',
  password: 'case-password',
  token: 'case-token',
  'ssh-key': 'case-ssh-key',
}

export const MAX_CASES = 100
export const CASE_TIMEOUT_MS = 5_000
/** A case file's name: `test/<name>.json`, directly under test/. */
export const CASE_FILE = /^test\/[a-z0-9][a-z0-9._-]*\.json$/

const fixturePath = z
  .string()
  .regex(/^fixtures\/[a-z0-9][a-z0-9._/-]*$/)
  .max(200)
const stage = z.string().regex(/^[a-z][a-z-]{1,40}$/)

const fetchEntrySchema = z
  .object({
    method: z
      .string()
      .regex(/^[A-Za-z]{1,10}$/)
      .default('GET'),
    /** A path (`/api/x?y=1`) resolved against the manifest's home, or an absolute https URL. */
    url: z.string().min(1).max(2000),
    status: z.number().int().min(100).max(599).default(200),
    contentType: z.string().max(100).default('application/json'),
    /** A fixture path, or an inline value (a JSON value, or text for a non-JSON type). */
    body: z.union([fixturePath, z.object({ inline: z.unknown() }).strict()]).optional(),
  })
  .strict()

const expectSchema = z.union([
  z.object({ output: z.unknown() }).strict(),
  z.object({ error: z.object({ stage, errorClass: stage }).strict() }).strict(),
  z.object({ needsUser: z.string().regex(/^[a-z][a-z-]{1,40}$/) }).strict(),
])

/**
 * One WebSocket a case answers (an http adapter's ctx.http.websocket): the URL the tool opens, and
 * the conversation, in order. A `server` step is a message the socket hands the tool; a `client`
 * step is the next message the tool must send, matched like an output (an object or array is
 * matched on what it lists, text exactly); `close` ends the socket with that code. Server steps
 * after a client step arrive only once the tool has sent it.
 */
const socketStepSchema = z.union([
  z.object({ server: z.unknown() }).strict(),
  z.object({ client: z.unknown() }).strict(),
  z.object({ close: z.number().int().min(1000).max(4999) }).strict(),
])
const socketEntrySchema = z
  .object({
    /** The URL as the tool opens it: https:// (or http:// for a plain-http private host). */
    url: z.string().min(1).max(2000),
    steps: z.array(socketStepSchema).max(100).default([]),
  })
  .strict()

/**
 * One IMAP or SFTP operation a case answers (a protocol adapter's ctx.imap or ctx.sftp), in the
 * order the tool makes them: the operation's name, its arguments if the case checks them (matched
 * like an output, from the first), and what the server "answers": a value, or an error. Each
 * operation still passes the runtime's own checks first (purpose, folders or roots, the request
 * ceiling), as a live call's does.
 */
const protocolStep = <Op extends string>(ops: readonly [Op, ...Op[]]) =>
  z
    .object({
      op: z.enum(ops),
      args: z.array(z.unknown()).max(4).optional(),
      answer: z.unknown().optional(),
      error: z.object({ stage, errorClass: stage }).strict().optional(),
    })
    .strict()
interface ProtocolStep {
  readonly op: string
  readonly args?: readonly unknown[] | undefined
  readonly answer?: unknown
  readonly error?: { readonly stage: string; readonly errorClass: string } | undefined
}

/**
 * One message a case's tool sends through ctx.smtp (a protocol adapter with protocols.smtp), in
 * order: the message as Valet checked it (matched like an output, except that to, cc and bcc are
 * checked in full when it's given), how the person answers its confirmation (approved unless the
 * case says otherwise), and, once approved, the server's error if it refuses the send (a send that
 * goes through has every recipient accepted, as live). The
 * runtime's own checks (only an irreversible tool sends, the recipients list, the message rules,
 * the request ceiling) come first, as on a live call; a send they refuse never reaches the script.
 */
const smtpStepSchema = z
  .object({
    message: z.unknown().optional(),
    confirm: z.enum(['approved', 'declined', 'timed-out']).default('approved'),
    error: z.object({ stage, errorClass: stage }).strict().optional(),
  })
  .strict()
  .refine(
    (s) => s.confirm === 'approved' || s.error === undefined,
    'a send the person doesn’t approve never reaches the server: no error',
  )
type SmtpStep = z.output<typeof smtpStepSchema>

export const caseSchema = z
  .object({
    name: z.string().min(1).max(120),
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    input: z.unknown().default({}),
    /** Pages page.goto loads, by absolute URL: a fixture path each. Needs the fixture browser. */
    pages: z.record(z.string().max(2000), fixturePath).default({}),
    fetch: z.array(fetchEntrySchema).max(50).default([]),
    sockets: z.array(socketEntrySchema).max(4).default([]),
    imap: z
      .array(protocolStep(Object.keys(OPERATION_PURPOSE) as [Operation, ...Operation[]]))
      .max(50)
      .default([]),
    sftp: z
      .array(protocolStep(Object.keys(SFTP_OPERATION_PURPOSE) as [SftpOperation, ...SftpOperation[]]))
      .max(50)
      .default([]),
    smtp: z.array(smtpStepSchema).max(20).default([]),
    session: z.enum(['ok', 'needs-user', 'failed']).default('ok'),
    /**
     * A repair's reproduction (docs/authoring-tools.md#repairs-pr-3): the ticket this case
     * reproduces. Valet also runs it on the installed version, which must fail as the ticket says.
     */
    reproduces: z
      .string()
      .regex(/^R-[A-Z2-7]{4}$/)
      .optional(),
    expect: expectSchema,
  })
  .strict()

export const caseFileSchema = z.object({ cases: z.array(caseSchema).min(1).max(MAX_CASES) }).strict()

export type DraftCase = z.output<typeof caseSchema>

export interface CaseResult {
  readonly file: string
  readonly name: string
  readonly tool: string
  readonly passed: boolean
  /** Why it failed, in Valet's words; may quote paths and values from the case itself. */
  readonly reason: string | null
  /** The fixtures it served. */
  readonly fixtures: readonly string[]
  /** It expects output with at least one value in it (not `{}` or an error). */
  readonly checksOutput: boolean
  /** It expects output but checks no value in it. */
  readonly emptyExpectation: boolean
}

export interface CaseFileProblem {
  readonly file: string
  readonly problem: string
}

export interface CaseRun {
  readonly results: readonly CaseResult[]
  readonly problems: readonly CaseFileProblem[]
}

/** What a compiled draft gives the runner. */
export interface RunnableDraft {
  readonly manifest: AdapterManifest
  readonly script: string
  /** The derived zod schemas, by tool. */
  readonly tools: Readonly<Record<string, { readonly input: z.ZodType; readonly output: z.ZodType }>>
}

export interface CaseRunOptions {
  /** A fresh sandbox process per case (the app: SandboxPool.oneShot()). */
  readonly start: ToolProcessFactory
  /**
   * For a raw draft: a fresh Node runtime process per case, with no network at all
   * (docs/adapter-kinds.md#raw). Without it, a raw draft's cases fail as not runnable here.
   */
  readonly rawStart?: ToolProcessFactory
  /** createLocalAccess(declaration, 'none', …): no exception before approval (docs/sandbox.md). */
  readonly local: LocalAccess
  readonly timeoutMs?: number
  /** Run only this tool's cases. */
  readonly tool?: string
  /** No case starts after this time (ms, by `now`); the rest fail as not reached. */
  readonly deadline?: number
  readonly now?: () => number
  /**
   * Opens the fixture browser for a case's pages (absolute URL → HTML). Without it, a case with
   * pages fails, saying this build can't run them.
   */
  readonly browser?: (
    pages: Readonly<Record<string, string>>,
    egress: readonly string[],
  ) => Promise<CaseBrowser>
}

/** A case's own fixture browser: its tool page, and closing it. */
export interface CaseBrowser {
  readonly page: ToolPage
  close(): void
}

/** Reads every case file in the draft. A file that doesn't parse is a problem, not a crash. */
export function readCases(files: PackageFiles): {
  cases: { file: string; case: DraftCase }[]
  problems: CaseFileProblem[]
} {
  const cases: { file: string; case: DraftCase }[] = []
  const problems: CaseFileProblem[] = []
  for (const [file, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!CASE_FILE.test(file)) continue
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      problems.push({ file, problem: 'not valid JSON' })
      continue
    }
    const parsed = caseFileSchema.safeParse(json)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue === undefined ? '' : issue.path.join('.')
      problems.push({
        file,
        problem: `not a case file: ${where === '' ? '' : `${where}: `}${issue?.message ?? ''}`,
      })
      continue
    }
    for (const c of parsed.data.cases) cases.push({ file, case: c })
  }
  if (cases.length > MAX_CASES) {
    problems.push({ file: 'test/', problem: `more than ${MAX_CASES} cases` })
    cases.length = MAX_CASES
  }
  return { cases, problems }
}

/** Runs every case, one at a time, each in a fresh process. */
export async function runCases(
  draft: RunnableDraft,
  files: PackageFiles,
  options: CaseRunOptions,
): Promise<CaseRun> {
  const { cases, problems } = readCases(files)
  const results: CaseResult[] = []
  const now = options.now ?? Date.now
  for (const { file, case: c } of cases) {
    if (options.tool !== undefined && c.tool !== options.tool) continue
    const left = options.deadline === undefined ? Number.POSITIVE_INFINITY : options.deadline - now()
    if (left <= 0) {
      results.push({
        file,
        name: c.name,
        tool: c.tool,
        passed: false,
        reason: 'Not reached: the check ran out of time (about 30 cases is the most one check can run).',
        fixtures: [],
        ...expectationKind(c),
      })
      continue
    }
    const timeoutMs = Math.min(options.timeoutMs ?? CASE_TIMEOUT_MS, left)
    results.push(await runCase(draft, files, file, c, { ...options, timeoutMs }))
  }
  return { results, problems }
}

/** Thrown inside the harness for a case that can't run as written; becomes its reason. */
class CaseProblem extends Error {}

export async function runCase(
  draft: RunnableDraft,
  files: PackageFiles,
  file: string,
  c: DraftCase,
  options: CaseRunOptions,
): Promise<CaseResult> {
  const used = new Set<string>()
  const fail = (reason: string): CaseResult => ({
    file,
    name: c.name,
    tool: c.tool,
    passed: false,
    reason,
    fixtures: [...used],
    ...expectationKind(c),
  })
  const declared = draft.manifest.tools.find((t) => t.name === c.tool)
  const schemas = draft.tools[c.tool]
  if (declared === undefined || schemas === undefined) return fail(`No tool ${c.tool} in the manifest.`)
  const input = schemas.input.safeParse(c.input)
  if (!input.success) return fail(`The input doesn't match ${c.tool}'s input schema.`)
  // A live call opens home before tool code runs: a home it can't reach fails every call.
  const home = homeUnreachable(draft.manifest)
  if (home !== null) return fail(`A live call would fail with egress/host-not-allowed: ${home}.`)

  // A raw draft's code opens its own sockets, which a case has nothing to answer: its cases run in
  // the Node runtime with no network at all, to test what it does with its input. The network is
  // what a live trial is for.
  const raw = runtimeOf(draft.manifest) === 'raw'
  if (raw) {
    if (Object.keys(c.pages).length > 0 || c.fetch.length > 0 || c.sockets.length > 0)
      return fail(
        'A raw adapter’s case has no network, so no "pages" or "fetch": give the data in the input, and try the network with valet_live_trial.',
      )
    if (options.rawStart === undefined) return fail('This build of Valet can’t run raw adapters.')
  }
  const scriptMismatch = protocolScriptMismatch(draft.manifest, c)
  if (scriptMismatch !== null) return fail(scriptMismatch)

  const controller = new AbortController()
  const state = new CallState(
    `case-${Math.random().toString(36).slice(2, 10)}`,
    controller.signal,
    () => new SecretRedactionSet(),
  )
  const fixtures = new FixturePage(draft.manifest, c, files, used)
  const urls = Object.keys(c.pages)
  let browser: CaseBrowser | null = null
  if (urls.length > 0) {
    if (options.browser === undefined) return fail('This build of Valet can’t run cases with pages.')
    const html: Record<string, string> = {}
    for (const url of urls) {
      const path = c.pages[url] ?? ''
      if (!Object.hasOwn(files, path)) return fail(`No fixture ${clip(path)} in the draft.`)
      used.add(path)
      html[url] = files[path] ?? ''
    }
    try {
      browser = await options.browser(html, draft.manifest.egress)
    } catch {
      return fail('Valet couldn’t open the fixture browser for this case’s pages.')
    }
  }
  const page: ToolPage = browser === null ? fixtures : withPages(fixtures, browser.page, c)
  const guarded = new GuardedToolPage({
    adapterId: draft.manifest.id,
    manifest: draft.manifest,
    sideEffect: declared.sideEffect,
    // A case never unlocks an irreversible request: confirm always answers no.
    unlocks: [],
    inner: page,
    site: OPEN_SITE,
    state,
    audit: async () => {},
  })
  const domUse = { name: null as string | null }
  // An http adapter has no page: its requests go through the runtime's own ctx.http guard, to the
  // case's responses in place of the egress broker, with the run's real upload budget.
  const http = runtimeOf(draft.manifest) !== 'browser'
  // A protocol adapter's ctx.imap: the runtime's own GuardedImap, answered from the case's script in
  // place of the protocol host. No credential is ever asked for.
  const protocols = runtimeOf(draft.manifest) === 'protocol' ? draft.manifest.protocols : undefined
  const imapProtocol = protocols?.imap
  const sftpProtocol = protocols?.sftp
  const imapScript = scripted<Operation>('IMAP', c.imap)
  const sftpScript = scripted<SftpOperation>('SFTP', c.sftp)
  const smtpProtocol = protocols?.smtp
  const smtpScript = scriptedSmtp(c.smtp, smtpProtocol?.endpoint ?? 'smtp.invalid:587')
  const scriptRun = (): RunContext => ({
    meter: new RunMeter(uploadBudget(draft.manifest, declared.sideEffect)),
    signal: controller.signal,
    record: () => {},
  })
  const noCredential = async (): Promise<never> => {
    throw new ValetError('credential', 'not-granted')
  }
  const ctx: ToolContext = {
    ...(sftpProtocol === undefined
      ? {}
      : {
          sftp: new GuardedSftp({
            adapterId: draft.manifest.id,
            manifest: draft.manifest,
            sideEffect: declared.sideEffect,
            site: OPEN_SITE,
            state,
            audit: async () => {},
            backend: {
              endpoint: sftpProtocol.endpoint,
              roots: sftpProtocol.roots,
              connect: sftpScript.connect,
            },
            signIn: noCredential,
            run: scriptRun(),
          }),
        }),
    ...(smtpProtocol === undefined
      ? {}
      : {
          smtp: new GuardedSmtp({
            adapterId: draft.manifest.id,
            manifest: draft.manifest,
            sideEffect: declared.sideEffect,
            site: OPEN_SITE,
            state,
            audit: async () => {},
            backend: {
              endpoint: smtpProtocol.endpoint,
              recipients: smtpProtocol.recipients ?? null,
              connect: smtpScript.connect,
            },
            // The case's script answers for the person: nothing is ever sent from a case.
            confirm: smtpScript.confirm,
            messageId: smtpScript.messageId,
            now: () => CASE_MAIL_DATE,
            signIn: noCredential,
            run: scriptRun(),
          }),
        }),
    ...(imapProtocol === undefined
      ? {}
      : {
          imap: new GuardedImap({
            adapterId: draft.manifest.id,
            manifest: draft.manifest,
            sideEffect: declared.sideEffect,
            site: OPEN_SITE,
            state,
            audit: async () => {},
            backend: {
              endpoint: imapProtocol.endpoint,
              folders: imapProtocol.folders ?? null,
              connect: imapScript.connect,
            },
            signIn: noCredential,
            run: scriptRun(),
          }),
        }),
    page: http ? NO_PAGE : browser === null ? watchDom(guarded, domUse) : guarded,
    // Only an http adapter has ctx.http, as an installed call (tool-host.ts) gives it.
    http:
      http && !raw && runtimeOf(draft.manifest) === 'http'
        ? new GuardedHttp({
            adapterId: draft.manifest.id,
            manifest: draft.manifest,
            sideEffect: declared.sideEffect,
            unlocks: [],
            site: OPEN_SITE,
            state,
            audit: async () => {},
            broker: fixtureEgress(fixtures),
            credentials: caseCredentials(draft.manifest),
            credentialHeaders: [...credentialHeaderNames(draft.manifest)],
            run: {
              meter: new RunMeter(uploadBudget(draft.manifest, declared.sideEffect)),
              signal: controller.signal,
              record: () => {},
            },
          })
        : NO_HTTP_ACCESS,
    session: { ensure: async (): Promise<EnsureResult> => sessionResult(c.session) },
    confirm: async () => false,
    signal: controller.signal,
    local: options.local,
  }
  const timeoutMs = options.timeoutMs ?? CASE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, timeoutMs)
  })
  let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | 'timeout'
  try {
    outcome = await Promise.race([
      // The failure's own words come back too: a case runs the agent's code on its own fixtures.
      runIsolated(
        raw ? (options.rawStart as ToolProcessFactory) : options.start,
        draft.script,
        ctx,
        c.tool,
        input.data,
        { detail: true },
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      timedOut,
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
    browser?.close()
  }
  if (outcome === 'timeout') return fail(`Ran over ${Math.round(timeoutMs / 1000)} seconds.`)
  if (fixtures.problem !== null) return fail(fixtures.problem)
  // Steps the tool never reached matter only when it was meant to finish.
  const scriptProblem =
    imapScript.problem('output' in c.expect) ??
    sftpScript.problem('output' in c.expect) ??
    smtpScript.problem('output' in c.expect)
  if (scriptProblem !== null) return fail(scriptProblem)
  if (domUse.name !== null)
    return fail(
      `The tool calls page.${domUse.name}, which needs a page: give the case one under "pages" (its URL and a fixture).`,
    )

  const expected = c.expect
  if (outcome.ok) {
    // A guard the tool caught and swallowed still ends the real call as that violation.
    if (state.violation !== null) return compareError(state.violation, expected, fail, file, c, used)
    const output = await schemas.output.safeParseAsync(outcome.value)
    if (!output.success) {
      return 'error' in expected &&
        expected.error.stage === 'tool-output' &&
        expected.error.errorClass === 'invalid'
        ? pass(file, c, used)
        : fail(`The output doesn't match ${c.tool}'s output schema${issuesText(output.error.issues)}.`)
    }
    if (!('output' in expected))
      return fail(`Expected ${describeExpect(expected)}, but the tool returned output.`)
    const mismatch = outputMismatch(expected.output, output.data, '$')
    return mismatch === null
      ? pass(file, c, used)
      : fail(
          `Output differs at ${mismatch.at}: expected ${jsonText(mismatch.expected)}, got ${
            mismatch.missing ? 'no such key' : jsonText(mismatch.actual)
          }.`,
        )
  }
  return compareError(outcome.error, expected, fail, file, c, used)
}

function compareError(
  error: unknown,
  expected: DraftCase['expect'],
  fail: (reason: string) => CaseResult,
  file: string,
  c: DraftCase,
  used: Set<string>,
): CaseResult {
  const got = describeError(error)
  const why = failureWords(got, failureDetail(error), c.tool)
  if ('needsUser' in expected) {
    return got.kind === 'needs-user' && got.reason === expected.needsUser
      ? pass(file, c, used)
      : fail(`Expected needs-user ${expected.needsUser}, got ${got.text}${why}`)
  }
  if ('error' in expected) {
    return got.kind === 'error' &&
      got.stage === expected.error.stage &&
      got.errorClass === expected.error.errorClass
      ? pass(file, c, used)
      : fail(`Expected ${expected.error.stage}/${expected.error.errorClass}, got ${got.text}${why}`)
  }
  return fail(`The tool failed: ${got.text}${why}`)
}

/**
 * What the agent's own code said about its failure, ending the sentence: a plain error's message
 * (and how to fail on purpose instead), or where the output broke its schema.
 */
function failureWords(got: Described, detail: string | null, tool: string): string {
  if (got.kind === 'other')
    return detail === null
      ? '. The tool threw something that isn’t a ValetError; throw new ValetError(stage, errorClass) to fail on purpose.'
      : `: the tool threw ${clipDetail(detail)}. Throw new ValetError(stage, errorClass) to fail on purpose.`
  if (detail !== null && got.kind === 'error' && got.stage === 'tool-output' && got.errorClass === 'invalid')
    return `: the output doesn't match ${tool}'s output schema at ${clipDetail(detail)}.`
  if (detail !== null && got.kind === 'error' && got.stage === 'tool-input' && got.errorClass === 'invalid')
    return `: the input doesn't match ${tool}'s input schema at ${clipDetail(detail)}.`
  return '.'
}

/** The first few places a value broke a schema, as " at <path>: <message>". */
function issuesText(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  if (issues.length === 0) return ''
  const shown = issues.slice(0, 3).map((issue) => `${pathText(issue.path)}: ${issue.message}`)
  return ` at ${clipDetail(shown.join('; '))}`
}

function pathText(path: readonly PropertyKey[]): string {
  let out = ''
  for (const part of path)
    out += typeof part === 'number' ? `[${part}]` : `${out === '' ? '' : '.'}${String(part)}`
  return out === '' ? '(top level)' : out
}

/** A value as clipped JSON, for a mismatch. */
function jsonText(value: unknown): string {
  let text: string
  try {
    text = value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value))
  } catch {
    text = String(value)
  }
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

function clipDetail(text: string): string {
  return text.length > 300 ? `${text.slice(0, 299)}…` : text
}

function pass(file: string, c: DraftCase, used: Set<string>): CaseResult {
  return {
    file,
    name: c.name,
    tool: c.tool,
    passed: true,
    reason: null,
    fixtures: [...used],
    ...expectationKind(c),
  }
}

function expectationKind(c: DraftCase): { checksOutput: boolean; emptyExpectation: boolean } {
  if (!('output' in c.expect)) return { checksOutput: false, emptyExpectation: false }
  const leaf = hasLeaf(c.expect.output)
  return { checksOutput: leaf, emptyExpectation: !leaf }
}

/** True if the value holds at least one non-container value (a string, number, boolean or null). */
export function hasLeaf(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasLeaf)
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasLeaf)
  return value !== undefined
}

function describeExpect(expected: DraftCase['expect']): string {
  if ('error' in expected) return `${expected.error.stage}/${expected.error.errorClass}`
  if ('needsUser' in expected) return `needs-user ${expected.needsUser}`
  return 'output'
}

export type Described =
  | { kind: 'error'; stage: string; errorClass: string; text: string }
  | { kind: 'needs-user'; reason: string; text: string }
  | { kind: 'other'; text: string }

export function describeError(error: unknown): Described {
  if (error instanceof ValetError) {
    return {
      kind: 'error',
      stage: error.stage,
      errorClass: error.errorClass,
      text: `${error.stage}/${error.errorClass}`,
    }
  }
  if (error instanceof NeedsUserError) {
    return { kind: 'needs-user', reason: error.reason, text: `needs-user ${error.reason}` }
  }
  return { kind: 'other', text: 'tool-run/internal' }
}

function sessionResult(session: DraftCase['session']): EnsureResult {
  if (session === 'ok') return { status: 'ok' }
  if (session === 'needs-user') return { status: 'needsUser', reason: 'login-required' }
  return { status: 'failed', stage: 'auth-step', errorClass: 'unavailable' }
}

/**
 * Where `actual` fails to contain `expected`: objects by their expected keys, arrays element by
 * element and of the same length, everything else by equality. Null if it matches.
 */
export function partialMismatch(expected: unknown, actual: unknown, at: string): string | null {
  return outputMismatch(expected, actual, at)?.at ?? null
}

export interface Mismatch {
  readonly at: string
  readonly expected: unknown
  /** What the tool produced there; `missing` when the key isn't there at all. */
  readonly actual: unknown
  readonly missing: boolean
}

/** partialMismatch, with what was expected and what the tool produced at that place. */
export function outputMismatch(expected: unknown, actual: unknown, at: string): Mismatch | null {
  const here = { at, expected, actual, missing: false }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return here
    for (let i = 0; i < expected.length; i++) {
      const m = outputMismatch(expected[i], actual[i], `${at}[${i}]`)
      if (m !== null) return m
    }
    return null
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return here
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key))
        return { at: `${at}.${key}`, expected: value, actual: undefined, missing: true }
      const m = outputMismatch(value, (actual as Record<string, unknown>)[key], `${at}.${key}`)
      if (m !== null) return m
    }
    return null
  }
  return Object.is(expected, actual) ? null : here
}

/** The site is always open and never waits: pacing is for real sites, and a case touches none. */
const OPEN_SITE = {
  budget: { acquire: async () => {} },
  breaker: { isOpen: () => false, admit: () => 0, recordSuccess: () => {}, trip: () => {} },
} as unknown as SiteGuards

/** Notes the first DOM capability tool code asks for, which a case can't serve yet. */
function watchDom(page: ToolPage, use: { name: string | null }): ToolPage {
  const needsDom = (name: string): Promise<never> => {
    use.name ??= name
    return Promise.reject(new ValetError('tool-run', 'unavailable'))
  }
  return {
    goto: (url) => page.goto(url),
    currentUrl: () => page.currentUrl(),
    fetch: (url, init) => page.fetch(url, init),
    click: () => needsDom('click'),
    fill: () => needsDom('fill'),
    extract: () => needsDom('extract'),
    evaluate: () => needsDom('evaluate'),
  }
}

/**
 * The fixture browser for the DOM, the case's own responses for fetch. goto() is held to the case's
 * pages first, so a page the case lacks fails the case in words rather than loading a 404.
 */
function withPages(fixtures: FixturePage, browser: ToolPage, c: DraftCase): ToolPage {
  return {
    goto: async (url) => {
      if (c.pages[url] === undefined) await fixtures.goto(url)
      await browser.goto(url)
    },
    currentUrl: () => browser.currentUrl(),
    fetch: (url, init) => fixtures.fetch(url, init),
    click: (selector) => browser.click(selector),
    fill: (selector, text) => browser.fill(selector, text),
    extract: (selector, options) => browser.extract(selector, options),
    evaluate: (source, args) => browser.evaluate(source, args),
  }
}

/**
 * A case's kept credentials: the real gate over a grant of every kept header credential the draft
 * declares, for all its hosts, whose fields are CASE_CREDENTIAL_VALUES. Nothing is audited.
 */
function caseCredentials(manifest: AdapterManifest) {
  const gate = new CredentialGate({
    adapterId: manifest.id,
    adapterHash: 'case',
    credentials: manifest.credentials,
    findGrant: async (credential) => {
      const declaration = manifest.credentials?.[credential]
      if (declaration === undefined || declaration.custody !== 'kept') return null
      return {
        adapterId: manifest.id,
        adapterHash: 'case',
        credential,
        kind: declaration.kind,
        custody: declaration.custody,
        provider: 'keychain-copy',
        itemRef: 'case',
        targets: [...credentialTargets(declaration)],
        grantedAt: new Date(0).toISOString(),
      }
    },
    resolve: async (grant, field) => {
      if (!CREDENTIAL_FIELDS[grant.kind].includes(field)) throw new ValetError('credential', 'field-missing')
      return SecretValue.fromString(CASE_CREDENTIAL_VALUES[field] ?? '')
    },
    audit: { append: async () => undefined },
    remember: () => undefined,
    callId: null,
  })
  return { headerFor: (credential: string, host: string) => gate.headerFor(credential, host) }
}

/**
 * The egress broker as a case sees it: each request that passed ctx.http's guard is answered from
 * the case's `fetch` list, as the page's are. Its bytes are spent from the run's budget as the real
 * broker would spend them. Sockets aren't served yet.
 */
function fixtureEgress(fixtures: FixturePage): HttpEgress {
  return {
    fetch: async (url, request, run): Promise<ExchangeResult> => {
      run.meter.spend(
        requestSize({ method: request.method, url, headers: request.headers, body: request.body }),
      )
      const result = fixtures.fetchText(url.href, { method: request.method })
      return {
        status: result.status,
        headers: { 'content-type': result.contentType },
        body: Buffer.from(result.body, 'utf8'),
      }
    },
    websocket: async (url, _options, run) => fixtures.socket(url.href, run),
  }
}

/**
 * The inner page: what the guarded page asks once a request has passed every guard. It answers
 * only from the case. Its own checks are about the case, not the site: a request the case didn't
 * list fails the case with a reason the agent can act on.
 */
class FixturePage implements ToolPage {
  problem: string | null = null
  private url: string
  private readonly remaining: DraftCase['fetch'][number][]
  private readonly sockets: DraftCase['sockets'][number][]

  constructor(
    private readonly manifest: AdapterManifest,
    private readonly c: DraftCase,
    private readonly files: PackageFiles,
    private readonly used: Set<string>,
  ) {
    this.url = manifest.home
    this.remaining = [...c.fetch]
    this.sockets = [...c.sockets]
  }

  currentUrl(): string {
    return this.url
  }

  async goto(url: string): Promise<void> {
    const page = this.c.pages[url]
    if (page === undefined)
      throw this.miss(`No page for ${clip(url)} in the case: add it under "pages" with a fixture.`)
    this.read(page)
    this.url = url
  }

  async fetch(url: string, init?: FetchInit): Promise<FetchResult> {
    const entry = this.take(url, init)
    return { status: entry.status, contentType: entry.contentType, body: this.body(entry) }
  }

  /**
   * ctx.http's answer: the body as the bytes a server would send. An inline JSON value is sent as
   * JSON, so `{"inline": null}` is the text `null`, which a page's parsed body can't tell from none.
   */
  fetchText(url: string, init?: FetchInit): { status: number; contentType: string; body: string } {
    const entry = this.take(url, init)
    const json = /json/i.test(entry.contentType)
    const body =
      entry.body === undefined
        ? ''
        : typeof entry.body === 'string'
          ? this.read(entry.body)
          : typeof entry.body.inline === 'string' && !json
            ? entry.body.inline
            : (JSON.stringify(entry.body.inline ?? null) ?? '')
    return { status: entry.status, contentType: entry.contentType, body }
  }

  private take(url: string, init?: FetchInit): DraftCase['fetch'][number] {
    const method = (init?.method ?? 'GET').toUpperCase()
    const target = new URL(url)
    const index = this.remaining.findIndex(
      (entry) => entry.method.toUpperCase() === method && this.matches(entry.url, target),
    )
    if (index === -1)
      throw this.miss(`No response for ${method} ${clip(target.pathname + target.search)} in the case.`)
    const [entry] = this.remaining.splice(index, 1)
    if (entry === undefined) throw this.miss('No response in the case.')
    return entry
  }

  async click(): Promise<void> {
    throw new ValetError('tool-run', 'unavailable')
  }

  async fill(): Promise<void> {
    throw new ValetError('tool-run', 'unavailable')
  }

  async extract(): Promise<unknown> {
    throw new ValetError('tool-run', 'unavailable')
  }

  /** Only the runtime's own block-page check reaches here (tool code's evaluate is caught above). */
  async evaluate(): Promise<unknown> {
    return false
  }

  private matches(listed: string, target: URL): boolean {
    let want: URL
    try {
      want = new URL(listed, this.manifest.home)
    } catch {
      return false
    }
    if (want.origin !== target.origin || want.pathname !== target.pathname) return false
    // Listed query parameters must all be present with those values; others may be present too.
    for (const [key, value] of want.searchParams)
      if (!target.searchParams.getAll(key).includes(value)) return false
    return true
  }

  private body(entry: DraftCase['fetch'][number]): unknown {
    const json = /json/i.test(entry.contentType)
    if (entry.body === undefined) return null
    if (typeof entry.body !== 'string') {
      const inline = entry.body.inline
      return json || typeof inline !== 'string' ? (inline ?? null) : inline
    }
    const text = this.read(entry.body)
    if (!json) return text
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }

  private read(path: string): string {
    if (!pathOk(path) || !Object.hasOwn(this.files, path))
      throw this.miss(`No fixture ${clip(path)} in the draft.`)
    this.used.add(path)
    return this.files[path] ?? ''
  }

  /** Something the case harness can't serve: the case fails, saying so. */
  /** The case's scripted socket for `url`, opened once. */
  socket(url: string, run: RunContext): EgressSocket {
    const target = new URL(url)
    const index = this.sockets.findIndex((entry) => this.matches(entry.url, target))
    if (index === -1)
      throw this.miss(
        `No socket for ${clip(target.pathname + target.search)} in the case: add it under "sockets".`,
      )
    const [entry] = this.sockets.splice(index, 1)
    const steps = [...(entry?.steps ?? [])]
    const ready: Buffer[] = []
    let closed: number | null = null
    // Hands over every server step up to the next client step.
    const release = () => {
      while (steps.length > 0) {
        const step = steps[0] as (typeof steps)[number]
        if ('client' in step) return
        steps.shift()
        if ('close' in step) {
          closed = step.close
          steps.length = 0
          return
        }
        ready.push(
          Buffer.from(typeof step.server === 'string' ? step.server : JSON.stringify(step.server), 'utf8'),
        )
      }
    }
    release()
    return {
      send: async (data, binary) => {
        run.meter.spend(data.length)
        const step = steps[0]
        if (closed !== null || step === undefined || !('client' in step))
          throw this.miss(`The tool sent a message the case doesn't expect: ${clip(data.toString('utf8'))}.`)
        steps.shift()
        const text = binary ? data.toString('base64') : data.toString('utf8')
        let sent: unknown = text
        if (typeof step.client !== 'string') {
          try {
            sent = JSON.parse(text)
          } catch {
            throw this.miss(`The tool sent ${clip(text)}, which isn't JSON; the case expects JSON.`)
          }
        }
        const mismatch =
          typeof step.client === 'string'
            ? step.client === text
              ? null
              : `message (the case expects ${clip(step.client)})`
            : partialMismatch(step.client, sent, 'message')
        if (mismatch !== null)
          throw this.miss(`The tool sent ${clip(text)}, which doesn't match the case at ${mismatch}.`)
        release()
      },
      // A case never waits: what the script has is there at once, and nothing more ever comes.
      receive: async () => {
        const next = ready.shift()
        if (next !== undefined) return { kind: 'message', data: next, binary: false }
        if (closed !== null) return { kind: 'closed', code: closed }
        return null
      },
      close: () => {
        closed ??= 1000
      },
    }
  }

  unsupported(reason: string): Error {
    return this.miss(reason)
  }

  /** Records why the case can't go on and returns an error that ends the run. */
  private miss(reason: string): CaseProblem {
    this.problem ??= reason
    return new CaseProblem(reason)
  }
}

function pathOk(path: string): boolean {
  try {
    checkPackagePath(path)
    return true
  } catch {
    return false
  }
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

/**
 * A protocol host stand-in for a case's IMAP or SFTP script: each operation must be the next one
 * the case lists (and match the arguments it lists, from the first); it answers that step's value
 * or error. An operation the case doesn't expect fails the case, and so does a step the tool never
 * made when the case expects output.
 */
function scripted<Op extends string>(
  label: 'IMAP' | 'SFTP',
  steps: readonly ProtocolStep[],
): {
  readonly connect: () => Promise<{
    operation(op: Op, args: readonly unknown[]): Promise<unknown>
    end(): Promise<void>
  }>
  readonly problem: (finished: boolean) => string | null
} {
  let next = 0
  let problem: string | null = null
  const operation = async (op: Op, args: readonly unknown[]): Promise<unknown> => {
    const step = steps[next]
    if (step === undefined) {
      problem ??= `The tool made an ${label} ${op} the case doesn't list (after ${next} steps).`
      throw new ValetError('egress', 'unavailable')
    }
    next++
    if (step.op !== op) {
      problem ??= `${label} step ${next} is ${step.op}, but the tool made ${op}.`
      throw new ValetError('egress', 'unavailable')
    }
    if (
      step.args !== undefined &&
      partialMismatch(step.args, args.slice(0, step.args.length), 'args') !== null
    ) {
      problem ??= `${label} step ${next} (${op}) was made with other arguments: ${JSON.stringify(args).slice(0, 200)}.`
      throw new ValetError('egress', 'unavailable')
    }
    if (step.error !== undefined)
      throw new ValetError(step.error.stage as Stage, step.error.errorClass as ErrorClass)
    return step.answer ?? null
  }
  return {
    connect: async () => ({ operation, end: async () => {} }),
    problem: (finished) =>
      problem ??
      (finished && next < steps.length
        ? `The tool made ${next} of the case's ${steps.length} ${label} steps.`
        : null),
  }
}

/** The Date a case's sends carry: fixed, so a case's output never depends on the clock. */
const CASE_MAIL_DATE = Date.UTC(2026, 0, 1)

/**
 * Why a case's protocol scripts don't fit the draft, or null: a protocol adapter's cases answer
 * only through the scripts of the protocols it declares (it has no page and no ctx.http), and no
 * other adapter's case has any.
 */
function protocolScriptMismatch(manifest: AdapterManifest, c: DraftCase): string | null {
  const scripts = { imap: c.imap.length, smtp: c.smtp.length, sftp: c.sftp.length } as const
  if (runtimeOf(manifest) !== 'protocol') {
    const listed = (Object.keys(scripts) as (keyof typeof scripts)[]).find((k) => scripts[k] > 0)
    return listed === undefined
      ? null
      : `The case lists "${listed}" steps, which only a protocol adapter (runtime "protocol") makes.`
  }
  if (Object.keys(c.pages).length > 0 || c.fetch.length > 0 || c.sockets.length > 0)
    return 'A protocol adapter has no page and no ctx.http, so its cases have no "pages", "fetch" or "sockets": script its protocol with "imap", "smtp" or "sftp" steps.'
  for (const key of Object.keys(scripts) as (keyof typeof scripts)[])
    if (scripts[key] > 0 && manifest.protocols?.[key] === undefined)
      return `The case lists "${key}" steps, but manifest.json has no protocols.${key}.`
  return null
}

/**
 * The protocol host and the person, for a case's SMTP script: each confirmation must be for the
 * next message the case lists (and match what it lists), and answers as the step says; an approved
 * one is "sent" (every recipient accepted) or fails with its error. A
 * message the case doesn't expect fails the case, and so does a listed send the tool never made
 * when the case expects output. Message-IDs are numbered, `<case-1@host>`, so outputs are stable.
 */
function scriptedSmtp(
  steps: readonly SmtpStep[],
  endpoint: string,
): {
  readonly confirm: (message: MailMessage) => Promise<'approved' | 'declined' | 'timed-out'>
  readonly connect: () => Promise<{
    send(value: { readonly message: MailMessage }): Promise<{ readonly accepted: number }>
    end(): Promise<void>
  }>
  readonly messageId: () => string
  readonly problem: (finished: boolean) => string | null
} {
  const host = endpoint.slice(0, endpoint.lastIndexOf(':'))
  let next = 0
  let ids = 0
  let problem: string | null = null
  /** The step whose confirmation was approved last, which the next send answers. */
  let approved: SmtpStep | null = null
  return {
    confirm: async (message) => {
      const step = steps[next]
      if (step === undefined) {
        problem ??= `The tool sent a message the case doesn't list (after ${next} sends): to ${message.to.join(', ').slice(0, 120)}.`
        throw new ValetError('egress', 'unavailable')
      }
      next++
      if (step.message !== undefined) {
        // Every recipient is checked: a case can't show one recipient while the tool adds a Bcc.
        const expected = { to: [], cc: [], bcc: [], ...(step.message as Record<string, unknown>) }
        const mismatch = outputMismatch(expected, message, 'message')
        if (mismatch !== null) {
          problem ??= `SMTP send ${next}'s message differs at ${mismatch.at}: expected ${jsonText(mismatch.expected)}, got ${mismatch.missing ? 'nothing' : jsonText(mismatch.actual)}.`
          throw new ValetError('egress', 'unavailable')
        }
      }
      approved = step.confirm === 'approved' ? step : null
      return step.confirm
    },
    connect: async () => ({
      send: async ({ message }) => {
        const step = approved
        approved = null
        if (step === null) throw new ValetError('egress', 'unavailable')
        if (step.error !== undefined)
          throw new ValetError(step.error.stage as Stage, step.error.errorClass as ErrorClass)
        // A live send that goes through has every recipient accepted; a refusal fails it instead.
        return { accepted: message.to.length + message.cc.length + message.bcc.length }
      },
      end: async () => {},
    }),
    messageId: () => `<case-${++ids}@${host}>`,
    problem: (finished) =>
      problem ??
      (finished && next < steps.length
        ? `The tool sent ${next} of the case's ${steps.length} SMTP messages.`
        : null),
  }
}
