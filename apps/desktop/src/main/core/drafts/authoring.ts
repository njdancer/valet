// The app's side of the authoring tools (docs/authoring-tools.md): drafts on disk, Valet's checks,
// the agent's cases in the sandbox, and submit through the approval broker. Electron-free: the
// service gives it the builder (C's prepare, describing in a one-shot sandbox window), the sandbox
// factory for cases, what is installed and approved, and the broker's side of a submit.

import { isIP } from 'node:net'
import type { LoadedPackage } from '@valet/adapter-store'
import type { AuthStep } from '@valet/core'
import {
  type AdapterManifest,
  type AuditEvent,
  bundleHash,
  DEPENDENCY_LOCK,
  type DependencyLock,
  dependencyLockSchema,
  EMPTY_LOCK,
  homeUnreachable,
  isDisplayText,
  needsYouTitle,
  type PackageFiles,
  type PermissionChange,
  parseManifest,
  runtimeOf,
  sha256Hex,
} from '@valet/core'
import {
  type AskReport,
  type Authoring,
  AuthoringRefusal,
  type BrowserQuery,
  type BrowserTarget,
  type BrowserView,
  type Captured,
  type CheckReport,
  type ClientIdentity,
  type DependencyReport,
  type DiffReport,
  type DraftDetail,
  type DraftList,
  type NetworkBody,
  type NetworkLog,
  type Repair,
  type RepairList,
  type SubmitReport,
  type TrialReport,
} from '@valet/mcp-server'
import { type AddResult, DependencyError } from '@valet/node-runtime'
import type { ToolProcessFactory } from '@valet/runtime'
import { isPublicAddress, NO_LOCAL_ACCESS } from '@valet/sandbox'
import { type CaseBrowser, type CaseRun, readCases, runCase, runCases } from './cases'
import { type DraftChanges, draftChanges } from './changes'
import {
  caseFindings,
  checkNames,
  checkVersion,
  type Finding,
  fixtureProvenance,
  lint,
  siteDomain,
} from './checks'
import { draftFromExample, EXAMPLES, type Example } from './examples'
import type { RepairTicket } from './repairs'
import {
  draftDomains,
  fixtureFits,
  type ResearchDeps,
  ResearchRefusal,
  type ScratchHandle,
  type ScratchSessions,
  scrubBody,
  scrubUrl,
} from './research'
import { siteInputType, siteMethod, siteMime, siteRole, siteTag } from './site-text'
import {
  DRAFT_LIMITS,
  DraftError,
  type DraftRecord,
  type DraftStore,
  type LoginTrialSummary,
  type TrialSummary,
} from './store'
import { blankDraft, blankHttpDraft, blankProtocolDraft, blankRawDraft, type DraftProtocol } from './template'
import { runTrial, type SignedInTrial, TRIAL_LIMITS, type TrialDeps, type TrialResult } from './trial'

/** A whole check's time, so a submit answers inside an MCP client's usual timeout. */
export const CHECK_BUDGET_MS = 45_000
export const CHECKS_PER_CLIENT_PER_HOUR = 20
export const NOTIFY_PER_CLIENT_PER_HOUR = 10
/** Each one asks the npm registry for packages, so they are paced like checks. */
export const DEPENDENCIES_PER_CLIENT_PER_HOUR = 30

export interface InstalledVersion {
  readonly manifest: AdapterManifest
  readonly hash: string
  readonly files: PackageFiles
}

/** What a submit asks of the service: stage the frozen version and ask the person. */
export interface SubmitRequest {
  readonly draftId: string
  readonly loaded: LoadedPackage
  readonly files: PackageFiles
  readonly requester: { readonly clientId: string; readonly clientName: string }
  readonly agentNote: string | null
  readonly references: readonly string[]
  readonly repairId: string | null
  /** Valet's own check lines, and the agent's cases (B: their own field, never in checks). */
  readonly checks: readonly string[]
  readonly agentTests: { readonly passed: number; readonly failed: number }
  readonly domain: string
  /** The draft's earlier waiting request, which the new one replaces once it is made. */
  readonly replaces: string | null
}

export type SubmitOutcome =
  | {
      readonly ok: true
      readonly requestId: string
      readonly ref: string
      readonly expiresAt: string
      readonly previousHash: string | null
      /** The staged version wasn't stored before, so it may be dropped when the request closes. */
      readonly stagedNew: boolean
    }
  | { readonly ok: false; readonly sentence: string }

export interface PrivateNetworkRequest {
  readonly draftId: string
  readonly adapterId: string
  readonly address: string
  readonly port: number | null
  readonly minutes: number
  readonly requester: { readonly clientId: string; readonly clientName: string }
}

export interface SessionRequest {
  readonly draftId: string
  readonly adapterId: string
  /** The installed adapter's https origins, as the card lists them. */
  readonly origins: readonly string[]
  readonly minutes: number
  readonly requester: { readonly clientId: string; readonly clientName: string }
}

/** An agent's ask for a browser grant (docs/browser-grants.md): signed-in, read-only browsing. */
export interface GrantRequest extends SessionRequest {
  /** The agent's own words for why, shown as theirs. */
  readonly purpose: string
}

export type AskOutcome =
  | { readonly ok: true; readonly requestId: string; readonly ref: string; readonly expiresAt: string }
  | { readonly ok: false; readonly sentence: string }

export interface RequestState {
  readonly state: 'pending' | 'approved' | 'declined' | 'expired' | 'withdrawn' | 'unknown'
  readonly note: string | null
}

export interface AuthoringDeps {
  readonly store: DraftStore
  /** Checks, compiles and describes in a one-shot sandbox window; stores nothing. Throws with a sentence. */
  readonly prepare: (files: PackageFiles) => Promise<LoadedPackage>
  /** A fresh sandbox process per case (SandboxPool.oneShot()). */
  readonly caseProcess: ToolProcessFactory
  /** A fresh Node runtime process with no network, per case of a raw draft. Without it, none run. */
  readonly rawCaseProcess?: ToolProcessFactory
  /** The examples a draft may start from; the embedded ones when unset (tests set their own). */
  readonly examples?: ReadonlyMap<string, Example>
  readonly installed: (adapterId: string) => Promise<InstalledVersion | null>
  /** Repair tickets (PR 3), from the audit log. Without them no draft can be a repair. */
  readonly repairs?: {
    get(id: string): RepairTicket | null
    list(): readonly RepairTicket[]
  }
  /** The version the person last approved, which the card diffs against; null for none. */
  readonly approved: (
    adapterId: string,
  ) => Promise<{ readonly manifest: AdapterManifest; readonly hash: string } | null>
  readonly sites: () => readonly { readonly id: string; readonly name: string }[]
  /** The card's permission lines (D's installSubject), from the approved manifest to the draft's. */
  readonly permissionLines: (
    before: AdapterManifest | null,
    after: AdapterManifest,
  ) => readonly PermissionChange[]
  readonly submit: (request: SubmitRequest) => Promise<SubmitOutcome>
  readonly withdraw: (requestId: string) => Promise<void>
  /**
   * Asks the person to let the draft's scratch browser and live trials reach one private address
   * (B's private-network kind, R21). The broker's own refusals come back as a sentence.
   */
  readonly askPrivateNetwork?: (request: PrivateNetworkRequest) => Promise<AskOutcome>
  /**
   * Asks the person to let the draft's live trials use the installed adapter's session for a while
   * (B's authoring-session kind, D81).
   */
  readonly askSession?: (request: SessionRequest) => Promise<AskOutcome>
  /** Asks for a browser grant: the draft's scratch browser signed in, read only. */
  readonly askGrant?: (request: GrantRequest) => Promise<AskOutcome>
  /** The draft's approved signed-in session, while it lasts; null for none. */
  readonly sessionFor?: (draftId: string) => { readonly adapterId: string; readonly until: number } | null
  readonly requestState: (requestId: string) => RequestState
  /** The person's name for a client, for the draft record. */
  readonly clientName: (viewer: ClientIdentity) => string
  readonly audit: (event: AuditEvent) => Promise<void>
  /** A Notify-tier message for the person (Mac and phone). Fixed wording from here. */
  readonly notify: (text: string) => void
  readonly now: () => number
  readonly checkBudgetMs?: number
  /** The scratch browsers (PR 2); without them the research tools say this build has none. */
  readonly research?: ScratchSessions
  /** The fixture browser for cases with pages; without it those cases fail, saying so. */
  readonly caseBrowser?: (
    pages: Readonly<Record<string, string>>,
    egress: readonly string[],
  ) => Promise<CaseBrowser>
  /** Live trials (PR 2b); without them valet_live_trial says this build has none. */
  readonly trials?: TrialDeps & { readonly signedIn: ResearchDeps['signedIn'] }
  /**
   * npm dependencies for raw drafts (docs/node-runtime.md#dependencies): resolves, fetches and keeps
   * the tarballs. Without it valet_add_dependency says this build can't.
   */
  readonly dependencies?: {
    add(lock: DependencyLock, name: string, range: string | undefined): Promise<AddResult>
  }
  /**
   * Login trials (docs/authoring-tools.md#repairing-an-installed-adapter): a login session for the
   * installed adapter (login-session.ts), in a trial's own new in-memory partitions, runs
   * assertLoggedIn alone, then the draft's steps, then assertLoggedIn again. Throws AuthoringRefusal when no session opens (developer mode is off, say).
   * Absent in a build that can't open login sessions: a changed login is then a caution, not a
   * requirement, since nothing could meet it.
   */
  readonly loginTrial?: (request: LoginTrialRequest) => Promise<LoginTrialResult>
}

export interface LoginTrialRequest {
  readonly adapterId: string
  readonly draftId: string
  /** Names the trial's own in-memory partitions, as a live trial's label does. */
  readonly label: string
  readonly steps: readonly AuthStep[]
  readonly clientName: string
}

