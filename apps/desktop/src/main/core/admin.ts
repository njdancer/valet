// The admin tools' reader (docs/admin-tools.md): the control panel's own views, mapped field by
// field to what @valet/mcp-server's valet_ tools return. What an agent doesn't need is left out
// here, by not being copied: a login's 1Password item (its id and title), manifest notes, a call's
// detail line and its output preview (both site text), the auth partition's name. The tools then
// parse every result against their schemas and scan it for the app's known secrets.

import {
  type AuditEvent,
  type AuditRecord,
  callRef,
  ERROR_CLASSES,
  NEEDS_USER_REASONS,
  STAGES,
} from '@valet/core'
import {
  type AdminAdapterDetail,
  type AdminAdapterList,
  type AdminAuditPage,
  type AdminAuditQuery,
  type AdminCallList,
  type AdminCallTrace,
  type AdminHealth,
  type AdminNeedsYou,
  type AdminReader,
  type AdminScope,
  type AdminStatus,
  type AdminTraceStep,
  type AdminWriter,
  type FeedbackDesk,
  identityLabel,
  matchCalls,
  mcpToolName,
} from '@valet/mcp-server'
import {
  type AdapterDetail,
  type AdapterSummary,
  type AgentRequestItem,
  type AttentionItem,
  type ChainStatus,
  MISSED_KEEP_MS,
  type PreviewPart,
  type RunSummary,
  type ToolInfo,
  type TraceStep,
} from '../../shared/api'
import type { MainApi } from './ipc'
import { attentionTitle } from './notifications'

/** What the reader needs from the app besides its API. */
export interface AdminSource {
  readonly api: Pick<
    MainApi,
    'adapters' | 'runs' | 'audit' | 'attention' | 'health' | 'updates' | 'app' | 'remote' | 'grants'
  >
  /** Every installed site in full, from one pass over the app's state. */
  readonly adapterDetails: () => Promise<readonly AdapterDetail[]>
  /** Every call the log has, oldest first, with the credential that made it (`local:<id>`). */
  readonly callIndex: () => Promise<
    readonly { readonly callId: string; readonly startedAt: string; readonly clientId: string | null }[]
  >
  /** What a local app may see (its stored capabilities); null for one the app doesn't know. */
  readonly access: (clientId: string) => {
    readonly seeValet: boolean
    readonly allActivity: boolean
    readonly askForChanges: boolean
    readonly name: string
  } | null
  /**
   * What an approved cloud agent may see (signed capabilities only, never `clients.json`); null
   * for one the app doesn't know or nobody approved.
   */
  readonly remoteAccess?: (clientId: string) => {
    readonly seeValet: boolean
    readonly allActivity: boolean
    readonly askForChanges: boolean
    readonly name: string
  } | null
  readonly lockedDown: () => boolean
  /** The tools on for cloud agents now, as `<adapterId>.<tool>`. */
  readonly remoteTools: () => ReadonlySet<string>
  /** True when any of the texts holds a login secret or session value the app knows of now. */
  readonly sensitive: (texts: readonly string[]) => Promise<boolean>
  readonly withheld: (tool: string) => void
  /** The write tier (admin-writer.ts); absent, the read tools only. */
  readonly writer?: AdminWriter
  /** Agents' feedback (feedback.ts); absent, no feedback tools. */
  readonly feedback?: FeedbackDesk
}

