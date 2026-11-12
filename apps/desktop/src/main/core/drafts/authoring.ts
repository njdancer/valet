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
  sha256Hex,
} from '@valet/core'
import {
  type Authoring,
  AuthoringRefusal,
  type CheckReport,
  type ClientIdentity,
  type DiffReport,
  type DraftDetail,
  type DraftList,
  type SubmitReport,
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
import { DRAFT_LIMITS, DraftError, type DraftRecord, type DraftStore } from './store'
import { blankDraft } from './template'

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
      const checks = checkLines(outcome.report, provenance)
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
  out.push('Live trial: not run')
  return out.slice(0, 20)
}

function sentenceOf(error: unknown): string {
  if (error instanceof Error && 'detail' in error && typeof error.detail === 'string')
    return clip(error.detail, 300)
  return 'it could not be built.'
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
