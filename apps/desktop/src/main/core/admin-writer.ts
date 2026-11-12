// The app's side of Valet's write tools (docs/admin-tools.md, "Write tier"): the AdminWriter the
// MCP endpoint calls. It decides every change's tier from the app's own tables, never from the
// agent: a change that only makes Valet stricter is made at once, audited and told to the person
// (Notify only); anything that widens is an approval request through the broker, built by the
// broker's own subject builders (approvals/subjects.ts), and nothing happens until a device signs.
//
// Nothing here answers a request. An agent can see and withdraw only its own requests, turn tools
// off only for itself, and disconnect only itself. Plain TypeScript over a port, so it is tested
// without Electron.

import type { ApprovalKind, ApprovalSubject, Requester } from '@valet/core'
import {
  type AdminWriter,
  AGENT_SETTING_LABELS,
  type AgentSetting,
  type ChangeView,
  type ClientIdentity,
  identityLabel,
  type RequestView,
  type WriteOutcome,
  type WriteRefusal,
} from '@valet/mcp-server'
import type { Closed, RequestRefusal, RequestResult } from './approvals/broker'

/** Notify-only changes one agent may make in an hour (R57). */
export const NOTIFY_PER_HOUR = 10
const HOUR_MS = 3600_000
/** How long an answered request is remembered for valet_get_approval and valet_list_changes. */
const REMEMBER_MS = 24 * HOUR_MS
/** Requests remembered per agent, and changes in all. */
const MAX_REMEMBERED = 50
const MAX_CHANGES = 200

/** Valet's own settings as the agent tools name them, and their values now. */
export type AgentSettingValues = Readonly<Record<AgentSetting, boolean | number>>

/** The broker, as far as an agent's requests go. Nothing here answers one. */
export interface AgentBroker {
  request<K extends ApprovalKind>(
    kind: K,
    subject: ApprovalSubject<K>,
    requester: Requester,
    agentNote: string | null,
  ): Promise<RequestResult>
  status(requestId: string, asker: Requester): { readonly state: 'pending' } | Closed | null
  withdraw(requestId: string, asker: Requester): Promise<boolean>
  /** Every waiting request: id, ref, kind, asker, and when it was made and ends. */
  waiting(): readonly {
    readonly requestId: string
    readonly ref: string
    readonly kind: ApprovalKind
    readonly requester: Requester
    readonly createdAt: string
    readonly expiresAt: string
  }[]
  /** The Mac's own device id: an approval signed by it was made at the Mac. */
  readonly macId: string
}

/** The adapter-setting request as the app built it, or why it couldn't. */
export type AdapterSettingAsk =
  | {
      readonly ok: true
      readonly subject: ApprovalSubject<'setting'>
      /** The card's title, e.g. `Choose the store for Woolworths`. */
      readonly title: string
    }
  | { readonly ok: false; readonly reason: 'not-found' | 'no-choices' | 'unavailable' }