export function adminReader(source: AdminSource): AdminReader {
  const { api } = source
  return {
    lockedDown: () => source.lockedDown(),
    // A local app the person added, by its stored capabilities; a cloud agent, by what the person
    // signed for it. Anything else sees nothing.
    access: (viewer) =>
      (viewer.origin === 'local'
        ? source.access(viewer.clientId)
        : (source.remoteAccess?.(viewer.clientId) ?? null)) ?? {
        seeValet: false,
        allActivity: false,
        askForChanges: false,
        name: 'This app',
      },
    ...(source.writer === undefined ? {} : { writer: source.writer }),
    ...(source.feedback === undefined ? {} : { feedback: source.feedback }),
    sensitive: (texts) => source.sensitive(texts),
    withheld: (tool) => source.withheld(tool),

    async status(): Promise<AdminStatus> {
      const [app, updates, chain, attention, today, adapters, remote, providers] = await Promise.all([
        api.app.status(),
        api.updates.status(),
        api.audit.chainStatus(),
        api.attention.list(),
        api.runs.statsToday(),
        api.adapters.list(),
        api.remote.setup(),
        api.grants.providers(),
      ])
      return {
        version: app.version,
        demo: app.demo,
        paused: app.paused,
        lockedDown: app.lockedDown,
        updates: { state: updates.state, available: updates.available, checkedAt: updates.checkedAt },
        auditChain: chainOf(chain),
        needsYou: attention.length,
        sites: {
          installed: adapters.length,
          approved: adapters.filter((a) => a.approval === 'approved').length,
          paused: adapters.filter((a) => a.paused).length,
        },
        today: {
          toolCalls: today.toolCalls,
          logins: today.logins,
          loginsFailed: today.loginsFailed,
          blockedRequests: today.blockedRequests,
        },
        remoteAccess: { enabled: remote.enabled, listening: remote.listening },
        loginProviders: providers.map((p) => ({
          kind: p.kind,
          available: p.available,
          unavailableReason: p.unavailableReason,
        })),
      }
    },

    async adapters(): Promise<AdminAdapterList> {
      const remote = source.remoteTools()
      return { adapters: (await source.adapterDetails()).map((d) => adapterEntry(d, d.tools, remote)) }
    },

    async adapter(adapterId): Promise<AdminAdapterDetail> {
      const detail = await api.adapters.get(adapterId)
      if (detail === null) return { adapter: null }
      return { adapter: adapterDetail(detail, source.remoteTools()) }
    },

    async health(): Promise<AdminHealth> {
      return {
        sites: (await api.health.sites()).map((site) => ({
          host: site.host,
          adapterIds: [...site.adapterIds],
          breaker: site.breaker,
          retryAt: site.retryAt,
          cause: site.cause,
          lastOpenedAt: site.lastOpenedAt,
          nextCooldownSeconds: site.nextCooldownSeconds,
          calls: site.calls,
        })),
      }
    },

    async needsYou(): Promise<AdminNeedsYou> {
      // An agent sees its own requests with valet_get_approval, never another agent's.
      return {
        items: (await api.attention.list())
          .filter((item): item is Exclude<AttentionItem, AgentRequestItem> => item.kind !== 'agent-request')
          .map(needsYouItem),
      }
    },

    async calls(query, scope): Promise<AdminCallList> {
      const adapterId = query.adapterId === undefined ? {} : { adapterId: query.adapterId }
      if (scope.all)
        return { calls: (await api.runs.list({ ...adapterId, limit: query.limit })).map(callEntry) }
      const own = ownCalls(await source.callIndex(), scope)
      const runs = await api.runs.list({ ...adapterId, limit: ALL })
      return {
        calls: runs
          .filter((run) => own.has(run.callId))
          .slice(0, query.limit)
          .map(callEntry),
      }
    },

    async call(idOrRef, scope): Promise<AdminCallTrace> {
      // Newest first, as the app lists them.
      const index = [...(await source.callIndex())].reverse()
      const mine = identityLabel(scope.viewer)
      // Without All, only the app's own calls are matched, so a short ref can't list another
      // agent's call ids.
      const visible = scope.all ? index : index.filter((c) => c.clientId === mine)
      const matches = matchCalls(visible, idOrRef)
      const [only] = matches
      if (only === undefined) {
        const elsewhere = !scope.all && matchCalls(index, idOrRef).length > 0
        return { call: null, matches: [], otherAgent: elsewhere }
      }
      if (matches.length > 1) {
        return {
          call: null,
          matches: matches.map((m) => ({
            callId: m.callId,
            callRef: callRef(m.callId),
            startedAt: m.startedAt,
          })),
          otherAgent: false,
        }
      }
      const trace = await api.runs.trace(only.callId)
      if (trace === null) return { call: null, matches: [], otherAgent: false }
      return {
        call: {
          summary: callEntry(trace.summary),
          adapterVersion: trace.adapterVersion,
          loginsUsed: trace.secretsUsed.map((s) => ({ secret: s.secret, field: s.field })),
          requests: {
            sent: trace.requests.sent,
            probes: trace.requests.probes,
            blocked: trace.requests.blocked,
          },
          // Visible only as the app's own call, or with All agents' activity.
          input: previewText(trace.input),
          steps: trace.steps.map(stepEntry),
        },
        matches: [],
        otherAgent: false,
      }
    },

    async audit(query: AdminAuditQuery, scope): Promise<AdminAuditPage> {
      const filters = {
        ...(query.category === undefined ? {} : { category: query.category }),
        ...(query.adapterId === undefined ? {} : { adapterId: query.adapterId }),
        ...(query.since === undefined ? {} : { since: query.since }),
        ...(query.search === undefined ? {} : { search: query.search }),
      }
      const chain = chainOf(await api.audit.chainStatus())
      const entry = (r: AuditRecord) => ({ seq: r.seq, at: r.at, event: eventEntry(r.event) })
      if (scope.all) {
        const page = await api.audit.page({
          ...filters,
          ...(query.beforeSeq === undefined ? {} : { beforeSeq: query.beforeSeq }),
          limit: query.limit,
        })
        // Each event as the log has it: fixed vocabularies, no values (packages/core/src/audit.ts).
        return {
          records: page.records.map(entry),
          total: page.total,
          nextBeforeSeq: page.nextBeforeSeq,
          chain,
        }
      }
      // Without All: every record but those about another agent's calls, paged here so the total
      // and the next page count only what this app may see.
      const others = otherCalls(await source.callIndex(), scope)
      const mine = identityLabel(scope.viewer)
      const visible = (await api.audit.page({ ...filters, limit: ALL })).records.filter(
        (r) => !aboutOtherAgent(r.event, others, mine),
      )
      const before = query.beforeSeq
      const page = before === undefined ? visible : visible.filter((r) => r.seq < before)
      const shown = page.slice(0, query.limit)
      const last = shown.at(-1)
      return {
        records: shown.map(entry),
        total: visible.length,
        nextBeforeSeq: page.length > shown.length && last !== undefined ? last.seq : null,
        chain,
      }
    },
  }
}

