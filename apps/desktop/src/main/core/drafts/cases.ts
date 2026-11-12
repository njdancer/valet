// The agent's cases (docs/authoring-tools.md#the-agents-cases): `test/*.json` files in a draft, each
// a list of tool calls with the fixtures the page serves and what the call must return. Valet owns
// the harness: the draft's compiled tool code runs in a fresh sandbox process with no local
// exceptions, through the runtime's own GuardedToolPage (the request surface, the side effect, the
// deny segments, method overrides, block pages), over a page that answers only from the case's
// fixtures. So a case can't pass by serving a response the real guard would cancel, and the output
// is held to the tool's own output schema before the expectation is compared.
//
// Electron-free. Cases whose tool code needs a DOM (extract, evaluate, click, fill) fail here with a
// clear reason until the fixture browser exists (PR 2).

import {
  type AdapterManifest,
  checkPackagePath,
  type EnsureResult,
  type FetchInit,
  type FetchResult,
  type LocalAccess,
  NeedsUserError,
  type PackageFiles,
  type ToolContext,
  type ToolPage,
  ValetError,
} from '@valet/core'
import {
  CallState,
  GuardedToolPage,
  runIsolated,
  SecretRedactionSet,
  type SiteGuards,
  type ToolProcessFactory,
} from '@valet/runtime'
import { z } from 'zod'

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

export const caseSchema = z
  .object({
    name: z.string().min(1).max(120),
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    input: z.unknown().default({}),
    /** Pages page.goto loads, by absolute URL: a fixture path each. Needs the fixture browser. */
    pages: z.record(z.string().max(2000), fixturePath).default({}),
    fetch: z.array(fetchEntrySchema).max(50).default([]),
    session: z.enum(['ok', 'needs-user', 'failed']).default('ok'),
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
  /** createLocalAccess(declaration, 'none', …): no exception before approval (docs/sandbox.md). */
  readonly local: LocalAccess
  readonly timeoutMs?: number
  /** Run only this tool's cases. */
  readonly tool?: string
  /** No case starts after this time (ms, by `now`); the rest fail as not reached. */
  readonly deadline?: number
  readonly now?: () => number
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

  const controller = new AbortController()
  const state = new CallState(
    `case-${Math.random().toString(36).slice(2, 10)}`,
    controller.signal,
    () => new SecretRedactionSet(),
  )
  const page = new FixturePage(draft.manifest, c, files, used)
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
  const ctx: ToolContext = {
    page: watchDom(guarded, domUse),
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
      runIsolated(options.start, draft.script, ctx, c.tool, input.data).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
      timedOut,
    ])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  if (outcome === 'timeout') return fail(`Ran over ${Math.round(timeoutMs / 1000)} seconds.`)
  if (page.problem !== null) return fail(page.problem)
  if (domUse.name !== null)
    return fail(`The tool calls page.${domUse.name}, which needs a page; Valet can't run that in a case yet.`)

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
        : fail(`The output doesn't match ${c.tool}'s output schema.`)
    }
    if (!('output' in expected))
      return fail(`Expected ${describeExpect(expected)}, but the tool returned output.`)
    const mismatch = partialMismatch(expected.output, output.data, '$')
    return mismatch === null ? pass(file, c, used) : fail(`Output differs at ${mismatch}.`)
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
  if ('needsUser' in expected) {
    return got.kind === 'needs-user' && got.reason === expected.needsUser
      ? pass(file, c, used)
      : fail(`Expected needs-user ${expected.needsUser}, got ${got.text}.`)
  }
  if ('error' in expected) {
    return got.kind === 'error' &&
      got.stage === expected.error.stage &&
      got.errorClass === expected.error.errorClass
      ? pass(file, c, used)
      : fail(`Expected ${expected.error.stage}/${expected.error.errorClass}, got ${got.text}.`)
  }
  return fail(`The tool failed: ${got.text}.`)
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

type Described =
  | { kind: 'error'; stage: string; errorClass: string; text: string }
  | { kind: 'needs-user'; reason: string; text: string }
  | { kind: 'other'; text: string }

function describeError(error: unknown): Described {
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
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return at
    for (let i = 0; i < expected.length; i++) {
      const m = partialMismatch(expected[i], actual[i], `${at}[${i}]`)
      if (m !== null) return m
    }
    return null
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return at
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return `${at}.${key}`
      const m = partialMismatch(value, (actual as Record<string, unknown>)[key], `${at}.${key}`)
      if (m !== null) return m
    }
    return null
  }
  return Object.is(expected, actual) ? null : at
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
 * The inner page: what the guarded page asks once a request has passed every guard. It answers
 * only from the case. Its own checks are about the case, not the site: a request the case didn't
 * list fails the case with a reason the agent can act on.
 */
class FixturePage implements ToolPage {
  problem: string | null = null
  private url: string
  private readonly remaining: DraftCase['fetch'][number][]

  constructor(
    private readonly manifest: AdapterManifest,
    private readonly c: DraftCase,
    private readonly files: PackageFiles,
    private readonly used: Set<string>,
  ) {
    this.url = manifest.home
    this.remaining = [...c.fetch]
  }

  currentUrl(): string {
    return this.url
  }

  async goto(url: string): Promise<void> {
    const page = this.c.pages[url]
    if (page === undefined) throw this.miss(`No page for ${clip(url)} in the case.`)
    this.read(page)
    this.url = url
  }

  async fetch(url: string, init?: FetchInit): Promise<FetchResult> {
    const method = (init?.method ?? 'GET').toUpperCase()
    const target = new URL(url)
    const index = this.remaining.findIndex(
      (entry) => entry.method.toUpperCase() === method && this.matches(entry.url, target),
    )
    if (index === -1)
      throw this.miss(`No response for ${method} ${clip(target.pathname + target.search)} in the case.`)
    const [entry] = this.remaining.splice(index, 1)
    if (entry === undefined) throw this.miss('No response in the case.')
    return { status: entry.status, contentType: entry.contentType, body: this.body(entry) }
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