/** How a login trial ended: in codes, as a login session's batches report. */
export type LoginTrialResult =
  | { readonly kind: 'signed-in' }
  /** assertLoggedIn passed before any step ran: the steps would prove nothing. */
  | { readonly kind: 'signed-in-before' }
  /** A batch stopped: the steps, or the check before or after them. */
  | {
      readonly kind: 'stopped'
      readonly at: 'before' | 'steps' | 'after'
      readonly status: 'needsUser' | 'failed' | 'blocked'
      readonly reason: string | null
      readonly stage: string | null
      readonly errorClass: string | null
    }

interface CheckOutcome {
  readonly report: CheckReport
  readonly loaded: LoadedPackage | null
  readonly files: PackageFiles
  readonly run: CaseRun | null
}

export class DraftAuthoring implements Authoring {
  private readonly checks = new Map<string, number[]>()
  private readonly notifies = new Map<string, number[]>()
  private readonly dependencyAdds = new Map<string, number[]>()
  /** One check at a time in all; a client waiting behind another's is told so. */
  private checking: Promise<unknown> = Promise.resolve()
  private readonly checkingClients = new Set<string>()
  private readonly submitting = new Set<string>()
  /**
   * Per draft, its last check and what it depended on: a check of the same package against the same
   * state is answered from here, and not counted against the hourly checks.
   */
  private readonly lastChecks = new Map<
    string,
    { readonly key: string; readonly at: number; readonly outcome: CheckOutcome }
  >()
  /** Per draft and path, the hash of the last write through these tools (edited outside Valet). */
  private readonly written = new Map<string, string>()
  /** Per draft, the times of its trials this hour. */
  private readonly trialTimes = new Map<string, number[]>()
  private readonly trialing = new Set<string>()
  private trialCount = 0

  constructor(private readonly deps: AuthoringDeps) {}

  // ---------- Drafts ----------

  async createDraft(
    viewer: ClientIdentity,
    request: {
      readonly adapterId: string
      readonly from: 'blank' | 'installed' | 'example'
      readonly name?: string
      readonly repairId?: string
      readonly runtime?: 'browser' | 'http' | 'protocol' | 'raw'
      /** For a blank protocol draft: which protocol it speaks. */
      readonly protocol?: DraftProtocol
      /** With from "example": which one (valet_authoring_guide lists them). */
      readonly example?: string
    },
  ): Promise<DraftDetail> {
    const client = clientKey(viewer)
    const all = await this.deps.store.list()
    if (all.filter((d) => d.createdBy === client).length >= DRAFT_LIMITS.perClient)
      throw new AuthoringRefusal(`Not started: you have ${DRAFT_LIMITS.perClient} drafts. Delete one first.`)
    if (all.length >= DRAFT_LIMITS.total)
      throw new AuthoringRefusal(
        'Not started: Valet holds as many drafts as it keeps. Ask the person to delete some.',
      )
    // A protocol names its kind, so runtime may be left out with it; nothing else takes one.
    const runtime = request.runtime ?? (request.protocol === undefined ? undefined : 'protocol')
    if (runtime === 'protocol' && request.protocol === undefined && request.from === 'blank')
      throw new AuthoringRefusal(
        'Not started: a protocol draft needs protocol "imap" (read or change mail), "smtp" (send mail) or "sftp" (files on a server).',
      )
    if (request.protocol !== undefined && (runtime !== 'protocol' || request.from !== 'blank'))
      throw new AuthoringRefusal(
        'Not started: protocol is only for a blank draft whose runtime is "protocol" (or left out).',
      )
    const installed = await this.deps.installed(request.adapterId)
    if (request.repairId !== undefined) {
      const ticket = this.deps.repairs?.get(request.repairId) ?? null
      if (ticket === null || ticket.adapterId !== request.adapterId)
        throw new AuthoringRefusal(
          `No repair ticket ${request.repairId} for ${request.adapterId}. valet_list_repairs lists them.`,
        )
      if (ticket.state !== 'open')
        throw new AuthoringRefusal(`${ticket.id} is closed: a later call of ${ticket.tool} worked.`)
      if (request.from !== 'installed')
        throw new AuthoringRefusal('A repair starts from the installed adapter: from "installed".')
    }
    let files: PackageFiles
    let basedOn: string | null = null
    if (request.from === 'installed') {
      if (installed === null)
        throw new AuthoringRefusal(`No site with the id ${request.adapterId} is installed.`)
      files = installed.files
      basedOn = installed.hash
    } else {
      if (installed !== null)
        throw new AuthoringRefusal(
          `${request.adapterId} is installed already. Start from "installed" to update it, or pick another id.`,
        )
      const name = request.name ?? request.adapterId
      const examples = this.deps.examples ?? EXAMPLES
      const example = request.example === undefined ? undefined : examples.get(request.example)
      if (request.from === 'example' && example === undefined)
        throw new AuthoringRefusal(
          `No example ${JSON.stringify(clip(request.example ?? '', 40))}. The examples are: ${[...examples.keys()].join(', ')}.`,
        )
      files =
        example !== undefined && request.from === 'example'
          ? draftFromExample(example, request.adapterId, request.name)
          : runtime === 'http'
            ? blankHttpDraft(request.adapterId, name)
            : runtime === 'raw'
              ? blankRawDraft(request.adapterId, name)
              : runtime === 'protocol' && request.protocol !== undefined
                ? blankProtocolDraft(request.adapterId, name, request.protocol)
                : blankDraft(request.adapterId, name)
    }
    this.notifyLimit(client)
    const record = await this.wrap(() =>
      this.deps.store.create(
        {
          adapterId: request.adapterId,
          createdBy: client,
          createdByName: this.deps.clientName(viewer).slice(0, 100),
          basedOn,
          repairId: request.repairId ?? null,
        },
        files,
      ),
    )
    for (const [path, text] of Object.entries(files))
      this.written.set(`${record.id}:${path}`, sha256Hex(text))
    await this.deps.audit({
      type: 'draft-created',
      draftId: record.id,
      adapterId: record.adapterId,
      clientId: client,
    })
    this.deps.notify(
      request.from === 'installed'
        ? `${record.createdByName} started a draft update of ${request.adapterId}.`
        : `${record.createdByName} started a draft adapter, ${request.adapterId}.`,
    )
    return this.detail(record)
  }

  async listDrafts(viewer: ClientIdentity, all: boolean): Promise<DraftList> {
    const client = clientKey(viewer)
    const drafts = (await this.deps.store.list())
      .filter((d) => all || d.createdBy === client)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { drafts: await Promise.all(drafts.map(async (d) => this.summary(await this.refreshed(d)))) }
  }

  // ---------- The private network ----------

  async requestPrivateNetwork(
    viewer: ClientIdentity,
    draftId: string,
    request: { readonly address: string; readonly port: number | null; readonly minutes: number },
  ): Promise<AskReport> {
    const record = await this.own(viewer, draftId)
    const ask = this.deps.askPrivateNetwork
    if (ask === undefined) throw new AuthoringRefusal('This build of Valet can’t reach a private network.')
    if (!isIP(request.address))
      throw new AuthoringRefusal('Give the address as an IP address, e.g. 192.168.1.20.')
    if (isPublicAddress(request.address))
      throw new AuthoringRefusal('That address is public: the scratch browser reaches it without asking.')
    const asked = await ask({
      draftId,
      adapterId: record.adapterId,
      address: request.address.toLowerCase(),
      port: request.port,
      minutes: Math.min(60, Math.max(1, Math.round(request.minutes))),
      requester: { clientId: clientKey(viewer), clientName: this.deps.clientName(viewer).slice(0, 100) },
    })
    if (!asked.ok) throw new AuthoringRefusal(`Not asked: ${asked.sentence}`)
    return {
      requestId: asked.requestId,
      ref: asked.ref,
      expiresAt: asked.expiresAt,
      tellThePerson: `I’ve asked Valet to let my draft reach ${request.address}${
        request.port === null ? '' : ` port ${request.port}`
      } on your network for ${request.minutes} minutes. Approve it on your phone or Mac (${asked.ref}).`,
    }
  }

  // ---------- Signed-in sessions ----------

  async requestSession(viewer: ClientIdentity, draftId: string, minutes: number): Promise<AskReport> {
    const ask = this.deps.askSession
    if (ask === undefined || this.deps.trials === undefined)
      throw new AuthoringRefusal('This build of Valet can’t lend a signed-in session.')
    const { record, installed, origins } = await this.sessionSite(viewer, draftId)
    const span = Math.min(60, Math.max(1, Math.round(minutes)))
    const asked = await ask({
      draftId,
      adapterId: record.adapterId,
      origins,
      minutes: span,
      requester: { clientId: clientKey(viewer), clientName: this.deps.clientName(viewer).slice(0, 100) },
    })
    if (!asked.ok) throw new AuthoringRefusal(`Not asked: ${asked.sentence}`)
    return {
      requestId: asked.requestId,
      ref: asked.ref,
      expiresAt: asked.expiresAt,
      tellThePerson:
        `I’ve asked Valet to let my live trials of the ${installed.manifest.name} draft use your signed-in ` +
        `session for ${span} minutes. I never see the session itself. Approve it on your phone or Mac (${asked.ref}).`,
    }
  }