type Flat = string | number | boolean | null | readonly string[]

/** Copies only the named keys, and only flat values: a list of strings at most. */
function pick(from: object, keys: readonly string[]): Record<string, Flat> {
  const out: Record<string, Flat> = {}
  for (const key of keys) {
    const value: unknown = (from as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    )
      out[key] = value as Flat
  }
  return out
}

/** Each trace step's fields, by its type. A type not listed keeps its common fields only. */
const STEP_FIELDS: Readonly<Record<TraceStep['type'], readonly string[]>> = {
  called: ['client', 'sideEffect'],
  probe: ['partition', 'path', 'status', 'loggedIn', 'afterHandoff'],
  'login-started': [],
  'auth-step': ['op', 'detail', 'skipped'],
  'secret-fill': ['selector', 'secret', 'field', 'origin', 'checks'],
  handoff: ['cookies', 'storageKeys', 'cookieDomains'],
  'tool-code': [],
  waited: ['reason', 'waitedMs', 'ahead'],
  request: ['method', 'target', 'initiator', 'decision', 'purpose', 'status', 'blockedReason'],
  confirmation: ['answer'],
  'needs-user': ['reason'],
  failed: ['errorClass'],
  output: ['redactions', 'bytes'],
}

function stepEntry(step: TraceStep): AdminTraceStep {
  return {
    ...pick(step, STEP_FIELDS[step.type] ?? []),
    type: step.type,
    atMs: step.atMs,
    durationMs: step.durationMs,
    stage: step.stage,
  }
}

/**
 * Each audit event's fields, by its type (packages/core/src/audit.ts). Left out: a connection
 * request's `source`, the address the tunnel reported, which is the cloud agent's and not needed.
 */
