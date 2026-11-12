// The app's side of the authoring tools (docs/authoring-tools.md): drafts on disk, Valet's checks,
// the agent's cases in the sandbox, and submit through the approval broker. Electron-free: the
// service gives it the builder (C's prepare, describing in a one-shot sandbox window), the sandbox
// factory for cases, what is installed and approved, and the broker's side of a submit.

import type { LoadedPackage } from '@valet/adapter-store'
import {
  type AdapterManifest,
  type AuditEvent,
  bundleHash,
  type PackageFiles,
  type PermissionChange,
  parseManifest,
  sha256Hex,
} from '@valet/core'
import {
  type Authoring,
  AuthoringRefusal,
  type BrowserQuery,
  type BrowserTarget,
  type BrowserView,
  type Captured,
  type CheckReport,
  type ClientIdentity,
  type DiffReport,
  type DraftDetail,
  type DraftList,
  type NetworkBody,
  type NetworkLog,
  type SubmitReport,
  type TrialReport,
} from '@valet/mcp-server'
import type { ToolProcessFactory } from '@valet/runtime'
import { NO_LOCAL_ACCESS } from '@valet/sandbox'
import { type CaseRun, runCases } from './cases'
import {
  caseFindings,
  checkNames,
  checkVersion,
  type Finding,
  fixtureProvenance,
  lint,
  siteDomain,
} from './checks'
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
import { DRAFT_LIMITS, DraftError, type DraftRecord, type DraftStore, type TrialSummary } from './store'
import { blankDraft } from './template'
import { runTrial, TRIAL_LIMITS, type TrialDeps, type TrialResult } from './trial'