  /**
   * A browser grant (docs/browser-grants.md): the draft's scratch browser opens signed in to the
   * installed adapter's site, read only, for up to two hours. The agent studies the signed-in
   * pages it is building tools for; it never sees the password or the session.
   */
  async requestGrant(
    viewer: ClientIdentity,
    draftId: string,
    minutes: number,
    purpose: string,
  ): Promise<AskReport> {
    const ask = this.deps.askGrant
    if (ask === undefined || this.deps.research === undefined)
      throw new AuthoringRefusal('This build of Valet can’t open a signed-in browser.')
    const why = purpose.replace(/\s+/g, ' ').trim()
    if (why.length < 3 || why.length > 200 || !isDisplayText(why))
      throw new AuthoringRefusal(
        'Say in a short plain sentence (up to 200 characters) why you need the site signed in.',
      )
    const { record, installed, origins } = await this.sessionSite(viewer, draftId)
    const span = Math.min(120, Math.max(1, Math.round(minutes)))
    const asked = await ask({
      draftId,
      adapterId: record.adapterId,
      origins,
      minutes: span,
      purpose: why,
      requester: { clientId: clientKey(viewer), clientName: this.deps.clientName(viewer).slice(0, 100) },
    })
    if (!asked.ok) throw new AuthoringRefusal(`Not asked: ${asked.sentence}`)
    return {
      requestId: asked.requestId,
      ref: asked.ref,
      expiresAt: asked.expiresAt,
      tellThePerson:
        `I’ve asked Valet to let me browse ${installed.manifest.name} signed in as you, read only, for ` +
        `${span} minutes, to build tools for it. I never see your password or session, and payment and ` +
        `security pages stay closed. Approve it on your phone or Mac (${asked.ref}); you can end it any time.`,
    }
  }

  /** The installed site a signed-in session or grant would be for, or a refusal saying why not. */
  private async sessionSite(viewer: ClientIdentity, draftId: string) {
    const record = await this.own(viewer, draftId)
    // Signed-in sessions stay local-only until a remote one has been red-teamed (B, F's design).
    if (viewer.origin !== 'local') throw new AuthoringRefusal(REMOTE_SIGNED_IN)
    const trials = this.deps.trials
    const installed = record.basedOn === null ? null : await this.deps.installed(record.adapterId)
    if (installed === null)
      throw new AuthoringRefusal(
        'A signed-in session is for updating or repairing an installed adapter: start the draft from "installed".',
      )
    const signedIn =
      trials === undefined
        ? new Map<string, readonly string[]>()
        : await trials.signedIn().catch(() => new Map<string, readonly string[]>())
    if (!signedIn.has(record.adapterId))
      throw new AuthoringRefusal(`The person isn’t signed in to ${installed.manifest.name} in Valet.`)
    const origins = [
      ...new Set(
        [installed.manifest.home, ...installed.manifest.navigation]
          .map((o) => {
            try {
              const url = new URL(o)
              return url.protocol === 'https:' ? url.origin : null
            } catch {
              return null
            }
          })
          .filter((o): o is string => o !== null),
      ),
    ].slice(0, 10)
    return { record, installed, origins }
  }

  // ---------- Repairs ----------

  async listRepairs(viewer: ClientIdentity): Promise<RepairList> {
    const tickets = this.deps.repairs?.list() ?? []
    const drafts = await this.deps.store.list()
    return { repairs: tickets.map((t) => this.repairView(viewer, t, drafts)) }
  }

  async getRepair(viewer: ClientIdentity, repairId: string): Promise<Repair> {
    const ticket = this.deps.repairs?.get(repairId) ?? null
    if (ticket === null)
      throw new AuthoringRefusal('No repair ticket has that id. valet_list_repairs lists them.')
    return this.repairView(viewer, ticket, await this.deps.store.list())
  }

  private repairView(viewer: ClientIdentity, t: RepairTicket, drafts: readonly DraftRecord[]): Repair {
    const client = clientKey(viewer)
    const mine = drafts.find((d) => d.repairId === t.id && d.createdBy === client)
    return {
      repairId: t.id,
      adapterId: t.adapterId,
      adapterHash: t.adapterHash,
      tool: t.tool,
      stage: t.stage,
      errorClass: t.errorClass,
      openedAt: t.openedAt,
      lastFailedAt: t.lastFailedAt,
      failures: t.failures,
      state: t.state,
      draftId: mine?.id ?? null,
    }
  }

  async getDraft(viewer: ClientIdentity, all: boolean, draftId: string): Promise<DraftDetail> {
    return this.detail(await this.refreshed(await this.readable(viewer, all, draftId)))
  }

  async readFile(viewer: ClientIdentity, all: boolean, draftId: string, path: string) {
    await this.readable(viewer, all, draftId)
    const files = await this.wrap(() => this.deps.store.files(draftId))
    if (!Object.hasOwn(files, path)) throw new AuthoringRefusal(`The draft has no file ${clip(path)}.`)
    return { path, content: files[path] ?? '' }
  }

  async writeFile(viewer: ClientIdentity, draftId: string, path: string, content: string) {
    const record = await this.own(viewer, draftId)
    await this.wrap(() => this.deps.store.write(draftId, path, content))
    this.written.set(`${draftId}:${path}`, sha256Hex(content))
    return { path, bytes: Buffer.byteLength(content, 'utf8'), draftStatus: record.status }
  }

  async deleteFile(viewer: ClientIdentity, draftId: string, path: string) {
    await this.own(viewer, draftId)
    const removed = await this.wrap(() => this.deps.store.remove(draftId, path))
    this.written.delete(`${draftId}:${path}`)
    return { path, removed }
  }

  async addDependency(
    viewer: ClientIdentity,
    draftId: string,
    request: { readonly name: string; readonly range?: string },
  ): Promise<DependencyReport> {
    const record = await this.own(viewer, draftId)
    const dependencies = this.deps.dependencies
    if (dependencies === undefined)
      throw new AuthoringRefusal('This build of Valet can’t add npm dependencies.')
    const files = await this.wrap(() => this.deps.store.files(draftId))
    let runtime: unknown
    try {
      runtime = (JSON.parse(files['manifest.json'] ?? '') as { runtime?: unknown }).runtime
    } catch {
      throw new AuthoringRefusal('Not added: manifest.json isn’t JSON yet.')
    }
    if (runtime !== 'raw')
      throw new AuthoringRefusal(
        'Not added: only a raw adapter (runtime "raw" in manifest.json) has npm dependencies. Browser, http and protocol adapters run in Valet’s own sandbox and import only zod, @valet/core and their own files.',
      )
    let lock: DependencyLock = EMPTY_LOCK
    const lockText = files[DEPENDENCY_LOCK]
    if (lockText !== undefined) {
      let parsed: ReturnType<typeof dependencyLockSchema.safeParse>
      try {
        parsed = dependencyLockSchema.safeParse(JSON.parse(lockText))
      } catch {
        throw new AuthoringRefusal(`Not added: ${DEPENDENCY_LOCK} isn’t JSON. Delete it to start again.`)
      }
      if (!parsed.success)
        throw new AuthoringRefusal(
          `Not added: ${DEPENDENCY_LOCK} isn’t valid (${parsed.error.issues[0]?.message ?? 'invalid'}). Delete it to start again.`,
        )
      lock = parsed.data
    }
    const client = clientKey(viewer)
    const now = this.deps.now()
    const recent = (this.dependencyAdds.get(client) ?? []).filter((t) => now - t < 3_600_000)
    if (recent.length >= DEPENDENCIES_PER_CLIENT_PER_HOUR)
      throw new AuthoringRefusal(
        `Not added: you have added ${DEPENDENCIES_PER_CLIENT_PER_HOUR} dependencies this hour. Try again later.`,
      )
    this.dependencyAdds.set(client, [...recent, now])
    let result: AddResult
    try {
      result = await dependencies.add(lock, request.name, request.range)
    } catch (error) {
      if (error instanceof DependencyError) throw new AuthoringRefusal(`Not added: ${error.message}.`)
      throw error
    }
    const text = `${JSON.stringify(result.lock, null, 2)}\n`
    await this.wrap(() => this.deps.store.write(draftId, DEPENDENCY_LOCK, text))
    this.written.set(`${draftId}:${DEPENDENCY_LOCK}`, sha256Hex(text))
    const at = result.resolved.lastIndexOf('@')
    return {
      name: result.resolved.slice(0, at),
      version: result.resolved.slice(at + 1),
      range: result.lock.dependencies[request.name]?.range ?? '*',
      packages: Object.keys(result.lock.packages).length,
      added: [...result.added],
      removed: [...result.removed],
      warnings: [...result.warnings],
      draftStatus: record.status,
    }
  }

  async deleteDraft(viewer: ClientIdentity, draftId: string) {
    const record = await this.own(viewer, draftId)
    if (record.status === 'waiting' && record.submission !== null)
      await this.deps.withdraw(record.submission.requestId).catch(() => undefined)
    this.deps.research?.close(draftId)
    await this.deps.store.delete(draftId)
    for (const key of [...this.written.keys()]) if (key.startsWith(`${draftId}:`)) this.written.delete(key)
    this.lastChecks.delete(draftId)
    await this.deps.audit({
      type: 'draft-deleted',
      draftId,
      adapterId: record.adapterId,
      clientId: clientKey(viewer),
    })
    return { draftId, deleted: true }
  }

  // ---------- Checks ----------

  async check(viewer: ClientIdentity, draftId: string, tool?: string): Promise<CheckReport> {
    const record = await this.own(viewer, draftId)
    const outcome = await this.runCheck(viewer, record, tool)
    return outcome.report
  }

