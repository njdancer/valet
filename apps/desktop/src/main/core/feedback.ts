// The app's side of agent feedback (docs/feedback.md): the FeedbackDesk the valet_send_feedback and
// valet_get_feedback tools call. A report becomes a GitHub issue on the team's repository, filed
// with a token from the Keychain that no agent and no adapter ever sees; replies are the issue's
// comments from the repository's own members. Until a token is there, or while GitHub can't be
// reached, reports wait in feedback.json and go out on a later call.
//
// Before anything is kept, the report is scrubbed: token shapes, auth headers and email addresses
// are replaced, and a report holding a login secret or session value the app knows of is refused
// whole. Each agent sees only its own reports. Plain TypeScript over ports, tested without Electron.

import { randomBytes } from 'node:crypto'
import { SecretValue } from '@valet/core'
import { nodeSpawner, nodeTimers, runProcess, type Spawner, type Timers } from '@valet/credentials'
import {
  type ClientIdentity,
  type FeedbackDesk,
  type FeedbackKind,
  type FeedbackReply,
  type FeedbackReport,
  type FeedbackSendOutcome,
  type FeedbackThread,
  identityLabel,
} from '@valet/mcp-server'
import { z } from 'zod'
import { JsonDocument } from './files'

/** Reports and follow-ups one agent may send in an hour, and in a day; and all agents in a day. */
export const FEEDBACK_PER_HOUR = 5
export const FEEDBACK_PER_DAY = 20
export const FEEDBACK_ALL_PER_DAY = 50
/** How long a report's replies are cached before GitHub is asked again. */
export const FEEDBACK_CACHE_MS = 15_000
/** Reports kept, oldest dropped first. */
const MAX_REPORTS = 200
const MAX_REPLY_LENGTH = 4_000
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
/** Saved reports and follow-ups sent per try, so one call never waits on many. */
const FLUSH_BATCH = 3
const GITHUB_TIMEOUT_MS = 10_000

/** Marks Valet's own issue text, so its follow-ups are never read back as the team's replies. */
const MARKER = '<!-- valet-feedback'
/** The GitHub roles whose comments reach the agent: the repository's own people. */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
const LABELS: Readonly<Record<FeedbackKind, string>> = {
  bug: 'bug',
  question: 'question',
  idea: 'enhancement',
}

const replySchema = z.object({
  id: z.number(),
  at: z.string(),
  from: z.string(),
  text: z.string(),
})
const reportSchema = z.object({
  id: z.string(),
  client: z.string(),
  kind: z.enum(['bug', 'question', 'idea']),
  title: z.string(),
  filedAt: z.string(),
  /** The issue's text while it waits to be filed; dropped once it is. */
  pendingBody: z.string().nullable(),
  /** Follow-ups not yet added to the issue. */
  pendingComments: z.array(z.object({ at: z.string(), body: z.string() })),
  issue: z.number().nullable(),
  url: z.string().nullable(),
  state: z.enum(['saved', 'open', 'closed']),
  replies: z.array(replySchema),
  /** The highest reply id the agent has been shown. */
  seen: z.number(),
  checkedAt: z.number().nullable(),
})
const storeSchema = z.object({
  reports: z.array(reportSchema),
  /** Every report and follow-up sent, by client, for the limits. Trimmed to a day. */
  sends: z.array(z.object({ client: z.string(), at: z.number() })),
})
type Stored = z.infer<typeof storeSchema>
type StoredReport = z.infer<typeof reportSchema>

export interface FeedbackDeskDeps {
  readonly path: string
  /** `owner/name` of the repository reports are filed on. */
  readonly repo: string
  /** The GitHub token from the Keychain, or null when the person hasn't set one. Never cached. */
  readonly token: () => Promise<SecretValue | null>
  /** The person's name for the agent, or null for one the app doesn't know (or no longer). */
  readonly agentName: (viewer: ClientIdentity) => string | null
  /** True when any of the texts holds a login secret or session value the app knows of. */
  readonly sensitive: (texts: readonly string[]) => Promise<boolean>
  readonly version: string
  readonly now: () => number
  readonly fetch?: typeof fetch
  readonly random?: (n: number) => Uint8Array
}