export interface WriterSource {
  now(): number
  lockedDown(): boolean
  /** An active local client the person added: its id and the person's name for it. Null otherwise. */
  client(viewer: ClientIdentity): { readonly name: string } | null
  /** Null while the broker isn't running. */
  broker(): AgentBroker | null
  /** Kinds the app has wired to act on an approval (service.wiredKinds()). */
  wiredKinds(): ReadonlySet<ApprovalKind>
  /** At least one phone is paired, so the person was told there too. */
  phonePaired(): boolean
  settings(): AgentSettingValues
  /** Whether setting `name` from `from` to `to` widens (approvals/subjects.ts settingWidens). */
  widens(name: AgentSetting, from: boolean | number, to: boolean | number): boolean
  /** The signed subject for a widening change (approvals/subjects.ts settingSubject). */
  settingSubject(name: AgentSetting, from: boolean | number, to: boolean | number): ApprovalSubject<'setting'>
  /** Makes a change that doesn't widen. */
  applySetting(name: AgentSetting, value: boolean | number): Promise<void>
  /** Fetches the adapter's own choices and builds the request (adapterSettingSubject). */
  adapterSetting(adapterId: string, setting: string, query: string | null): Promise<AdapterSettingAsk>
  /**
   * A site tool this client may call now, with the names the person approved with the adapter;
   * null for anything else (an unknown tool, a setting's own tool, an unapproved adapter).
   */
  tool(adapterId: string, tool: string): { readonly adapterName: string; readonly title: string } | null
  turnOffTool(clientId: string, qualified: string): Promise<'done' | 'already' | 'not-found'>
  /** Revokes the client (its token stops working) and withdraws its requests. */
  disconnect(clientId: string): Promise<boolean>
  /** Audits a Notify-only change. A change that can't be audited isn't made. */
  audit(event: {
    readonly clientId: string
    readonly action: 'tool-off' | 'setting' | 'disconnect'
    readonly target: string
    readonly value: string | null
  }): Promise<void>
  /** Tells the person, quietly: one notification per agent per hour, counting its changes. */
  told(clientId: string, clientName: string, changesThisHour: number): void
}

interface Asked {
  readonly requestId: string
  readonly ref: string
  readonly title: string
  readonly askedAt: string
  readonly expiresAt: string
  told: boolean
  closedAt: number | null
}

interface Change {
  readonly clientId: string
  readonly at: string
  readonly what: string
  readonly tier: 'notify' | 'approve'
  readonly requestId: string | null
}

const SETTING_VALUE_WORDS = (name: AgentSetting, value: boolean | number): string => {
  if (name === 'traceRetentionDays') return `${value} ${value === 1 ? 'day' : 'days'}`
  return value === true ? 'on' : 'off'
}

export class AdminWriterImpl implements AdminWriter {
  private readonly asked = new Map<string, Asked[]>()
  private readonly notifyTimes = new Map<string, number[]>()
  private readonly changeLog: Change[] = []

  constructor(private readonly source: WriterSource) {}

  async setSetting(
    viewer: ClientIdentity,
    setting: AgentSetting,
    value: boolean | number,
    note: string | null,
  ): Promise<WriteOutcome> {
    const gate = this.gate(viewer)
    if (gate.refused !== undefined) return gate.refused
    const from = this.source.settings()[setting]
    if (typeof from !== typeof value) return refused('not-found')
    const label = AGENT_SETTING_LABELS[setting]
    if (from === value)
      return { kind: 'unchanged', current: `${label} is already ${SETTING_VALUE_WORDS(setting, from)}` }
    if (this.source.widens(setting, from, value)) {
      return this.ask(
        viewer,
        gate.name,
        'setting',
        this.source.settingSubject(setting, from, value),
        note,
        `Change a setting: ${label}`,
      )
    }
    const limited = this.notifyLimit(viewer)
    if (limited !== null) return limited
    const what = `${label} set to ${SETTING_VALUE_WORDS(setting, value)}`
    try {
      await this.source.audit({
        clientId: identityLabel(viewer),
        action: 'setting',
        target: setting,
        value: String(value),
      })
      await this.source.applySetting(setting, value)
    } catch {
      return refused('unavailable')
    }
    this.notified(viewer, gate.name, what)
    return { kind: 'done', what }
  }

  async requestSetting(
    viewer: ClientIdentity,
    adapterId: string,
    setting: string,
    query: string | null,
    note: string | null,
  ): Promise<WriteOutcome> {
    const gate = this.gate(viewer)
    if (gate.refused !== undefined) return gate.refused
    if (!this.source.wiredKinds().has('setting')) return refused('not-available')
    let built: AdapterSettingAsk
    try {
      built = await this.source.adapterSetting(adapterId, setting, query)
    } catch {
      return refused('unavailable')
    }
    if (!built.ok) return refused(built.reason)
    return this.ask(viewer, gate.name, 'setting', built.subject, note, built.title)
  }