  async diff(viewer: ClientIdentity, all: boolean, draftId: string): Promise<DiffReport> {
    const record = await this.readable(viewer, all, draftId)
    const files = await this.wrap(() => this.deps.store.files(draftId))
    let manifest: AdapterManifest
    try {
      manifest = (await this.deps.prepare(files)).manifest
    } catch (error) {
      throw new AuthoringRefusal(
        `The draft doesn’t build yet, so there’s nothing to compare: ${sentenceOf(error)}`,
      )
    }
    const approved = await this.deps.approved(record.adapterId)
    const installed = await this.deps.installed(record.adapterId)
    const before = installed?.files ?? {}
    const paths = new Set([...Object.keys(before), ...Object.keys(files)])
    const changed: DiffReport['files'] = []
    for (const path of [...paths].sort()) {
      const was = before[path]
      const now = files[path]
      if (was === undefined) changed.push({ path, change: 'added' })
      else if (now === undefined) changed.push({ path, change: 'removed' })
      else if (was !== now) changed.push({ path, change: 'changed' })
    }
    return {
      against: approved === null ? 'nothing' : 'approved',
      changes: lines(this.deps.permissionLines(approved?.manifest ?? null, manifest)),
      files: changed,
    }
  }

  /** Steps 1 to 6 on one in-memory copy of the files, within the check budget. */
  private async runCheck(viewer: ClientIdentity, record: DraftRecord, tool?: string): Promise<CheckOutcome> {
    const client = clientKey(viewer)
    const files = await this.wrap(() => this.deps.store.files(record.id))
    // Nothing changed since the last check (the package, the tool asked for, what is installed and
    // approved, the trials a repair's reproduction reads): the same answer, not counted again.
    const key = await this.checkKey(record, files, tool)
    const last = this.lastChecks.get(record.id)
    if (last !== undefined && last.key === key && this.deps.now() - last.at < 3600_000)
      return { ...last.outcome, report: { ...last.outcome.report, reused: true } }
    this.checkLimit(client)
    if (this.checkingClients.has(client))
      throw new AuthoringRefusal('One check at a time: your last one is still running.')
    this.checkingClients.add(client)
    const turn = this.checking.then(() => this.checkNow(record, files, tool))
    this.checking = turn.catch(() => undefined)
    try {
      const outcome = await turn
      this.lastChecks.set(record.id, { key, at: this.deps.now(), outcome })
      return outcome
    } finally {
      this.checkingClients.delete(client)
    }
  }

  /** What a check's answer depends on beyond the clock. */
  private async checkKey(record: DraftRecord, files: PackageFiles, tool?: string): Promise<string> {
    const installed = await this.deps.installed(record.adapterId)
    const approved = await this.deps.approved(record.adapterId)
    const ticket = record.repairId === null ? null : (this.deps.repairs?.get(record.repairId) ?? null)
    return JSON.stringify([
      bundleHash(files),
      tool ?? null,
      record.basedOn,
      installed?.hash ?? null,
      approved?.hash ?? null,
      record.repairId,
      ticket?.state ?? null,
      record.trials.map((t) => [t.packageHash, t.at, t.reproduces]),
      record.loginTrials.map((t) => [t.loginKey, t.at, t.ok]),
      this.deps.loginTrial === undefined,
      this.deps.sites().map((s) => s.id),
    ])
  }

  private async checkNow(record: DraftRecord, files: PackageFiles, tool?: string): Promise<CheckOutcome> {
    const started = this.deps.now()
    const budget = this.deps.checkBudgetMs ?? CHECK_BUDGET_MS
    const packageHash = bundleHash(files)
    const steps: { step: string; ok: boolean }[] = []
    const findings: Finding[] = []
    let changed: DraftChanges | null = null
    let login: CheckReport['login']
    const report = (
      loaded: LoadedPackage | null,
      run: CaseRun | null,
      changes: CheckReport['changes'],
    ): CheckOutcome => {
      const ok = steps.every((s) => s.ok) && !findings.some((f) => f.level === 'error')
      return {
        report: {
          ok,
          packageHash,
          adapterHash: loaded?.adapterHash ?? null,
          steps,
          findings: findings.map((f) => ({ ...f })),
          cases: (run?.results ?? []).map((r) => ({
            file: r.file,
            name: r.name,
            tool: r.tool,
            passed: r.passed,
            reason: r.reason,
          })),
          changes,
          unchangedTools: [...(changed?.unchangedTools ?? [])],
          ...(login === undefined ? {} : { login }),
        },
        loaded,
        files,
        run,
      }
    }
    // 1 and 2: the package rules, the manifest, compile, describe in the sandbox.
    let loaded: LoadedPackage
    try {
      loaded = await this.deps.prepare(files)
      steps.push({ step: 'package', ok: true }, { step: 'build', ok: true })
    } catch (error) {
      const sentence = sentenceOf(error)
      const packageStep =
        /package|manifest|path|file/i.test(sentence) && !/compile|describe|schema/i.test(sentence)
      steps.push({ step: packageStep ? 'package' : 'build', ok: false })
      findings.push({ level: 'error', check: packageStep ? 'package' : 'build', text: sentence })
      return this.saved(record, report(null, null, []))
    }
    const manifest = loaded.manifest
    if (manifest.id !== record.adapterId) {
      findings.push({
        level: 'error',
        check: 'names',
        text: `The manifest’s id must be ${record.adapterId}, the draft’s.`,
      })
    }
    const home = homeUnreachable(manifest)
    if (home !== null)
      findings.push({ level: 'error', check: 'package', text: `manifest.json: ${home}. ${HOME_FIX}` })
    const installed = await this.deps.installed(record.adapterId)
    if (installed !== null && record.basedOn === null)
      findings.push({
        level: 'error',
        check: 'names',
        text: `${record.adapterId} is installed now; only a draft started from "installed" may update it.`,
      })
    // 3: names and versions.
    findings.push(
      ...checkNames(manifest, this.deps.sites()),
      ...checkVersion(manifest, installed?.manifest ?? null),
    )
    steps.push({ step: 'names', ok: !findings.some((f) => f.level === 'error') })
    // 4: lint, never blocking.
    findings.push(...lint(manifest, files))
    steps.push({ step: 'lint', ok: true })
    // 5: the card's permission lines, against the approved version.
    const approved = await this.deps.approved(record.adapterId)
    const changes = lines(this.deps.permissionLines(approved?.manifest ?? null, manifest))
    steps.push({ step: 'diff', ok: true })
    // 6: the agent's cases, in the sandbox, with what's left of the budget.
    const left = Math.max(0, budget - (this.deps.now() - started))
    const run = await runCases({ manifest, script: loaded.script, tools: loaded.definition.tools }, files, {
      start: this.deps.caseProcess,
      ...(this.deps.rawCaseProcess === undefined ? {} : { rawStart: this.deps.rawCaseProcess }),
      local: NO_LOCAL_ACCESS,
      ...(tool === undefined ? {} : { tool }),
      ...(this.deps.caseBrowser === undefined ? {} : { browser: this.deps.caseBrowser }),
      deadline: started + budget,
      now: this.deps.now,
      timeoutMs: Math.min(5_000, Math.max(1, left)),
    })
    // A tool the draft leaves as installed needs no new case: it runs as the approved one does.
    changed = draftChanges(files, installed, record.basedOn !== null)
    const caseErrors = caseFindings(manifest, run, tool, changed.unchangedTools)
    findings.push(...caseErrors)
    steps.push({ step: 'cases', ok: !caseErrors.some((f) => f.level === 'error') })
    // 6b: login steps the draft changed, signed in with in a login trial.
    if (tool === undefined && changed.loginChanged) {
      const finding = this.loginFinding(record, changed)
      login = finding === null ? 'tried' : 'not-tried'
      if (finding !== null) findings.push(finding)
      steps.push({ step: 'login', ok: finding?.level !== 'error' })
    } else if (tool === undefined && record.basedOn !== null && installed !== null) login = 'unchanged'
    // 7, a repair's only: the ticket's failure, reproduced on what Valet recorded.
    if (record.repairId !== null && tool === undefined) {
      const problem = await this.reproduce(record, files, run, installed, started + budget)
      steps.push({ step: 'reproduction', ok: problem === null })
      if (problem !== null) findings.push({ level: 'error', check: 'reproduction', text: problem })
    }
    return this.saved(record, report(loaded, run, changes))
  }