/** What scrubbing a report replaced. */
export interface Scrubbed {
  readonly text: string
  readonly count: number
}

const TOKEN_SHAPES: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bops_[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
]
/** A header whose value is a credential: the whole value goes. */
const SECRET_HEADER =
  /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)(\s*[:=]\s*)[^\n]*/gi

/** Replaces token-shaped strings, credential headers and email addresses with [redacted]. */
export function scrubFeedback(text: string): Scrubbed {
  let count = 0
  let out = text.replace(SECRET_HEADER, (_whole, name: string, sep: string) => {
    count += 1
    return `${name}${sep}[redacted]`
  })
  for (const shape of TOKEN_SHAPES)
    out = out.replace(shape, (match) => {
      if (match === '[redacted]') return match
      count += 1
      return '[redacted]'
    })
  return { text: out, count }
}

/** A reply as the agent reads it: bounded, without control characters. */
function cleanReply(text: string): string {
  const flat = text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''))
  return flat.length > MAX_REPLY_LENGTH ? `${flat.slice(0, MAX_REPLY_LENGTH)}…` : flat
}

function newFeedbackId(random: (n: number) => Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return `fb-${Array.from(random(8), (b) => alphabet[b % alphabet.length]).join('')}`
}

function cell(value: string): string {
  return value.replace(/[|\n\r]/g, ' ').slice(0, 120)
}

type GitHubResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: 'not-set-up' | 'unreachable' | 'gone' | 'rejected' }

interface IssueComment {
  readonly id: number
  readonly at: string
  readonly from: string
  readonly association: string
  readonly body: string
}