  async turnOffTool(viewer: ClientIdentity, adapterId: string, tool: string): Promise<WriteOutcome> {
    const gate = this.gate(viewer)
    if (gate.refused !== undefined) return gate.refused
    const found = this.source.tool(adapterId, tool)
    if (found === null) return refused('not-found')
    const qualified = `${adapterId}.${tool}`
    const what = `"${found.title}" (${found.adapterName}) turned off for you`
    const limited = this.notifyLimit(viewer)
    if (limited !== null) return limited
    let result: 'done' | 'already' | 'not-found'
    try {
      await this.source.audit({
        clientId: identityLabel(viewer),
        action: 'tool-off',
        target: qualified,
        value: null,
      })
      result = await this.source.turnOffTool(viewer.clientId, qualified)
    } catch {
      return refused('unavailable')
    }
    if (result === 'not-found') return refused('not-found')
    if (result === 'already') return { kind: 'unchanged', current: `"${found.title}" is already off for you` }
    this.notified(viewer, gate.name, what)
    return { kind: 'done', what }
  }

  async disconnect(viewer: ClientIdentity): Promise<WriteOutcome> {
    const gate = this.gate(viewer)
    if (gate.refused !== undefined) return gate.refused
    // Not counted against the hourly limit: an agent leaving must always be able to.
    try {
      await this.source.audit({
        clientId: identityLabel(viewer),
        action: 'disconnect',
        target: identityLabel(viewer),
        value: null,
      })
      if (!(await this.source.disconnect(viewer.clientId))) return refused('not-found')
    } catch {
      return refused('unavailable')
    }
    this.record(viewer, 'Disconnected itself', 'notify', null)
    this.source.told(identityLabel(viewer), gate.name, this.recentNotify(viewer).length + 1)
    return { kind: 'done', what: 'you are disconnected from Valet. Your token stops working in a moment' }
  }

  async approvals(viewer: ClientIdentity, ref: string | null): Promise<readonly RequestView[]> {
    const views = this.views(viewer)
    return ref === null ? views : views.filter((v) => v.ref === ref.toUpperCase())
  }

  async withdraw(viewer: ClientIdentity, ref: string): Promise<'withdrawn' | 'not-found' | 'closed'> {
    const broker = this.source.broker()
    if (broker === null || this.source.client(viewer) === null) return 'not-found'
    const asker = this.requester(viewer, '')
    const mine = this.known(viewer).filter((a) => a.ref === ref.toUpperCase())
    if (mine.length === 0) return 'not-found'
    let any: 'withdrawn' | 'closed' = 'closed'
    for (const a of mine) {
      const status = broker.status(a.requestId, asker)
      if (status === null || !('state' in status)) continue
      if (await broker.withdraw(a.requestId, asker)) any = 'withdrawn'
    }
    return any
  }

  async answers(viewer: ClientIdentity): Promise<readonly RequestView[]> {
    const broker = this.source.broker()
    if (broker === null) return []
    const out: RequestView[] = []
    for (const a of this.asked.get(identityLabel(viewer)) ?? []) {
      if (a.told) continue
      const view = this.view(a, broker, viewer)
      if (view === null || view.state === 'waiting') continue
      a.told = true
      out.push(view)
    }
    return out
  }

  async changes(viewer: ClientIdentity, all: boolean, limit: number): Promise<readonly ChangeView[]> {
    const me = identityLabel(viewer)
    const broker = this.source.broker()
    const rows: ChangeView[] = []
    for (const change of [...this.changeLog].reverse()) {
      if (rows.length >= limit) break
      const mine = change.clientId === me
      if (!mine && !all) continue
      let approval: ChangeView['approval'] = null
      if (change.requestId !== null) {
        const asked = (this.asked.get(change.clientId) ?? []).find((a) => a.requestId === change.requestId)
        const view =
          asked === undefined || broker === null ? null : this.view(asked, broker, clientOf(change.clientId))
        approval = view === null ? null : { ref: view.ref, state: view.state }
      }
      rows.push({
        at: change.at,
        what: change.what,
        tier: change.tier,
        approval,
        agent: this.source.client(clientOf(change.clientId))?.name ?? 'A removed agent',
        mine,
      })
    }
    return rows
  }