  /**
   * A repair's reproduction check (docs/authoring-tools.md#repairs-pr-3): each case that names the
   * ticket uses only fixtures Valet recorded after it opened, fails on the installed version with
   * the ticket's stage and class, and passes on the draft. Null when it holds; else why not.
   */
  private async reproduce(
    record: DraftRecord,
    files: PackageFiles,
    run: CaseRun,
    installed: InstalledVersion | null,
    deadline: number,
  ): Promise<string | null> {
    const id = record.repairId ?? ''
    const ticket = this.deps.repairs?.get(id) ?? null
    if (ticket === null) return `Valet no longer has repair ticket ${id}.`
    if (installed === null) return `${record.adapterId} isn’t installed now, so there’s nothing to repair.`
    const current = await this.deps.store.require(record.id)
    // Behind a sign-in: a signed-in trial of this very package that Valet saw reproduce the ticket.
    const packageHash = bundleHash(files)
    const live = current.trials.some(
      (t) =>
        t.reproduces === id &&
        t.packageHash === packageHash &&
        Date.parse(t.at) >= Date.parse(ticket.openedAt),
    )
    if (live) return null
    const mine = readCases(files).cases.filter((c) => c.case.reproduces === id)
    if (mine.length === 0)
      return (
        `A repair needs a case with "reproduces": "${id}" that calls ${ticket.tool} on fixtures Valet ` +
        `recorded after ${id} opened (valet_capture_fixture). For a page behind the sign-in, run ` +
        `${ticket.tool} in a signed-in valet_live_trial of this version instead: Valet runs the installed ` +
        'version straight after, and its failing as the ticket says is the reproduction.'
      )
    let old: LoadedPackage
    try {
      old = await this.deps.prepare(installed.files)
    } catch {
      return 'Valet couldn’t load the installed version to compare with.'
    }
    for (const { file, case: c } of mine) {
      const named = `"${clip(c.name, 80)}"`
      if (c.tool !== ticket.tool)
        return `The case ${named} reproduces ${id}, which is about ${ticket.tool}, not ${c.tool}.`
      if (!('output' in c.expect)) return `The case ${named} must expect output: it shows the fix works.`
      const paths = [...Object.values(c.pages)]
      for (const f of c.fetch) {
        if (f.body !== undefined && typeof f.body !== 'string')
          return `The case ${named} has an inline body; a reproduction uses only what Valet recorded.`
        if (typeof f.body === 'string') paths.push(f.body)
      }
      if (paths.length === 0) return `The case ${named} uses no fixtures Valet recorded.`
      for (const path of paths) {
        const text = files[path]
        if (text === undefined || current.recorded[path] !== sha256Hex(text))
          return `The case ${named} uses ${path}, which isn’t as Valet recorded it: capture it again.`
        const at = current.recordedAt[path]
        if (at === undefined || Date.parse(at) < Date.parse(ticket.openedAt))
          return `The case ${named} uses ${path}, recorded before ${id} opened: capture it again.`
      }
      const mineNow = run.results.find((r) => r.file === file && r.name === c.name)
      if (mineNow?.passed !== true)
        return `The fix doesn’t handle the change in ${id}: ${named} fails on the draft.`
      const before = await runCase(
        { manifest: old.manifest, script: old.script, tools: old.definition.tools },
        files,
        file,
        { ...c, expect: { error: { stage: ticket.stage, errorClass: ticket.errorClass } } },
        {
          start: this.deps.caseProcess,
          ...(this.deps.rawCaseProcess === undefined ? {} : { rawStart: this.deps.rawCaseProcess }),
          local: NO_LOCAL_ACCESS,
          ...(this.deps.caseBrowser === undefined ? {} : { browser: this.deps.caseBrowser }),
          now: this.deps.now,
          timeoutMs: Math.min(5_000, Math.max(1, deadline - this.deps.now())),
        },
      )
      if (!before.passed)
        return (
          `The installed version doesn’t fail ${named} with ${ticket.stage}/${ticket.errorClass} as ${id} ` +
          'did, so the case doesn’t reproduce the change.'
        )
    }
    return null
  }

  /**
   * Check step 6b: changed login steps need a login trial that signed in with them, behind the
   * walls installed now. Null when one did; a caution when no trial could; an error otherwise.
   */
  private loginFinding(record: DraftRecord, changed: DraftChanges): Finding | null {
    if (this.deps.loginTrial === undefined)
      return {
        level: 'caution',
        check: 'login',
        text: 'The login steps changed, and this Valet can’t try login steps, so only the person’s review checks them.',
      }
    if (!changed.loginWallsSame)
      return {
        level: 'caution',
        check: 'login',
        text: 'The login steps changed along with what a login depends on (home, navigation, egress, secrets, session or auth.frameOrigins), so no login trial can try them: only the person’s review checks them.',
      }
    const trial = record.loginTrials.findLast((t) => t.loginKey === changed.loginKey)
    if (trial?.ok === true) return null
    return {
      level: 'error',
      check: 'login',
      text:
        trial === undefined
          ? 'The login steps changed: sign in with them first with valet_live_trial and login: true (it needs developer mode on in Valet).'
          : `The login steps changed, and their last login trial didn’t sign in: ${trial.problem ?? 'it failed'}`,
    }
  }

  /** Records the check on the draft (bound to its package hash) and returns it. */
  private async saved(record: DraftRecord, outcome: CheckOutcome): Promise<CheckOutcome> {
    const { report } = outcome
    const passed = outcome.run?.results.filter((r) => r.passed).length ?? 0
    const first = report.findings.find((f) => f.level === 'error')?.text ?? null
    await this.deps.store
      .update(record.id, (r) => ({
        ...r,
        lastCheck: {
          packageHash: report.packageHash ?? '0'.repeat(64),
          at: new Date(this.deps.now()).toISOString(),
          ok: report.ok,
          cases: outcome.run?.results.length ?? 0,
          passed,
          problem: first === null ? null : first.slice(0, 500),
        },
      }))
      .catch(() => undefined)
    return outcome
  }

  // ---------- Submit ----------

  async submit(
    viewer: ClientIdentity,
    draftId: string,
    request: {
      readonly note: string | null
      readonly references: readonly string[]
      readonly followOns: readonly string[]
    },
  ): Promise<SubmitReport> {
    const record = await this.own(viewer, draftId)
    if (request.followOns.length > 0)
      throw new AuthoringRefusal('Follow-ons come later; ask for the tools once the site is installed.')
    if (this.submitting.has(draftId))
      throw new AuthoringRefusal('Already submitting this draft; valet_get_draft shows when it’s done.')
    this.submitting.add(draftId)
    try {
      const outcome = await this.runCheck(viewer, record)
      if (!outcome.report.ok || outcome.loaded === null || outcome.run === null) {
        const failing = outcome.report.findings.find((f) => f.level === 'error')?.text ?? 'a check failed'
        throw new AuthoringRefusal(`Not submitted: ${failing}`)
      }
      const loaded = outcome.loaded
      const installed = await this.deps.installed(record.adapterId)
      if (installed !== null && installed.hash === loaded.adapterHash)
        throw new AuthoringRefusal('Nothing changed: that’s the version installed now.')
      const current = await this.refreshed(await this.deps.store.require(draftId))
      const provenance = fixtureProvenance(outcome.run, outcome.files, current.recorded)
      const passed = outcome.run.results.filter((r) => r.passed).length
      const failed = outcome.run.results.length - passed
      const checks = checkLines(outcome.report, provenance, current.trials, record.repairId)
      const domain = siteDomain(new URL(loaded.manifest.home).hostname)
      const asked = await this.deps.submit({
        draftId,
        loaded,
        files: outcome.files,
        requester: { clientId: clientKey(viewer), clientName: this.deps.clientName(viewer).slice(0, 100) },
        agentNote: request.note,
        references: request.references,
        repairId: record.repairId,
        checks,
        agentTests: { passed, failed },
        domain,
        replaces: current.status === 'waiting' ? (current.submission?.requestId ?? null) : null,
      })
      if (!asked.ok) {
        // A refused resubmission leaves the earlier request waiting (the broker replaces it only
        // once the new one is made); the draft says withdrawn only if it no longer is.
        const earlier = current.status === 'waiting' ? current.submission?.requestId : undefined
        const stillWaiting = earlier !== undefined && this.deps.requestState(earlier).state === 'pending'
        await this.deps.store.update(draftId, (r) => ({
          ...r,
          status: r.status === 'waiting' && !stillWaiting ? 'withdrawn' : r.status,
        }))
        throw new AuthoringRefusal(`Not submitted: ${asked.sentence}`)
      }
      const at = new Date(this.deps.now()).toISOString()
      await this.deps.store.update(draftId, (r) => ({
        ...r,
        status: 'waiting',
        submission: {
          requestId: asked.requestId,
          ref: asked.ref,
          adapterHash: loaded.adapterHash,
          packageHash: bundleHash(outcome.files),
          previousHash: asked.previousHash,
          at,
          by: clientKey(viewer),
          stagedNew: asked.stagedNew,
          note: null,
        },
      }))
      await this.deps.audit({
        type: 'draft-submitted',
        draftId,
        adapterId: record.adapterId,
        clientId: clientKey(viewer),
        adapterHash: loaded.adapterHash,
        packageHash: bundleHash(outcome.files),
        requestId: asked.requestId,
      })
      return {
        ref: asked.ref,
        requestId: asked.requestId,
        expiresAt: asked.expiresAt,
        adapterHash: loaded.adapterHash,
        tellThePerson: submitSentence(loaded.manifest, domain, asked.ref, asked.previousHash === null),
      }
    } finally {
      this.submitting.delete(draftId)
    }
  }

  // ---------- Helpers ----------

  /** The record with its submission's answer brought up to date from the broker. */
  private async refreshed(record: DraftRecord): Promise<DraftRecord> {
    if (record.status !== 'waiting' || record.submission === null) return record
    const state = this.deps.requestState(record.submission.requestId)
    if (state.state === 'pending') return record
    let status: Exclude<typeof state.state, 'pending' | 'unknown'>
    if (state.state === 'unknown') {
      // Ended while nobody read the draft, and Valet restarted since, which forgets how requests
      // ended. The installed version says it was approved; anything else stays as it was.
      const installed = await this.deps.installed(record.adapterId).catch(() => null)
      if (installed?.hash !== record.submission.adapterHash) return record
      status = 'approved'
    } else status = state.state
    return this.deps.store
      .update(record.id, (r) => ({
        ...r,
        status,
        submission:
          r.submission === null
            ? null
            : { ...r.submission, note: state.state === 'unknown' ? null : state.note },
      }))
      .catch(() => record)
  }

  private async own(viewer: ClientIdentity, draftId: string): Promise<DraftRecord> {
    const record = await this.require(draftId)
    if (record.createdBy !== clientKey(viewer))
      throw new AuthoringRefusal('That draft belongs to another agent.')
    return record
  }

  private async readable(viewer: ClientIdentity, all: boolean, draftId: string): Promise<DraftRecord> {
    const record = await this.require(draftId)
    if (!all && record.createdBy !== clientKey(viewer))
      throw new AuthoringRefusal(
        "That draft belongs to another agent. The person can allow All agents' activity in Valet, Connections.",
      )
    return record
  }

  private async require(draftId: string): Promise<DraftRecord> {
    return this.wrap(() => this.deps.store.require(draftId))
  }