/** A whole check's time, so a submit answers inside an MCP client's usual timeout. */
export const CHECK_BUDGET_MS = 45_000
export const CHECKS_PER_CLIENT_PER_HOUR = 20
export const NOTIFY_PER_CLIENT_PER_HOUR = 10

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
  /** The draft's earlier waiting request, to withdraw first (or replace in one step, once D has it). */
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
  readonly installed: (adapterId: string) => Promise<InstalledVersion | null>
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
  /** Live trials (PR 2b); without them valet_live_trial says this build has none. */
  readonly trials?: TrialDeps & { readonly signedIn: ResearchDeps['signedIn'] }
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
  /** One check at a time in all; a client waiting behind another's is told so. */
  private checking: Promise<unknown> = Promise.resolve()
  private readonly checkingClients = new Set<string>()
  private readonly submitting = new Set<string>()
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
    request: { readonly adapterId: string; readonly from: 'blank' | 'installed'; readonly name?: string },
  ): Promise<DraftDetail> {
    const client = clientKey(viewer)
    const all = await this.deps.store.list()
    if (all.filter((d) => d.createdBy === client).length >= DRAFT_LIMITS.perClient)
      throw new AuthoringRefusal(`Not started: you have ${DRAFT_LIMITS.perClient} drafts. Delete one first.`)
    if (all.length >= DRAFT_LIMITS.total)
      throw new AuthoringRefusal(
        'Not started: Valet holds as many drafts as it keeps. Ask the person to delete some.',
      )
    const installed = await this.deps.installed(request.adapterId)
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
      files = blankDraft(request.adapterId, request.name ?? request.adapterId)
    }
    this.notifyLimit(client)
    const record = await this.wrap(() =>
      this.deps.store.create(
        {
          adapterId: request.adapterId,
          createdBy: client,
          createdByName: this.deps.clientName(viewer).slice(0, 100),
          basedOn,
          repairId: null,
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

  async deleteDraft(viewer: ClientIdentity, draftId: string) {
    const record = await this.own(viewer, draftId)
    if (record.status === 'waiting' && record.submission !== null)
      await this.deps.withdraw(record.submission.requestId).catch(() => undefined)
    this.deps.research?.close(draftId)
    await this.deps.store.delete(draftId)
    for (const key of [...this.written.keys()]) if (key.startsWith(`${draftId}:`)) this.written.delete(key)
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
    this.checkLimit(client)
    if (this.checkingClients.has(client))
      throw new AuthoringRefusal('One check at a time: your last one is still running.')
    this.checkingClients.add(client)
    const turn = this.checking.then(() => this.checkNow(record, tool))
    this.checking = turn.catch(() => undefined)
    try {
      return await turn
    } finally {
      this.checkingClients.delete(client)
    }
  }

  private async checkNow(record: DraftRecord, tool?: string): Promise<CheckOutcome> {
    const started = this.deps.now()
    const budget = this.deps.checkBudgetMs ?? CHECK_BUDGET_MS
    const files = await this.wrap(() => this.deps.store.files(record.id))
    const packageHash = bundleHash(files)
    const steps: { step: string; ok: boolean }[] = []
    const findings: Finding[] = []
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
      local: NO_LOCAL_ACCESS,
      ...(tool === undefined ? {} : { tool }),
      deadline: started + budget,
      now: this.deps.now,
      timeoutMs: Math.min(5_000, Math.max(1, left)),
    })
    const caseErrors = caseFindings(manifest, run, tool)
    findings.push(...caseErrors)
    steps.push({ step: 'cases', ok: !caseErrors.some((f) => f.level === 'error') })
    return this.saved(record, report(loaded, run, changes))
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
      const checks = checkLines(outcome.report, provenance, current.trials)
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
        await this.deps.store.update(draftId, (r) => ({
          ...r,
          status: r.status === 'waiting' ? 'withdrawn' : r.status,
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
      const verb = installed === null ? 'Install' : 'Update'
      return {
        ref: asked.ref,
        requestId: asked.requestId,
        expiresAt: asked.expiresAt,
        adapterHash: loaded.adapterHash,
        tellThePerson:
          `Waiting for the person in Valet: “${verb} ${loaded.manifest.name} for ${domain}” (approval ${asked.ref}). ` +
          'They can approve it on their phone or Mac.',
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
    if (state.state === 'pending' || state.state === 'unknown') return record
    const status = state.state
    return this.deps.store
      .update(record.id, (r) => ({
        ...r,
        status,
        submission: r.submission === null ? null : { ...r.submission, note: state.note },
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
        tag: m.tag,
        id: m.id,
        classes: m.classes,
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
      entries: browser.entries(filter).map((e) => ({ ...e, url: scrubUrl(e.url) })),
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
      url: scrubUrl(found.entry.url),
      mimeType: found.entry.mimeType,
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
      this.deps.store.update(draftId, (r) => ({ ...r, recorded: { ...r.recorded, [path]: digest } })),
    )
    return { path, bytes: Buffer.byteLength(text, 'utf8'), recordedByValet: true }
  }

  // ---------- Live trials (PR 2b) ----------

  async liveTrial(
    viewer: ClientIdentity,
    draftId: string,
    tool: string,
    input: unknown,
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
    const parsed = schemas.input.safeParse(input)
    if (!parsed.success)
      throw new AuthoringRefusal(`Not tried: the input doesn’t match ${tool}’s input schema.`)
    // Never a site the person is signed in to, except this draft's own adapter's, as for the
    // scratch browser.
    const domains = draftDomains(manifest)
    const signedIn = await trials.signedIn().catch(() => null)
    if (signedIn === null)
      throw new AuthoringRefusal('Not tried: Valet can’t tell which sites are signed in.')
    for (const [id, list] of signedIn) {
      if (id === record.adapterId) continue
      const shared = list.find((d) => domains.includes(d))
      if (shared !== undefined)
        throw new AuthoringRefusal(`Not tried: the person is signed in to ${shared} with another adapter.`)
    }
    if (!take(this.trialTimes, draftId, TRIAL_LIMITS.perDraftPerHour, this.deps.now()))
      throw new AuthoringRefusal(
        `Not tried: ${TRIAL_LIMITS.perDraftPerHour} trials an hour per draft is the most. Try again later.`,
      )
    const host = new URL(manifest.home).hostname
    const packageHash = bundleHash(files)
    this.trialing.add(draftId)
    let result: TrialResult
    try {
      result = await runTrial(
        { manifest, script: loaded.script, tools: loaded.definition.tools },
        tool,
        parsed.data,
        `${draftId.toLowerCase()}-${++this.trialCount}`,
        trials,
        this.deps.now,
      )
    } catch {
      throw new AuthoringRefusal('Not tried: Valet couldn’t open a browser for the trial.')
    } finally {
      this.trialing.delete(draftId)
    }
    const problem = trialProblem(result)
    const summary: TrialSummary = {
      tool,
      packageHash,
      at: new Date(this.deps.now()).toISOString(),
      ok: problem === null,
      problem: problem === null ? null : clip(problem, 200),
    }
    await this.deps.store
      .update(draftId, (r) => ({ ...r, trials: [...r.trials, summary].slice(-20) }))
      .catch(() => undefined)
    await this.deps.audit({
      type: 'draft-trial',
      draftId,
      adapterId: record.adapterId,
      clientId: clientKey(viewer),
      tool,
      host,
      packageHash,
      outcome: result.outcome.kind,
    })
    // The tool's name, never its agent-written title.
    this.deps.notify(`${this.deps.clientName(viewer)} tried ${tool} on ${siteDomain(host)}.`)
    return {
      tool,
      packageHash,
      ok: problem === null,
      output: result.outcome.kind === 'output' ? { fromSite: result.outcome.output } : null,
      problem,
      blocked: result.blocked.map((b) => ({ ...b })),
      ms: Math.max(0, Math.round(result.ms)),
    }
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
    if (!take(this.checks, client, CHECKS_PER_CLIENT_PER_HOUR, this.deps.now()))
      throw new AuthoringRefusal(
        `Not checked: ${CHECKS_PER_CLIENT_PER_HOUR} checks an hour is the most. Try again later.`,
      )
  }

  private notifyLimit(client: string): void {
    if (!take(this.notifies, client, NOTIFY_PER_CLIENT_PER_HOUR, this.deps.now()))
      throw new AuthoringRefusal('Not done: too many changes this hour.')
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
    url: scrubUrl(snapshot.url),
    title: { fromSite: snapshot.title },
    nodes: snapshot.nodes.map((n) => ({
      ref: n.ref,
      kind: n.kind,
      tag: n.tag,
      role: n.role,
      fromSite: n.text,
      href: n.href,
      inputType: n.inputType,
    })),
    cut: snapshot.cut,
  }
}

/** Takes one from a client's hourly allowance; false if none is left. */
function take(map: Map<string, number[]>, client: string, limit: number, now: number): boolean {
  const recent = (map.get(client) ?? []).filter((t) => now - t < 3600_000)
  if (recent.length >= limit) {
    map.set(client, recent)
    return false
  }
  recent.push(now)
  map.set(client, recent)
  return true
}

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
  out.push(...trialLines(trials, report.packageHash))
  return out.slice(0, 20)
}

/** The card's trial lines: only trials of exactly the files submitted count. */
function trialLines(trials: readonly TrialSummary[], packageHash: string | null): string[] {
  const these = trials.filter((t) => t.packageHash === packageHash)
  if (these.length === 0) return ['Live trial: not run on this version']
  const byTool = new Map<string, TrialSummary>()
  for (const t of these) byTool.set(t.tool, t)
  return [...byTool.values()]
    .slice(0, 4)
    .map((t) =>
      t.ok
        ? `Live trial of ${t.tool}, signed out: returned output that fits its schema`
        : `Live trial of ${t.tool}, signed out: ${clip(t.problem ?? 'failed', 120)}`,
    )
}

/** How a trial ended, for the agent and the card; null when it returned good output. */
function trialProblem(result: TrialResult): string | null {
  const o = result.outcome
  switch (o.kind) {
    case 'output':
      return null
    case 'invalid-output':
      return 'The output doesn’t match the tool’s output schema.'
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
      return `Failed with ${o.stage}/${o.errorClass}.`
  }
}

function sentenceOf(error: unknown): string {
  if (error instanceof Error && 'detail' in error && typeof error.detail === 'string')
    return clip(error.detail, 300)
  return 'it could not be built.'
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