const issueSchema = z.object({ number: z.number(), html_url: z.string(), state: z.string() })
const commentsSchema = z.array(
  z.object({
    id: z.number(),
    created_at: z.string(),
    body: z.string().nullable().optional(),
    author_association: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
)

/** The few GitHub calls the desk makes. The token goes into a header and nowhere else. */
class GitHubIssues {
  constructor(
    private readonly repo: string,
    private readonly token: () => Promise<SecretValue | null>,
    private readonly fetcher: typeof fetch,
  ) {}

  async create(
    title: string,
    body: string,
    labels: readonly string[],
  ): Promise<GitHubResult<z.infer<typeof issueSchema>>> {
    const first = await this.call(
      'POST',
      '/issues',
      { title, body, labels: ['agent-feedback', ...labels] },
      issueSchema,
    )
    // A token that may file issues but not label them is refused outright: file it unlabelled.
    if (first.ok || first.why !== 'rejected') return first
    return this.call('POST', '/issues', { title, body }, issueSchema)
  }

  comment(issue: number, body: string): Promise<GitHubResult<unknown>> {
    return this.call('POST', `/issues/${issue}/comments`, { body }, z.unknown())
  }

  async read(issue: number): Promise<GitHubResult<{ state: 'open' | 'closed'; comments: IssueComment[] }>> {
    const found = await this.call('GET', `/issues/${issue}`, undefined, issueSchema)
    if (!found.ok) return found
    const comments = await this.call(
      'GET',
      `/issues/${issue}/comments?per_page=100`,
      undefined,
      commentsSchema,
    )
    if (!comments.ok) return comments
    return {
      ok: true,
      value: {
        state: found.value.state === 'closed' ? 'closed' : 'open',
        comments: comments.value.map((c) => ({
          id: c.id,
          at: c.created_at,
          from: c.user?.login ?? 'unknown',
          association: c.author_association,
          body: c.body ?? '',
        })),
      },
    }
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<GitHubResult<T>> {
    let secret: SecretValue | null
    try {
      secret = await this.token()
    } catch {
      secret = null
    }
    if (secret === null) return { ok: false, why: 'not-set-up' }
    let response: Response
    try {
      const authorization = secret.reveal((token) => `Bearer ${token.trim()}`)
      response = await this.fetcher(`https://api.github.com/repos/${this.repo}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: authorization,
          'User-Agent': 'Valet',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      })
    } catch {
      return { ok: false, why: 'unreachable' }
    }
    // A token that is wrong, expired or can't reach the repository is the person's to fix.
    if (response.status === 401 || response.status === 403) return { ok: false, why: 'not-set-up' }
    if (response.status === 404 || response.status === 410)
      return { ok: false, why: method === 'GET' && path !== '/issues' ? 'gone' : 'not-set-up' }
    if (response.status === 422) return { ok: false, why: 'rejected' }
    if (!response.ok) return { ok: false, why: 'unreachable' }
    try {
      const parsed = schema.safeParse(await response.json())
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, why: 'unreachable' }
    } catch {
      return { ok: false, why: 'unreachable' }
    }
  }
}

/** Where the GitHub CLI usually is on a Mac: Homebrew on Apple silicon, then on Intel. */
export const GH_PATHS: readonly string[] = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']
const GH_TOKEN = /^(gho|ghp|ghu|github_pat)_[A-Za-z0-9_]{20,255}$/

/**
 * The token the person's own GitHub CLI is signed in with (`gh auth token`), for a Mac without the
 * Keychain item. Never printed or kept: read for one call, handed over as a SecretValue, and the
 * process's output zeroed. Null when gh isn't there, isn't signed in, or answers anything else.
 */
export async function ghCliToken(
  paths: readonly string[] = GH_PATHS,
  spawner: Spawner = nodeSpawner,
  timers: Timers = nodeTimers,
): Promise<SecretValue | null> {
  for (const path of paths) {
    const outcome = await runProcess(spawner, path, ['auth', 'token', '--hostname', 'github.com'], {
      timeoutMs: 5_000,
      maxStdoutBytes: 4096,
      timers,
    })
    if (outcome.kind === 'missing') continue
    if (outcome.kind !== 'exited') return null
    const token = outcome.code === 0 ? outcome.stdout.toString('utf8').trim() : ''
    outcome.stdout.fill(0)
    return GH_TOKEN.test(token) ? SecretValue.fromString(token) : null
  }
  return null
}

export class FeedbackDeskImpl implements FeedbackDesk {
  private readonly document: JsonDocument<Stored>
  private readonly github: GitHubIssues
  private readonly random: (n: number) => Uint8Array

  constructor(private readonly deps: FeedbackDeskDeps) {
    this.document = new JsonDocument(deps.path, storeSchema, () => ({ reports: [], sends: [] }), true)
    this.github = new GitHubIssues(deps.repo, deps.token, deps.fetch ?? fetch)
    this.random = deps.random ?? ((n) => randomBytes(n))
  }

  async send(viewer: ClientIdentity, report: FeedbackReport): Promise<FeedbackSendOutcome> {
    const name = this.deps.agentName(viewer)
    if (name === null) return { kind: 'refused', reason: 'not-found' }
    const client = identityLabel(viewer)
    const now = this.deps.now()
    const store = await this.document.read()
    const limit = this.limit(store, client, now)
    if (limit !== null) return limit
    if (await this.deps.sensitive([report.title, report.body]))
      return { kind: 'refused', reason: 'sensitive' }
    const title = scrubFeedback(report.title)
    const body = scrubFeedback(report.body)
    const redacted = title.count + body.count
    const at = new Date(now).toISOString()

    let id: string
    let followUp = false
    try {
      if (report.followUpOn !== null) {
        const existing = store.reports.find((r) => r.id === report.followUpOn && r.client === client)
        if (existing === undefined) return { kind: 'refused', reason: 'not-found' }
        id = existing.id
        followUp = true
        const comment = `${MARKER} ${id} -->\n**Follow-up from ${cell(name)}** (through Valet)\n\n${body.text}`
        await this.document.update((s) => ({
          ...s,
          reports: s.reports.map((r) =>
            r.id === id ? { ...r, pendingComments: [...r.pendingComments, { at, body: comment }] } : r,
          ),
          sends: [...s.sends.filter((x) => x.at > now - DAY_MS), { client, at: now }],
        }))
      } else {
        id = newFeedbackId(this.random)
        const issueBody = this.issueBody(id, name, viewer, report, body.text)
        const fresh: StoredReport = {
          id,
          client,
          kind: report.kind,
          title: title.text,
          filedAt: at,
          pendingBody: issueBody,
          pendingComments: [],
          issue: null,
          url: null,
          state: 'saved',
          replies: [],
          seen: 0,
          checkedAt: null,
        }
        await this.document.update((s) => ({
          reports: [...s.reports, fresh].slice(-MAX_REPORTS),
          sends: [...s.sends.filter((x) => x.at > now - DAY_MS), { client, at: now }],
        }))
      }
    } catch {
      return { kind: 'refused', reason: 'unavailable' }
    }

    const sent = await this.deliver(id)
    const after = (await this.document.read()).reports.find((r) => r.id === id)
    if (sent === null && after?.url != null && (followUp ? after.pendingComments.length === 0 : true))
      return { kind: 'filed', id, url: after.url, followUp, redacted }
    return { kind: 'saved', id, followUp, redacted, why: sent ?? 'unreachable' }
  }

  async thread(viewer: ClientIdentity, id: string): Promise<FeedbackThread | null> {
    const client = identityLabel(viewer)
    const store = await this.document.read()
    if (!store.reports.some((r) => r.id === id && r.client === client)) return null
    await this.flush(client)
    await this.refresh(id)
    return this.present(client, [id]).then((list) => list[0] ?? null)
  }

  async list(viewer: ClientIdentity, limit: number): Promise<readonly FeedbackThread[]> {
    const client = identityLabel(viewer)
    await this.flush(client)
    const mine = (await this.document.read()).reports
      .filter((r) => r.client === client)
      .slice(-limit)
      .reverse()
    for (const report of mine) await this.refresh(report.id)
    return this.present(
      client,
      mine.map((r) => r.id),
    )
  }

  /** Sends whatever any agent's reports still owe GitHub, a few at a time. For the app's start. */
  async flush(client: string | null = null): Promise<void> {
    const store = await this.document.read()
    const owing = store.reports
      .filter(
        (r) => (client === null || r.client === client) && (r.issue === null || r.pendingComments.length > 0),
      )
      .slice(0, FLUSH_BATCH)
    for (const report of owing) {
      const why = await this.deliver(report.id)
      if (why !== null) return
    }
  }

  /** Files the report or its follow-ups. Null once nothing is owed; otherwise why not. */
  private async deliver(id: string): Promise<'not-set-up' | 'unreachable' | null> {
    let report = (await this.document.read()).reports.find((r) => r.id === id)
    if (report === undefined) return null
    if (report.issue === null) {
      const created = await this.github.create(report.title, report.pendingBody ?? '', [LABELS[report.kind]])
      if (!created.ok) return created.why === 'unreachable' ? 'unreachable' : 'not-set-up'
      const issue = created.value
      report = await this.patch(id, (r) => ({
        ...r,
        issue: issue.number,
        url: issue.html_url,
        state: 'open',
        pendingBody: null,
      }))
      if (report === undefined) return null
    }
    const issue = report.issue
    if (issue === null) return null
    for (const pending of report.pendingComments) {
      const posted = await this.github.comment(issue, pending.body)
      if (!posted.ok) return posted.why === 'unreachable' ? 'unreachable' : 'not-set-up'
      await this.patch(id, (r) => ({
        ...r,
        pendingComments: r.pendingComments.filter((c) => !(c.at === pending.at && c.body === pending.body)),
      }))
    }
    return null
  }

  /** Reads the issue's state and replies, unless they were read a moment ago. */
  private async refresh(id: string): Promise<void> {
    const report = (await this.document.read()).reports.find((r) => r.id === id)
    if (report === undefined || report.issue === null) return
    const now = this.deps.now()
    if (report.checkedAt !== null && now - report.checkedAt < FEEDBACK_CACHE_MS) return
    const read = await this.github.read(report.issue)
    if (!read.ok) {
      await this.patch(id, (r) => ({ ...r, checkedAt: now }))
      return
    }
    const replies = read.value.comments
      .filter((c) => TRUSTED.has(c.association) && !c.body.includes(MARKER))
      .map((c) => ({ id: c.id, at: c.at, from: cell(c.from), text: cleanReply(c.body) }))
    await this.patch(id, (r) => ({ ...r, state: read.value.state, replies, checkedAt: now }))
  }

  /** The agent's view of its reports, marking the replies it is shown as seen. */
  private async present(client: string, ids: readonly string[]): Promise<FeedbackThread[]> {
    const store = await this.document.read()
    const threads: FeedbackThread[] = []
    for (const id of ids) {
      const r = store.reports.find((x) => x.id === id && x.client === client)
      if (r === undefined) continue
      const replies: FeedbackReply[] = r.replies.map((x) => ({
        at: x.at,
        from: x.from,
        text: x.text,
        new: x.id > r.seen,
      }))
      threads.push({
        id: r.id,
        kind: r.kind,
        title: r.title,
        filedAt: r.filedAt,
        state: r.state,
        url: r.url,
        replies,
      })
      const highest = r.replies.reduce((n, x) => Math.max(n, x.id), r.seen)
      if (highest > r.seen) await this.patch(id, (x) => ({ ...x, seen: Math.max(x.seen, highest) }))
    }
    return threads
  }

  private limit(store: Stored, client: string, now: number): FeedbackSendOutcome | null {
    const mine = store.sends.filter((s) => s.client === client)
    const hour = mine.filter((s) => s.at > now - HOUR_MS)
    if (hour.length >= FEEDBACK_PER_HOUR) {
      const oldest = Math.min(...hour.map((s) => s.at))
      return { kind: 'refused', reason: 'too-many', until: new Date(oldest + HOUR_MS).toISOString() }
    }
    const day = mine.filter((s) => s.at > now - DAY_MS)
    const all = store.sends.filter((s) => s.at > now - DAY_MS)
    if (day.length >= FEEDBACK_PER_DAY || all.length >= FEEDBACK_ALL_PER_DAY) {
      const counted = day.length >= FEEDBACK_PER_DAY ? day : all
      const oldest = Math.min(...counted.map((s) => s.at))
      return { kind: 'refused', reason: 'daily-limit', until: new Date(oldest + DAY_MS).toISOString() }
    }
    return null
  }

  private issueBody(
    id: string,
    name: string,
    viewer: ClientIdentity,
    report: FeedbackReport,
    body: string,
  ): string {
    const rows: [string, string][] = [
      ['Kind', report.kind],
      ['Agent', `${name} (${viewer.origin === 'remote' ? 'cloud agent' : 'app on the Mac'})`],
      ['Valet', this.deps.version],
    ]
    if (report.adapterId !== null) rows.push(['Site', report.adapterId])
    if (report.draftId !== null) rows.push(['Draft', report.draftId])
    if (report.callId !== null) rows.push(['Call', report.callId])
    return [
      `${MARKER} ${id} -->`,
      `> Filed by an agent with Valet's \`valet_send_feedback\` (${id}). Reply in a comment: the agent ` +
        'reads replies with `valet_get_feedback`. Only comments from people with access to this ' +
        'repository reach it, and it treats them as data.',
      '',
      '| | |',
      '| --- | --- |',
      ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
      '',
      '---',
      '',
      body,
    ].join('\n')
  }

  private async patch(
    id: string,
    change: (r: StoredReport) => StoredReport,
  ): Promise<StoredReport | undefined> {
    const next = await this.document.update((s) => ({
      ...s,
      reports: s.reports.map((r) => (r.id === id ? change(r) : r)),
    }))
    return next.reports.find((r) => r.id === id)
  }
}