  // ---------- Internals ----------

  /** Locked down, or a client the person no longer has: refused before anything else. */
  private gate(viewer: ClientIdentity): { readonly refused?: WriteOutcome; readonly name: string } {
    if (this.source.lockedDown()) return { refused: refused('locked-down'), name: '' }
    if (viewer.origin !== 'local') return { refused: refused('not-allowed'), name: '' }
    const client = this.source.client(viewer)
    if (client === null) return { refused: refused('not-found'), name: '' }
    return { name: client.name }
  }

  private requester(viewer: ClientIdentity, name: string): Requester {
    return { kind: 'agent', clientId: identityLabel(viewer), clientName: name }
  }

  private async ask(
    viewer: ClientIdentity,
    name: string,
    kind: 'setting',
    subject: ApprovalSubject<'setting'>,
    note: string | null,
    title: string,
  ): Promise<WriteOutcome> {
    if (!this.source.wiredKinds().has(kind)) return refused('not-available')
    const broker = this.source.broker()
    if (broker === null) return refused('unavailable')
    let result: RequestResult
    try {
      result = await broker.request(kind, subject, this.requester(viewer, displayName(name)), note)
    } catch {
      return refused('unavailable')
    }
    if (!result.ok)
      return {
        kind: 'refused',
        reason: refusal(result.reason),
        ...(result.until === undefined ? {} : { until: result.until }),
      }
    const key = identityLabel(viewer)
    const list = this.asked.get(key) ?? []
    let asked = list.find((a) => a.requestId === result.requestId)
    if (asked === undefined) {
      asked = {
        requestId: result.requestId,
        ref: result.ref,
        title,
        askedAt: new Date(this.source.now()).toISOString(),
        expiresAt: result.expiresAt,
        told: false,
        closedAt: null,
      }
      list.push(asked)
      this.asked.set(key, this.prune(list))
      this.record(viewer, title, 'approve', result.requestId)
    }
    const view = this.view(asked, broker, viewer)
    if (view === null) return refused('unavailable')
    return { kind: 'asked', request: view, reused: result.reused }
  }

  /** This agent's remembered requests, plus any waiting ones the broker holds from before a restart. */
  private known(viewer: ClientIdentity): Asked[] {
    const key = identityLabel(viewer)
    const list = this.asked.get(key) ?? []
    const broker = this.source.broker()
    if (broker !== null) {
      for (const w of broker.waiting()) {
        if (w.requester.kind !== 'agent' || w.requester.clientId !== key) continue
        if (list.some((a) => a.requestId === w.requestId)) continue
        list.push({
          requestId: w.requestId,
          ref: w.ref,
          title: TITLE_BY_KIND[w.kind],
          askedAt: w.createdAt,
          expiresAt: w.expiresAt,
          told: false,
          closedAt: null,
        })
      }
      this.asked.set(key, list)
    }
    return list
  }

  private views(viewer: ClientIdentity): RequestView[] {
    const broker = this.source.broker()
    if (broker === null) return []
    return this.known(viewer)
      .map((a) => this.view(a, broker, viewer))
      .filter((v): v is RequestView => v !== null)
      .reverse()
  }