const EVENT_FIELDS: Readonly<Record<AuditEvent['type'], readonly string[]>> = {
  'adapter-approved': ['adapterId', 'adapterHash', 'version', 'previousHash'],
  'adapter-rejected': ['adapterId', 'adapterHash', 'version'],
  // Adapter packages (docs/adapter-packages.md).
  'adapter-installed': [
    'adapterId',
    'adapterHash',
    'version',
    'source',
    'previousHash',
    'appVersion',
    'preludeHash',
    'compiler',
  ],
  'adapter-activated': ['adapterId', 'adapterHash', 'version', 'previousHash'],
  'adapter-refused': ['adapterId', 'adapterHash', 'reason'],
  'adapter-removed': ['adapterId', 'adapterHash', 'version', 'clientId'],
  'grant-made': ['adapterId', 'adapterHash', 'secret', 'provider', 'origins', 'carriedFrom'],
  'grant-revoked': ['adapterId', 'secret'],
  'grant-copied': ['adapterId', 'secret', 'fields'],
  'tool-called': ['adapterId', 'adapterHash', 'tool', 'client', 'clientId', 'callId'],
  'tool-finished': ['adapterId', 'callId', 'outcome', 'needsUser', 'stage', 'errorClass', 'durationMs'],
  'login-started': ['adapterId', 'callId'],
  'login-finished': ['adapterId', 'outcome', 'needsUser', 'stage', 'errorClass'],
  'secret-used': ['adapterId', 'adapterHash', 'secret', 'field', 'origin', 'callId'],
  'local-access': ['adapterId', 'callId', 'capability', 'errorClass'],
  'request-blocked': [
    'adapterId',
    'method',
    'target',
    'reason',
    'initiator',
    'partition',
    'callId',
    'draftId',
  ],
  'breaker-opened': ['host', 'cause', 'retryAt', 'callId'],
  'breaker-closed': ['host'],
  'update-downloaded': ['from', 'to'],
  'update-installed': ['from', 'to'],
  'remote-state': ['state', 'revokedTokens'],
  'remote-tool': ['adapterId', 'tool', 'enabled', 'sideEffect'],
  'setting-changed': ['adapterId', 'setting', 'cleared'],
  'remote-consent': ['clientId', 'clientHost', 'tools', 'answer'],
  'remote-revoked': ['clientId', 'clients'],
  'remote-token-reuse': ['clientId', 'token'],
  'lock-down': ['locked', 'revokedClients'],
  'site-paused': ['adapterId', 'paused'],
  'call-waited': ['adapterId', 'callId', 'reason', 'waitedMs', 'ahead'],
  confirmation: ['adapterId', 'tool', 'client', 'callId', 'answer'],
  // The approval broker's (D). The request's digest names its text, which isn't here.
  'approval-requested': ['requestId', 'kind', 'digest', 'clientId'],
  'approval-answered': ['requestId', 'answer', 'deviceId', 'reason'],
  'agent-change': ['clientId', 'action', 'target', 'value'],
  'device-paired': ['deviceId', 'platform'],
  'device-revoked': ['deviceId', 'by'],
  'store-refused': ['store', 'reason', 'records'],
  'draft-created': ['draftId', 'adapterId', 'clientId'],
  'draft-submitted': ['draftId', 'adapterId', 'clientId', 'adapterHash', 'packageHash', 'requestId'],
  'draft-deleted': ['draftId', 'adapterId', 'clientId'],
  'draft-trial': ['draftId', 'adapterId', 'clientId', 'tool', 'host', 'packageHash', 'outcome', 'blocked'],
}

function eventEntry(event: AuditEvent): AdminAuditPage['records'][number]['event'] {
  // A type this build doesn't know (a newer log): its type alone.
  return { ...pick(event, EVENT_FIELDS[event.type] ?? []), type: event.type }
}

/** Every call, for filtering by whose it is. */
const ALL = Number.MAX_SAFE_INTEGER

type CallIndex = Awaited<ReturnType<AdminSource['callIndex']>>

function ownCalls(index: CallIndex, scope: AdminScope): Set<string> {
  const mine = identityLabel(scope.viewer)
  return new Set(index.filter((c) => c.clientId === mine).map((c) => c.callId))
}

/** Calls another credential made, or one the log doesn't name (older records): not this app's. */
function otherCalls(index: CallIndex, scope: AdminScope): Set<string> {
  const mine = identityLabel(scope.viewer)
  return new Set(index.filter((c) => c.clientId !== mine).map((c) => c.callId))
}

/** A record of another agent's: about one of its calls, or an approval it asked for. */
function aboutOtherAgent(event: AuditEvent, others: ReadonlySet<string>, mine: string): boolean {
  if (event.type === 'approval-requested') return event.clientId !== null && event.clientId !== mine
  const callId = 'callId' in event ? event.callId : null
  return typeof callId === 'string' && others.has(callId)
}

function chainOf(chain: ChainStatus): AdminStatus['auditChain'] {
  switch (chain.state) {
    case 'unverified':
      return { state: 'unverified', records: null, firstBadSeq: null, verifiedAt: null }
    case 'intact':
      return { state: 'intact', records: chain.records, firstBadSeq: null, verifiedAt: chain.verifiedAt }
    case 'broken':
      return {
        state: 'broken',
        records: chain.records,
        firstBadSeq: chain.firstBadSeq,
        verifiedAt: chain.verifiedAt,
      }
  }
}

type AdapterEntry = AdminAdapterList['adapters'][number]

function adapterEntry(
  summary: AdapterSummary,
  tools: readonly ToolInfo[],
  remote: ReadonlySet<string>,
): AdapterEntry {
  const approved = summary.approval === 'approved'
  return {
    id: summary.id,
    name: summary.name,
    site: summary.site,
    version: summary.version,
    approval: summary.approval,
    updateWaiting: summary.pendingUpdate?.version ?? null,
    paused: summary.paused,
    session: { state: summary.session.state, checkedAt: summary.session.checkedAt },
    settingsNeeded: [...summary.settingsNeeded],
    logins: summary.secrets.map((s) => ({ name: s.name, given: s.granted })),
    calls7d: summary.calls7d,
    tools: tools.map((tool) => ({
      name: tool.name,
      mcpName: approved && !tool.internal ? mcpToolName(summary.id, tool.name) : null,
      title: tool.title,
      sideEffect: tool.sideEffect,
      calls7d: tool.calls7d,
      remote: remote.has(`${summary.id}.${tool.name}`),
      internal: tool.internal,
    })),
  }
}