  private summary(record: DraftRecord): DraftList['drafts'][number] {
    return {
      draftId: record.id,
      adapterId: record.adapterId,
      status: record.status,
      createdBy: record.createdByName,
      updatedAt: record.updatedAt,
      lastCheck: record.lastCheck,
    }
  }

  private async detail(record: DraftRecord): Promise<DraftDetail> {
    const files = await this.wrap(() => this.deps.store.files(record.id))
    return {
      draft: {
        ...this.summary(record),
        basedOn: record.basedOn,
        repairId: record.repairId,
        files: Object.entries(files)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, text]) => {
            const digest = sha256Hex(text)
            const last = this.written.get(`${record.id}:${path}`)
            return {
              path,
              bytes: Buffer.byteLength(text, 'utf8'),
              sha256: digest.slice(0, 16),
              recordedByValet: record.recorded[path] === digest,
              editedOutsideValet: last !== undefined && last !== digest,
            }
          }),
        submission:
          record.submission === null
            ? null
            : {
                ref: record.submission.ref,
                adapterHash: record.submission.adapterHash,
                at: record.submission.at,
                note: record.submission.note,
              },
      },
    }
  }

  // ---------- The scratch browser (PR 2) ----------

  async browserOpen(viewer: ClientIdentity, draftId: string, url: string): Promise<BrowserView> {
    const record = await this.own(viewer, draftId)
    const files = await this.wrap(() => this.deps.store.files(draftId))
    let manifest: AdapterManifest | null = null
    try {
      manifest = parseManifest(JSON.parse(files['manifest.json'] ?? 'null'))
    } catch {
      manifest = null
    }
    const browser = await this.researching(() =>
      this.sessions().browser(
        draftId,
        clientKey(viewer),
        this.deps.clientName(viewer),
        record.adapterId,
        manifest,
      ),
    )
    return view(await this.researching(() => browser.navigate(url)))
  }

  async browserClose(viewer: ClientIdentity, draftId: string): Promise<{ readonly closed: boolean }> {
    await this.own(viewer, draftId)
    const research = this.deps.research
    const open = research?.isOpen(draftId) ?? false
    research?.close(draftId)
    return { closed: open }
  }

  async browserClick(viewer: ClientIdentity, draftId: string, target: BrowserTarget): Promise<BrowserView> {
    const browser = await this.scratch(viewer, draftId)
    return view(await this.researching(() => browser.click(target)))
  }

  async browserType(
    viewer: ClientIdentity,
    draftId: string,
    target: BrowserTarget,
    text: string,
  ): Promise<BrowserView> {
    const browser = await this.scratch(viewer, draftId)
    return view(await this.researching(() => browser.type(target, text)))
  }

  async browserSnapshot(
    viewer: ClientIdentity,
    draftId: string,
    options: { readonly root?: string; readonly maxNodes?: number },
  ): Promise<BrowserView> {
    const browser = await this.scratch(viewer, draftId)
    return view(await this.researching(() => browser.snapshot(options)))
  }

  async browserQuery(viewer: ClientIdentity, draftId: string, selector: string): Promise<BrowserQuery> {
    const browser = await this.scratch(viewer, draftId)
    const found = await this.researching(() => browser.query(selector))
    return {
      count: found.count,
      matches: found.matches.map((m) => ({
        tag: siteTag(m.tag),
        id: m.id === null ? null : { fromSite: m.id },
        classes: { fromSite: m.classes },
        fromSite: m.text,
        visible: m.visible,
      })),
    }
  }

  async networkLog(
    viewer: ClientIdentity,
    draftId: string,
    filter: { readonly sinceSeq?: number; readonly host?: string; readonly type?: string },
  ): Promise<NetworkLog> {
    const browser = await this.scratch(viewer, draftId)
    return {
      entries: browser.entries(filter).map((e) => ({
        seq: e.seq,
        method: siteMethod(e.method),
        url: { fromSite: scrubUrl(e.url) },
        resourceType: e.resourceType,
        status: e.status,
        mimeType: siteMime(e.mimeType),
      })),
    }
  }

  async networkBody(viewer: ClientIdentity, draftId: string, seq: number): Promise<NetworkBody> {
    const browser = await this.scratch(viewer, draftId)
    const found = await this.researching(() => browser.body(seq))
    if (found === null)
      throw new AuthoringRefusal('The browser no longer holds that response. Load the page again.')
    const scrubbed = scrubBody(found.text, found.entry.mimeType)
    if ('refused' in scrubbed) throw new AuthoringRefusal(scrubbed.refused)
    return {
      seq,
      url: { fromSite: scrubUrl(found.entry.url) },
      mimeType: siteMime(found.entry.mimeType),
      fromSite: scrubbed.value,
      truncated: scrubbed.truncated,
    }
  }

  async captureFixture(
    viewer: ClientIdentity,
    draftId: string,
    source: { readonly seq: number } | { readonly page: true },
    path: string,
  ): Promise<Captured> {
    await this.own(viewer, draftId)
    const browser = await this.scratch(viewer, draftId)
    let text: string
    if ('page' in source) {
      const misfit = fixtureFits(path, 'text/html', true)
      if (misfit !== null) throw new AuthoringRefusal(misfit)
      text = await this.researching(() => browser.document())
    } else {
      const found = await this.researching(() => browser.body(source.seq))
      if (found === null)
        throw new AuthoringRefusal('The browser no longer holds that response. Load the page again.')
      const misfit = fixtureFits(path, found.entry.mimeType, false)
      if (misfit !== null) throw new AuthoringRefusal(misfit)
      text = found.text
    }
    await this.wrap(() => this.deps.store.write(draftId, path, text))
    const digest = sha256Hex(text)
    this.written.set(`${draftId}:${path}`, digest)
    await this.wrap(() =>
      this.deps.store.update(draftId, (r) => ({
        ...r,
        recorded: { ...r.recorded, [path]: digest },
        recordedAt: { ...r.recordedAt, [path]: new Date(this.deps.now()).toISOString() },
      })),
    )
    return { path, bytes: Buffer.byteLength(text, 'utf8'), recordedByValet: true }
  }

  // ---------- Live trials (PR 2b) ----------

  async liveTrial(
    viewer: ClientIdentity,
    draftId: string,
    tool: string,
    input: unknown,
    signedIn = false,
  ): Promise<TrialReport> {
    const record = await this.own(viewer, draftId)
    const trials = this.deps.trials
    if (trials === undefined) throw new AuthoringRefusal('This build of Valet has no live trials.')
    if (this.trialing.has(draftId))
      throw new AuthoringRefusal('One trial at a time: this draft’s last one is still running.')
    const files = await this.wrap(() => this.deps.store.files(draftId))
    let loaded: LoadedPackage
    try {
      loaded = await this.deps.prepare(files)
    } catch (error) {
      throw new AuthoringRefusal(`Not tried: the draft doesn’t build. ${sentenceOf(error)}`)
    }
    const manifest = loaded.manifest
    if (manifest.id !== record.adapterId)
      throw new AuthoringRefusal(`Not tried: the manifest’s id must be ${record.adapterId}, the draft’s.`)
    const declared = manifest.tools.find((t) => t.name === tool)
    const schemas = loaded.definition.tools[tool]
    if (declared === undefined || schemas === undefined)
      throw new AuthoringRefusal(`Not tried: no tool ${tool} in the manifest.`)
    if (declared.sideEffect !== 'read')
      throw new AuthoringRefusal(
        `Not tried: ${tool} is a ${declared.sideEffect} tool. Only read tools can be tried live; test the others with cases.`,
      )
    // A protocol adapter's every operation signs in with the person's kept credential, which is
    // granted only to an approved adapter and never lent to a draft (not even an update's).
    if (runtimeOf(manifest) === 'protocol')
      throw new AuthoringRefusal(
        'Not tried: a protocol adapter signs in to its server with a credential the person grants only once they approve the adapter, so it has no live trials. Test it with cases that script ctx.imap, ctx.smtp or ctx.sftp (valet_authoring_guide), then valet_submit_draft.',
      )
    const parsed = schemas.input.safeParse(input)
    if (!parsed.success)
      throw new AuthoringRefusal(`Not tried: the input doesn’t match ${tool}’s input schema.`)
    const home = homeUnreachable(manifest)
    if (home !== null) throw new AuthoringRefusal(`Not tried: ${home}. ${HOME_FIX}`)
    // Never a site the person is signed in to, except this draft's own adapter's, as for the
    // scratch browser.
    const domains = draftDomains(manifest)
    const signedInSites = await trials.signedIn().catch(() => null)
    if (signedInSites === null)
      throw new AuthoringRefusal('Not tried: Valet can’t tell which sites are signed in.')
    for (const [id, list] of signedInSites) {
      if (id === record.adapterId) continue
      const shared = list.find((d) => domains.includes(d))
      if (shared !== undefined)
        throw new AuthoringRefusal(`Not tried: the person is signed in to ${shared} with another adapter.`)
    }
    let session: SignedInTrial | null = null
    if (signedIn && viewer.origin !== 'local') throw new AuthoringRefusal(REMOTE_SIGNED_IN)
    if (signedIn) {
      const lent = this.deps.sessionFor?.(draftId) ?? null
      const installed = record.basedOn === null ? null : await this.deps.installed(record.adapterId)
      if (lent === null || lent.until <= this.deps.now() || installed === null)
        throw new AuthoringRefusal(
          'Not tried: no signed-in session is running for this draft. valet_request_session asks the person for one.',
        )
      session = { adapterId: record.adapterId, installed: installed.manifest }
    }
    const trialWait = take(this.trialTimes, draftId, TRIAL_LIMITS.perDraftPerHour, this.deps.now())
    if (trialWait > 0)
      throw new AuthoringRefusal(
        `Not tried: ${TRIAL_LIMITS.perDraftPerHour} trials an hour per draft is the most. Try again in ${seconds(trialWait)} seconds.`,
      )
    const host = new URL(manifest.home).hostname
    const packageHash = bundleHash(files)
    const trialLabel = `${draftId.toLowerCase()}-${++this.trialCount}`
    this.trialing.add(draftId)
    let result: TrialResult
    try {
      result = await runTrial(
        { manifest, script: loaded.script, tools: loaded.definition.tools },
        tool,
        parsed.data,
        trialLabel,
        trials,
        this.deps.now,
        session,
      )
    } catch {
      throw new AuthoringRefusal('Not tried: Valet couldn’t open a browser for the trial.')
    } finally {
      this.trialing.delete(draftId)
    }
    const problem = trialProblem(result, session !== null)
    const reproduces =
      session !== null && problem === null
        ? await this.reproducedLive(record, tool, parsed.data, session, trials, draftId)
        : null
    const summary: TrialSummary = {
      tool,
      packageHash,
      at: new Date(this.deps.now()).toISOString(),
      ok: problem === null,
      problem: problem === null ? null : clip(problem, 200),
      signedIn: session !== null,
      reproduces,
    }
    await this.deps.store
      .update(draftId, (r) => ({ ...r, trials: [...r.trials, summary].slice(-20) }))
      .catch(() => undefined)
    // Each refusal is a request-blocked record, as an installed call's is, so the blocked count
    // and the audit log's blocked category show it.
    for (const b of result.blocked)
      await this.deps.audit({
        type: 'request-blocked',
        adapterId: record.adapterId,
        method: b.method,
        target: b.url,
        reason: b.reason,
        initiator: b.initiator,
        partition: 'tool',
        callId: `trial-${trialLabel}`,
        draftId,
      })
    await this.deps.audit({
      type: 'draft-trial',
      draftId,
      adapterId: record.adapterId,
      clientId: clientKey(viewer),
      tool,
      host,
      packageHash,
      outcome: result.outcome.kind,
      ...(session === null ? {} : { signedIn: true }),
      ...(result.blockedCount === 0 ? {} : { blocked: result.blockedCount }),
    })
    // The tool's name, never its agent-written title.
    this.deps.notify(
      `${this.deps.clientName(viewer)} tried ${tool} on ${siteDomain(host)}${session === null ? '' : ', signed in'}.`,
    )
    return {
      tool,
      packageHash,
      ok: problem === null,
      output: result.outcome.kind === 'output' ? { fromSite: result.outcome.output } : null,
      problem,
      blocked: result.blocked.map((b) => ({ ...b })),
      blockedCount: result.blockedCount,
      ms: Math.max(0, Math.round(result.ms)),
      ...(reproduces === null ? {} : { reproduces }),
    }
  }

  /**
   * A login trial (docs/authoring-tools.md#repairing-an-installed-adapter): the draft's own login
   * steps, from signed out, in a login session for the installed adapter on a trial's own new
   * partitions. The session's walls
   * are the installed version's, so the draft must keep what a login depends on as installed. Kept
   * on the draft under its steps and walls, for check step 6b and the card.
   */
  async loginTrial(viewer: ClientIdentity, draftId: string): Promise<TrialReport> {
    const record = await this.own(viewer, draftId)
    const run = this.deps.loginTrial
    if (run === undefined) throw new AuthoringRefusal('This build of Valet can’t try login steps.')
    if (this.trialing.has(draftId))
      throw new AuthoringRefusal('One trial at a time: this draft’s last one is still running.')
    const installed = record.basedOn === null ? null : await this.deps.installed(record.adapterId)
    if (installed === null)
      throw new AuthoringRefusal(
        'Not tried: a login trial is for an installed adapter’s login. Start the draft from "installed".',
      )
    const files = await this.wrap(() => this.deps.store.files(draftId))
    let manifest: AdapterManifest
    try {
      manifest = (await this.deps.prepare(files)).manifest
    } catch (error) {
      throw new AuthoringRefusal(`Not tried: the draft doesn’t build. ${sentenceOf(error)}`)
    }
    if (manifest.id !== record.adapterId)
      throw new AuthoringRefusal(`Not tried: the manifest’s id must be ${record.adapterId}, the draft’s.`)
    const changed = draftChanges(files, installed, true)
    if (!changed.loginWallsSame)
      throw new AuthoringRefusal(
        'Not tried: a login trial runs the draft’s steps behind the installed version’s walls, so the draft must keep home, navigation, egress, secrets, session and auth.frameOrigins as they are installed.',
      )
    if (manifest.auth.steps.length === 0)
      throw new AuthoringRefusal('Not tried: the draft has no login steps (auth.steps).')
    const trialWait = take(this.trialTimes, draftId, TRIAL_LIMITS.perDraftPerHour, this.deps.now())
    if (trialWait > 0)
      throw new AuthoringRefusal(
        `Not tried: ${TRIAL_LIMITS.perDraftPerHour} trials an hour per draft is the most. Try again in ${seconds(trialWait)} seconds.`,
      )
    const started = this.deps.now()
    this.trialing.add(draftId)
    let result: LoginTrialResult
    try {
      result = await run({
        adapterId: record.adapterId,
        draftId,
        label: `${draftId.toLowerCase()}-${++this.trialCount}`,
        steps: manifest.auth.steps,
        clientName: this.deps.clientName(viewer).slice(0, 100),
      })
    } finally {
      this.trialing.delete(draftId)
    }
    if (result.kind === 'signed-in-before')
      throw new AuthoringRefusal(
        `Not tried: the trial’s new browser was signed in to ${manifest.name} before any step ran, so the steps would prove nothing.`,
      )
    const problem = loginTrialProblem(result)
    const summary: LoginTrialSummary = {
      loginKey: changed.loginKey,
      at: new Date(this.deps.now()).toISOString(),
      ok: problem === null,
      problem: problem === null ? null : clip(problem, 200),
    }
    await this.deps.store
      .update(draftId, (r) => ({ ...r, loginTrials: [...r.loginTrials, summary].slice(-10) }))
      .catch(() => undefined)
    const host = new URL(manifest.home).hostname
    const packageHash = bundleHash(files)
    await this.deps.audit({
      type: 'draft-trial',
      draftId,
      adapterId: record.adapterId,
      clientId: clientKey(viewer),
      tool: LOGIN_TRIAL,
      host,
      packageHash,
      outcome:
        result.kind === 'signed-in'
          ? 'output'
          : result.status === 'needsUser'
            ? 'needs-user'
            : result.status === 'blocked'
              ? 'site-resting'
              : 'error',
      login: true,
    })
    this.deps.notify(`${this.deps.clientName(viewer)} tried new login steps on ${siteDomain(host)}.`)
    return {
      tool: LOGIN_TRIAL,
      packageHash,
      ok: problem === null,
      output: null,
      problem,
      blocked: [],
      blockedCount: 0,
      ms: Math.max(0, Math.round(this.deps.now() - started)),
      login: true,
    }
  }

  /**
   * A repair of a page behind the sign-in, where Valet can record no fixture: after the draft's
   * signed-in trial of the ticket's tool worked, the installed version runs on the same input and
   * session. Its failing as the ticket says is the reproduction (check step 7). The ticket's id,
   * or null.
   */
  private async reproducedLive(
    record: DraftRecord,
    tool: string,
    input: unknown,
    session: SignedInTrial,
    trials: TrialDeps,
    draftId: string,
  ): Promise<string | null> {
    const ticket = record.repairId === null ? null : (this.deps.repairs?.get(record.repairId) ?? null)
    if (ticket === null || ticket.state !== 'open' || ticket.tool !== tool) return null
    const installed = await this.deps.installed(record.adapterId).catch(() => null)
    if (installed === null) return null
    let old: LoadedPackage
    try {
      old = await this.deps.prepare(installed.files)
    } catch {
      return null
    }
    this.trialing.add(draftId)
    try {
      const before = await runTrial(
        { manifest: old.manifest, script: old.script, tools: old.definition.tools },
        tool,
        input,
        `${draftId.toLowerCase()}-${++this.trialCount}`,
        trials,
        this.deps.now,
        session,
      )
      const o = before.outcome
      return o.kind === 'error' && o.stage === ticket.stage && o.errorClass === ticket.errorClass
        ? ticket.id
        : null
    } catch {
      return null
    } finally {
      this.trialing.delete(draftId)
    }
  }

  /** A grant began or ended: the draft's scratch browser closes, to open again as it now may. */
  closeBrowser(draftId: string): void {
    this.deps.research?.close(draftId)
  }

  /** On lockdown or pause: every scratch browser closes. */
  closeBrowsers(): void {
    this.deps.research?.closeAll()
  }

  private sessions(): ScratchSessions {
    const research = this.deps.research
    if (research === undefined) throw new AuthoringRefusal('This build of Valet has no scratch browser.')
    return research
  }

  private async scratch(viewer: ClientIdentity, draftId: string): Promise<ScratchHandle> {
    await this.own(viewer, draftId)
    return this.researching(async () => this.sessions().current(draftId))
  }

  /** The browser's and the sessions' refusals, in their words; anything else stays hidden. */
  private async researching<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof AuthoringRefusal) throw error
      if (error instanceof ResearchRefusal) throw new AuthoringRefusal(error.detail)
      const detail = error as { readonly name?: unknown; readonly detail?: unknown } | null
      if (detail?.name === 'ScratchError' && typeof detail.detail === 'string')
        throw new AuthoringRefusal(detail.detail)
      throw error
    }
  }

  private checkLimit(client: string): void {
    const wait = take(this.checks, client, CHECKS_PER_CLIENT_PER_HOUR, this.deps.now())
    if (wait > 0)
      throw new AuthoringRefusal(
        `Not checked: ${CHECKS_PER_CLIENT_PER_HOUR} checks an hour is the most, and you have used them. ` +
          `Try again in ${seconds(wait)} seconds, when the oldest frees up. A check of a package that ` +
          'hasn’t changed since the last one is answered again and doesn’t count.',
      )
  }

  private notifyLimit(client: string): void {
    const wait = take(this.notifies, client, NOTIFY_PER_CLIENT_PER_HOUR, this.deps.now())
    if (wait > 0)
      throw new AuthoringRefusal(
        `Not done: too many changes this hour. Try again in ${seconds(wait)} seconds.`,
      )
  }

  private async wrap<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof DraftError) throw new AuthoringRefusal(error.detail)
      throw error
    }
  }
}