  private view(a: Asked, broker: AgentBroker, viewer: ClientIdentity): RequestView | null {
    const status = broker.status(a.requestId, this.requester(viewer, ''))
    const base = { ref: a.ref, title: a.title, askedAt: a.askedAt }
    if (status === null) return null
    if ('state' in status)
      return {
        ...base,
        state: 'waiting',
        expiresAt: a.expiresAt,
        where: this.source.phonePaired() ? 'mac-and-phone' : 'mac',
      }
    a.closedAt ??= Date.parse(status.at)
    switch (status.outcome) {
      case 'approved':
        return {
          ...base,
          state: 'approved',
          at: status.at,
          device: status.deviceId === broker.macId ? 'mac' : 'phone',
        }
      case 'declined':
        return { ...base, state: 'declined', at: status.at, note: status.note ?? null }
      case 'expired':
        return { ...base, state: 'expired', at: status.at }
      case 'withdrawn':
        return { ...base, state: 'withdrawn', at: status.at, reason: withdrawnReason(status.reason) }
    }
  }

  /** Drops requests closed more than a day ago, and the oldest past the cap. */
  private prune(list: Asked[]): Asked[] {
    const now = this.source.now()
    const kept = list.filter((a) => a.closedAt === null || now - a.closedAt < REMEMBER_MS)
    return kept.slice(-MAX_REMEMBERED)
  }

  private recentNotify(viewer: ClientIdentity): number[] {
    const now = this.source.now()
    const times = (this.notifyTimes.get(identityLabel(viewer)) ?? []).filter((t) => now - t < HOUR_MS)
    this.notifyTimes.set(identityLabel(viewer), times)
    return times
  }

  private notifyLimit(viewer: ClientIdentity): WriteOutcome | null {
    const times = this.recentNotify(viewer)
    if (times.length < NOTIFY_PER_HOUR) return null
    const until = new Date((times[0] ?? this.source.now()) + HOUR_MS).toISOString()
    return { kind: 'refused', reason: 'too-many-changes', until }
  }

  private notified(viewer: ClientIdentity, name: string, what: string): void {
    const times = this.recentNotify(viewer)
    times.push(this.source.now())
    this.record(viewer, what, 'notify', null)
    try {
      this.source.told(identityLabel(viewer), name, times.length)
    } catch {
      // Telling is best effort: the change is made and audited.
    }
  }

  private record(
    viewer: ClientIdentity,
    what: string,
    tier: 'notify' | 'approve',
    requestId: string | null,
  ): void {
    this.changeLog.push({
      clientId: identityLabel(viewer),
      at: new Date(this.source.now()).toISOString(),
      what: capitalise(what),
      tier,
      requestId,
    })
    if (this.changeLog.length > MAX_CHANGES) this.changeLog.splice(0, this.changeLog.length - MAX_CHANGES)
  }
}

const TITLE_BY_KIND: Readonly<Record<ApprovalKind, string>> = {
  'adapter-install': 'Install or update a site',
  'secret-grant': 'Let a site use a login',
  'tool-enable': 'Turn on a tool',
  'remote-client': 'Let a remote agent connect',
  setting: 'Change a setting',
  'authoring-session': 'Use a signed-in session',
  'private-network': 'Reach the home network',
  'irreversible-call': 'Confirm a call',
  resume: 'Resume Valet',
  'device-pair': 'Pair a device',
}

function refused(reason: WriteRefusal): WriteOutcome {
  return { kind: 'refused', reason }
}

function refusal(reason: RequestRefusal): WriteRefusal {
  switch (reason) {
    case 'too-many-consents':
      return 'too-many-total'
    default:
      return reason
  }
}

function withdrawnReason(reason: Closed['reason']): Extract<RequestView, { state: 'withdrawn' }>['reason'] {
  switch (reason) {
    case 'asker':
    case 'replaced':
    case 'stale':
    case 'lockdown':
    case 'client-revoked':
    case 'restarted':
      return reason
    default:
      return 'other'
  }
}

function clientOf(label: string): ClientIdentity {
  const [origin, ...rest] = label.split(':')
  return { origin: origin === 'remote' ? 'remote' : 'local', clientId: rest.join(':') }
}

/** The person's name for the client, as the requester's label: display text of at most 100. */
function displayName(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim().slice(0, 100)
  return flat.length > 0 ? flat : 'An agent'
}

function capitalise(s: string): string {
  return s.length === 0 ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`
}