function adapterDetail(
  detail: AdapterDetail,
  remote: ReadonlySet<string>,
): NonNullable<AdminAdapterDetail['adapter']> {
  return {
    ...adapterEntry(detail, detail.tools, remote),
    description: detail.description,
    approvedAt: detail.approvedAt,
    navigation: [...detail.navigation],
    limits: {
      requestsPerRun: detail.limits.requestsPerRun,
      minGapMs: detail.limits.minGapMs,
      cooldownSeconds: detail.limits.cooldownSeconds,
      maxCooldownSeconds: detail.limits.maxCooldownSeconds,
    },
    settings: detail.settings.map((setting) => ({
      name: setting.name,
      title: setting.title,
      required: setting.required,
      chosen:
        setting.chosen === null
          ? null
          : { label: setting.chosen.label, detail: setting.chosen.detail, chosenAt: setting.chosen.chosenAt },
    })),
    // Never the grant's item: which 1Password item it is (id and title) is the person's business.
    loginDetails: detail.secretRequests.map((request) => ({
      name: request.name,
      fields: [...request.fields],
      origins: [...request.origins],
      given:
        request.grant === null
          ? null
          : {
              provider: request.grant.provider,
              origins: [...request.grant.origins],
              givenAt: request.grant.grantedAt,
              lastUsedAt: request.grant.lastUsedAt,
            },
    })),
    oneTimeCodes: detail.messagesSources.map((source) => ({ sender: source.sender, given: source.granted })),
  }
}

function needsYouItem(item: Exclude<AttentionItem, AgentRequestItem>): AdminNeedsYou['items'][number] {
  const adapterId = 'adapterId' in item ? item.adapterId : null
  const adapterName = 'adapterName' in item ? item.adapterName : null
  const callId = 'callId' in item ? item.callId : null
  return {
    kind: item.kind,
    id: item.id,
    title: attentionTitle(item),
    adapterId,
    adapterName,
    callId,
    callRef: callId === null ? null : callRef(callId),
    tool: item.kind === 'confirmation' || item.kind === 'needs-user' ? item.tool : null,
    at: atOf(item),
    deadline: deadlineOf(item),
  }
}

function atOf(item: Exclude<AttentionItem, AgentRequestItem>): string | null {
  switch (item.kind) {
    case 'confirmation':
    case 'remote-consent':
      return item.requestedAt
    case 'needs-user':
    case 'repair':
    case 'missed':
      return item.at
    // The view has no time for these: they last as long as their cause does.
    case 'review':
    case 'setting-missing':
    case 'login-missing':
      return null
  }
}

function deadlineOf(item: AttentionItem): string | null {
  switch (item.kind) {
    case 'confirmation':
    case 'remote-consent':
      return item.expiresAt
    case 'needs-user':
      return item.closesAt
    case 'missed': {
      const missed = Date.parse(item.missedAt)
      return Number.isFinite(missed) ? new Date(missed + MISSED_KEEP_MS).toISOString() : null
    }
    default:
      return null
  }
}

function callEntry(run: RunSummary): AdminCallList['calls'][number] {
  return {
    callId: run.callId,
    callRef: callRef(run.callId),
    adapterId: run.adapterId,
    adapterName: run.adapterName,
    tool: run.tool,
    sideEffect: run.sideEffect,
    client: run.client,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    // The log is read without checks: a code this build doesn't know is null (or `unknown`), so
    // one old record can't fail the page it is on.
    outcome: OUTCOMES.includes(run.outcome) ? run.outcome : 'unknown',
    needsUser: known(NEEDS_USER_REASONS, run.needsUser),
    stage: known(STAGES, run.stage),
    errorClass: known(ERROR_CLASSES, run.errorClass),
    blockedRequests: run.blockedRequests,
  }
}

const OUTCOMES: readonly string[] = ['ok', 'needsUser', 'failed', 'blocked', 'declined', 'running']

function known<T extends string>(codes: readonly T[], code: T | null): T | null {
  return code !== null && codes.includes(code) ? code : null
}

/** A redacted preview as one string, each redaction as [redacted]. */
export function previewText(parts: readonly PreviewPart[]): string {
  return parts.map((part) => (part.kind === 'text' ? part.text : '[redacted]')).join('')
}