/** A snapshot for the agent: everything the site wrote under fromSite. */
function view(snapshot: {
  readonly url: string
  readonly title: string
  readonly nodes: readonly {
    readonly ref: string
    readonly kind: 'interactive' | 'text'
    readonly tag: string
    readonly role: string | null
    readonly text: string
    readonly href: string | null
    readonly inputType: string | null
  }[]
  readonly cut: boolean
}): BrowserView {
  return {
    url: { fromSite: scrubUrl(snapshot.url) },
    title: { fromSite: snapshot.title },
    nodes: snapshot.nodes.map((n) => ({
      ref: n.ref,
      kind: n.kind,
      tag: siteTag(n.tag),
      role: siteRole(n.role),
      fromSite: n.text,
      href: n.href === null ? null : { fromSite: n.href },
      inputType: siteInputType(n.inputType),
    })),
    cut: snapshot.cut,
  }
}

/**
 * Takes one from a client's hourly allowance: 0 if taken, else how many milliseconds until the
 * oldest use in the hour frees a slot.
 */
function take(map: Map<string, number[]>, client: string, limit: number, now: number): number {
  const recent = (map.get(client) ?? []).filter((t) => now - t < 3600_000)
  if (recent.length >= limit) {
    map.set(client, recent)
    return Math.max(1, (recent[0] ?? now) + 3600_000 - now)
  }
  recent.push(now)
  map.set(client, recent)
  return 0
}

/** Whole seconds, at least one, for "Try again in N seconds". */
function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

/** Why a cloud agent gets no signed-in session or trial. */
export const REMOTE_SIGNED_IN =
  'Signed-in sessions and trials are for agents on the person’s Mac only for now. Try the draft signed out, ' +
  'or test it with cases; the person can try it signed in after approving it.'

function clientKey(viewer: ClientIdentity): string {
  return `${viewer.origin}:${viewer.clientId}`
}

function lines(changes: readonly PermissionChange[]): CheckReport['changes'] {
  return changes.map((c) => ({ area: c.area, risk: c.risk, text: `${c.change}: ${c.items.join('; ')}` }))
}

/** "Checks Valet ran", in Valet's words, for the card. The agent's cases go in their own field. */
export function checkLines(
  report: CheckReport,
  provenance: { readonly recordedByValet: number; readonly writtenByAgent: number },
  trials: readonly TrialSummary[] = [],
  repairId: string | null = null,
): string[] {
  const out = [
    'Package and manifest: pass',
    'Build, and schemas described in the sandbox: pass',
    'Names: pass',
  ]
  const cautions = report.findings.filter((f) => f.level === 'caution')
  out.push(cautions.length === 0 ? 'Lint: nothing found' : `Lint: ${cautions.length} to look at`)
  for (const c of cautions.slice(0, 10)) out.push(clip(c.text, 200))
  out.push(
    `Fixtures: ${provenance.recordedByValet} recorded by Valet, ${provenance.writtenByAgent} written by the agent`,
  )
  const unchanged = report.unchangedTools ?? []
  if (unchanged.length > 0)
    out.push(
      clip(
        `Code and declaration as installed now, so no new cases needed: ${unchanged.length === 1 ? '1 tool' : `${unchanged.length} tools`} (${unchanged.join(', ')})`,
        200,
      ),
    )
  if (report.login === 'tried')
    out.push('Login steps: changed, and a login trial signed in with them from signed out')
  else if (report.login === 'not-tried') out.push('Login steps: changed, and not tried')
  out.push(...trialLines(trials, report.packageHash))
  if (repairId !== null) {
    const live = trials.some((t) => t.reproduces === repairId && t.packageHash === report.packageHash)
    out.push(
      live
        ? `Repair ${repairId}: in a signed-in trial, the installed version fails as it did, and this one works`
        : `Repair ${repairId}: on what Valet recorded, the installed version fails as it did, and this one works`,
    )
  }
  return out.slice(0, 20)
}

/** The card's trial lines: only trials of exactly the files submitted count. */
function trialLines(trials: readonly TrialSummary[], packageHash: string | null): string[] {
  const these = trials.filter((t) => t.packageHash === packageHash)
  if (these.length === 0) return ['Live trial: not run on this version']
  const byTool = new Map<string, TrialSummary>()
  for (const t of these) byTool.set(`${t.tool}:${t.signedIn}`, t)
  return [...byTool.values()]
    .slice(0, 4)
    .map((t) =>
      t.ok
        ? `Live trial of ${t.tool}, ${t.signedIn ? 'signed in' : 'signed out'}: returned output that fits its schema`
        : `Live trial of ${t.tool}, ${t.signedIn ? 'signed in' : 'signed out'}: ${clip(t.problem ?? 'failed', 120)}`,
    )
}

/** What a login trial is called where a tool's name would be: in its report and the audit log. */
export const LOGIN_TRIAL = 'auth.steps'

/** How a login trial ended, in Valet's words; null when it signed in. */
export function loginTrialProblem(result: LoginTrialResult): string | null {
  if (result.kind === 'signed-in') return null
  if (result.kind === 'signed-in-before') return 'Valet was signed in before the steps ran.'
  if (result.at === 'after')
    return result.status === 'failed' && result.errorClass === 'not-logged-in'
      ? 'The steps all ran, but the site didn’t say signed in after them.'
      : `The steps all ran, but checking for signed in after them stopped (${codes(result)}).`
  const where = result.at === 'before' ? 'Checking for signed out before the steps' : 'The steps'
  if (result.status === 'needsUser')
    return `${where} stopped for the person (${result.reason ?? 'needs-user'}).`
  if (result.status === 'blocked') return `${where} met the site refusing Valet (${codes(result)}).`
  return `${where} stopped (${codes(result)}).`
}

function codes(r: { readonly stage: string | null; readonly errorClass: string | null }): string {
  return `${r.stage ?? 'auth-step'}: ${r.errorClass ?? 'failed'}`
}

/** How a trial ended, for the agent and the card; null when it returned good output. */
/** In a signed-in trial, what a signed-out answer means: the lent session is, at the site. */
const LENT_SIGNED_OUT =
  'The site says the lent session is signed out (it may have ended there). A call of the installed ' +
  'adapter’s tool signs it in again; then try the trial again.'

/** What to do about a home off the egress list, for the check and the trial. */
const HOME_FIX =
  'Add that host to egress, or, for an API-only adapter, make home the API’s own origin and navigation the same.'

export function trialProblem(result: TrialResult, signedIn = false): string | null {
  const o = result.outcome
  if (signedIn && o.kind === 'needs-user' && o.reason === 'login-required') return LENT_SIGNED_OUT
  if (signedIn && o.kind === 'error' && o.errorClass === 'not-logged-in') return LENT_SIGNED_OUT
  switch (o.kind) {
    case 'output':
      return null
    case 'invalid-output':
      return 'The output doesn’t match the tool’s output schema.'
    case 'session-value':
      return 'The output held a value of the person’s session, so Valet withheld it.'
    case 'timeout':
      return `Ran over ${Math.round(TRIAL_LIMITS.timeoutMs / 1000)} seconds.`
    case 'needs-user':
      return o.reason === 'login-required'
        ? 'The tool asked for a session; trials are signed out.'
        : `The tool stopped for the person: ${o.reason}.`
    case 'site-resting':
      return `Nothing sent: the site is resting for about ${Math.max(1, Math.ceil(o.retryAfterMs / 60_000))} minutes.`
    case 'error':
      if (o.stage === 'tool-input' && o.errorClass === 'invalid')
        return 'The input doesn’t match the tool’s input schema.'
      if (o.stage === 'tool-output' && o.errorClass === 'invalid')
        return 'The output doesn’t match the tool’s output schema.'
      if (o.url !== undefined)
        return o.home === true
          ? `Failed with ${o.stage}/${o.errorClass} loading home, ${o.url}, which every call opens before tool code runs.`
          : `Failed with ${o.stage}/${o.errorClass} loading ${o.url}.`
      return `Failed with ${o.stage}/${o.errorClass}.`
  }
}

function sentenceOf(error: unknown): string {
  if (error instanceof Error && 'detail' in error && typeof error.detail === 'string')
    return clip(error.detail, 1200)
  return 'it could not be built.'
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * What the agent tells the person after a submit, in the titles the person will see: the Mac's
 * Needs you item and review (which show the ref) and a paired phone's card.
 */
export function submitSentence(
  manifest: Pick<AdapterManifest, 'id' | 'name' | 'version'>,
  domain: string,
  ref: string,
  firstInstall: boolean,
): string {
  const mac = needsYouTitle({
    kind: 'review',
    adapterName: manifest.name,
    version: manifest.version,
    firstInstall,
  })
  const phone = firstInstall
    ? `Install an adapter for ${domain}`
    : `Update ${manifest.id} to ${manifest.version}`
  return (
    `Waiting for the person in Valet: “${mac}” in Needs you on their Mac, marked approval ${ref}, ` +
    `or “${phone}” on their phone.`
  )
}
