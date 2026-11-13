// Valet's own tools that change something (docs/admin-tools.md, "Write tier"). An agent may make a
// change that only makes Valet stricter (Notify only: done at once, audited, the person told), or
// ask for one that loosens it (an approval request the person answers with Face ID or Touch ID).
// No tool here approves, undoes, unlocks, pairs or changes what an agent may do: those are the
// person's alone (docs/ux/agent-run/information-architecture.md, section 5).
//
// The tier is never the agent's to choose. The app decides from its own tables whether a change
// tightens or loosens (AdminWriter.setSetting); this package only words the outcome. Every
// sentence an agent reads is here, built from codes, refs, times and the names the person approved
// with an adapter. The agent's own note goes only into the request, never back into a result.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { clockTime, plainName } from '@valet/core'
import { z } from 'zod'
import type { ClientIdentity } from './auth'

/** A request's short reference, as the card's kind strip shows it ("7B3F"). */
const REF = /^[0-9A-Fa-f]{4}$/
/** The manifest's id and tool-name patterns (packages/core/src/manifest.ts). */
const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const SETTING_NAME = /^[a-z][a-zA-Z0-9_-]{0,63}$/

/**
 * Valet's own settings an agent may change or ask to change. Anything else is the person's. Not
 * remote access: turning it off revokes every cloud agent's tokens, which changes other agents'
 * connections, and an agent never does that (IA section 5).
 */
export const AGENT_SETTINGS = ['messagesOtpEnabled', 'notifications', 'traceRetentionDays'] as const
export type AgentSetting = (typeof AGENT_SETTINGS)[number]

/** The person's words for each, as Settings shows them. */
export const AGENT_SETTING_LABELS: Readonly<Record<AgentSetting, string>> = {
  messagesOtpEnabled: 'Read login codes from Messages',
  notifications: 'Notifications',
  traceRetentionDays: 'Keep call details for',
}

/** Why a change or a request was refused. Codes only; the sentences are below. */
export type WriteRefusal =
  /** Valet is locked down (checked before anything else, like the read tools). */
  | 'locked-down'
  /** The approval broker isn't running, or the store couldn't be written. */
  | 'unavailable'
  /** No such adapter, tool, setting or request, as far as this agent may know. */
  | 'not-found'
  /** The kind of request isn't wired up in this build yet. */
  | 'not-available'
  /** A tool already turned off by the person, a setting tool, or anything else agents can't touch. */
  | 'not-allowed'
  /** 3 requests of this agent's are already waiting. */
  | 'too-many-waiting'
  /** 5 requests from all agents are already waiting. */
  | 'too-many-total'
  /** The person declined 3 of this agent's requests in an hour, or said to stop asking. */
  | 'cooling-down'
  /** 20 requests from this agent today. */
  | 'daily-limit'
  /** 10 Notify-only changes from this agent in the last hour. */
  | 'too-many-changes'
  /** The adapter's list of choices couldn't be read, or had fewer than two. */
  | 'no-choices'

/** How one of the agent's own requests stands. */
export type RequestView = {
  readonly ref: string
  /** The card's title in the app's words, e.g. `Change a setting: Notifications`. */
  readonly title: string
  readonly askedAt: string
} & (
  | {
      readonly state: 'waiting'
      readonly expiresAt: string
      /** Where the person was told: the Mac only, or the Mac and their phone. */
      readonly where: 'mac' | 'mac-and-phone'
    }
  | { readonly state: 'approved'; readonly at: string; readonly device: 'mac' | 'phone' }
  | {
      readonly state: 'declined'
      readonly at: string
      /** The person's own note to the agent, if they wrote one. */
      readonly note: string | null
    }
  | { readonly state: 'expired'; readonly at: string }
  | {
      readonly state: 'withdrawn'
      readonly at: string
      readonly reason: 'asker' | 'replaced' | 'stale' | 'lockdown' | 'client-revoked' | 'restarted' | 'other'
    }
)

/** What a change tool did. */
export type WriteOutcome =
  /** A Notify-only change, done. `what` is the app's words for it. */
  | { readonly kind: 'done'; readonly what: string }
  /** Nothing to do: it is already so. `current` is the app's words for the current value. */
  | { readonly kind: 'unchanged'; readonly current: string }
  /** A request for the person. `reused`: the same request of this agent's was already waiting. */
  | { readonly kind: 'asked'; readonly request: RequestView; readonly reused: boolean }
  | { readonly kind: 'refused'; readonly reason: WriteRefusal; readonly until?: string }

/** One row of valet_list_changes: something an agent changed or asked for. */
export interface ChangeView {
  readonly at: string
  /** The app's words, e.g. `Turned off "Search products" (Woolworths) for itself`. */
  readonly what: string
  readonly tier: 'notify' | 'approve'
  /** For a request: how it stands. */
  readonly approval: { readonly ref: string; readonly state: RequestView['state'] } | null
  /** The person's name for the agent that made it. */
  readonly agent: string
  readonly mine: boolean
}

/**
 * What the write tools need from the app. Every method takes the session's client, which the
 * credential named; the app checks it may act for that client, counts it against the limits, and
 * audits it. Nothing here can answer a request.
 */
export interface AdminWriter {
  /** Valet's own setting. Stricter and deleting nothing: done. Otherwise: a request. */
  setSetting(
    viewer: ClientIdentity,
    setting: AgentSetting,
    value: boolean | number,
    note: string | null,
  ): Promise<WriteOutcome>
  /**
   * An adapter's setting, such as the store: always a request, never a value. The person picks
   * from the adapter's own list on the card. `query` narrows that list (a postcode, a suburb).
   */
  requestSetting(
    viewer: ClientIdentity,
    adapterId: string,
    setting: string,
    query: string | null,
    note: string | null,
  ): Promise<WriteOutcome>
  /** Turns one tool off for this agent only (Notify only). */
  turnOffTool(viewer: ClientIdentity, adapterId: string, tool: string): Promise<WriteOutcome>
  /**
   * Asks the person to remove a site that isn't built in. Nothing is removed until they say yes in
   * Valet; it only ever narrows, so nothing is signed. `asked` once filed, `already` if this agent's
   * ask is waiting, `built-in` for a site the app ships.
   */
  requestRemoval(
    viewer: ClientIdentity,
    adapterId: string,
    note: string | null,
  ): Promise<{ readonly kind: 'removal-asked' | 'removal-already'; readonly siteName: string } | WriteOutcome>
  /** Removes this agent's own connection (Notify only). Its token stops working. */
  disconnect(viewer: ClientIdentity): Promise<WriteOutcome>
  /** One of this agent's requests by ref, or all of them still remembered (newest first). */
  approvals(viewer: ClientIdentity, ref: string | null): Promise<readonly RequestView[]>
  /** Takes back one of this agent's waiting requests. */
  withdraw(viewer: ClientIdentity, ref: string): Promise<'withdrawn' | 'not-found' | 'closed'>
  /**
   * This agent's requests that ended since it was last told (R23), each reported once. Every
   * valet_ result carries them.
   */
  answers(viewer: ClientIdentity): Promise<readonly RequestView[]>
  /** Changes and requests: the agent's own, or every agent's with "All agents' activity". */
  changes(viewer: ClientIdentity, all: boolean, limit: number): Promise<readonly ChangeView[]>
}

/** How results word times: the clock and zone the endpoint uses. */
export interface WriteWording {
  readonly now: () => number
  readonly timeZone?: string
}

// ---------- Wording ----------

export const ASK_NOT_ALLOWED_SUFFIX = 'The person can allow it in Valet, Connections'

/** The refusal for an app the person hasn't let ask for changes. */
export function askNotAllowedResult(name: string): string {
  const app = plainName(name)
  return `${app} isn't allowed to ask for changes. ${ASK_NOT_ALLOWED_SUFFIX}, ${app}.`
}

function clock(at: string, wording: WriteWording): string {
  return clockTime(at, wording.timeZone)
}

/** "12 minutes", "an hour", "3 hours": how long ago, for "asked … ago". */
export function agoText(at: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(at))
  const minutes = Math.round(ms / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'less than a minute'
  if (minutes === 1) return '1 minute'
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour' : `${hours} hours`
}

/** How long a waiting request has left, said plainly. */
function lifeText(request: Extract<RequestView, { state: 'waiting' }>): string {
  const hours = Math.round((Date.parse(request.expiresAt) - Date.parse(request.askedAt)) / 3600_000)
  if (!Number.isFinite(hours) || hours < 1) return 'Requests like this expire after a few minutes.'
  return `Requests expire after ${hours === 1 ? 'an hour' : `${hours} hours`}.`
}

function whereText(where: 'mac' | 'mac-and-phone'): string {
  return where === 'mac' ? 'in Valet on their Mac' : 'on their iPhone and Mac'
}

const WITHDRAWN_BECAUSE: Readonly<Record<Extract<RequestView, { state: 'withdrawn' }>['reason'], string>> = {
  asker: 'you withdrew it',
  replaced: 'a newer request of yours replaced it',
  stale: 'what it would change had already changed',
  lockdown: 'the person locked Valet down',
  'client-revoked': 'the person disconnected this app',
  restarted: 'Valet restarted',
  other: 'it was closed',
}

/** One sentence about one request, as IA section 11 words it. */
export function requestText(request: RequestView, wording: WriteWording): string {
  const ref = `approval ${request.ref}`
  switch (request.state) {
    case 'waiting':
      return `Still waiting: ${ref} ("${request.title}"), asked ${agoText(request.askedAt, wording.now())} ago. The person was notified ${whereText(request.where)}.`
    case 'approved':
      return `Approved by the person at ${clock(request.at, wording)}: ${ref} ("${request.title}"). Valet makes the approved change; read it back before relying on it.`
    case 'declined':
      return request.note === null
        ? `Declined by the person at ${clock(request.at, wording)}: ${ref} ("${request.title}"). Nothing changed.`
        : `Declined by the person at ${clock(request.at, wording)}: ${ref} ("${request.title}"). Their note: "${request.note}". Nothing changed.`
    case 'expired':
      return `Nobody answered ${ref} ("${request.title}") in time, so nothing changed. Ask the person before asking again.`
    case 'withdrawn':
      return `${capitalise(ref)} ("${request.title}") was withdrawn because ${WITHDRAWN_BECAUSE[request.reason]}. Nothing changed.`
  }
}

/** The sentence for a request just made. */
export function askedText(request: RequestView, reused: boolean, wording: WriteWording): string {
  if (request.state !== 'waiting') return requestText(request, wording)
  const ref = `approval ${request.ref}`
  if (reused)
    return `Already waiting for the person: "${request.title}" (${ref}), asked ${agoText(request.askedAt, wording.now())} ago. Nothing changes until they answer.`
  return `Waiting for the person in Valet: "${request.title}" (${ref}). Nothing changes until they answer. ${lifeText(request)} The person was notified ${whereText(request.where)}. Check with valet_get_approval, or see the answer on any later valet_ tool's result.`
}

const REFUSED: Readonly<Record<WriteRefusal, string>> = {
  'locked-down':
    'Valet is locked down by the person, so nothing can be changed or asked for (config: locked-down). Tell the person; only they can unlock it, in the Valet app.',
  unavailable:
    'Not done: Valet couldn’t make the change or the request right now (config: unavailable). Try again shortly.',
  'not-found': 'Not done: Valet has no such site, tool, setting or request for you (config: not-found).',
  'not-available':
    'Not done: this Valet can’t take that request yet (config: not-available). Ask the person to make the change in the Valet app.',
  'not-allowed':
    'Not done: agents can’t change that (config: not-allowed). Only the person can, in the Valet app.',
  'too-many-waiting':
    'Not asked: 3 of your requests are already waiting for the person. Wait for an answer, or withdraw one with valet_withdraw_approval.',
  'too-many-total': 'Not asked: 5 requests are already waiting for the person. Wait for them to answer.',
  'cooling-down':
    'Not asked: the person declined several of your requests recently, so Valet isn’t passing on more for now.',
  'daily-limit': 'Not asked: you’ve made 20 requests today. Valet takes more tomorrow.',
  'too-many-changes': 'Not done: too many changes this hour. Try again later.',
  'no-choices':
    'Not asked: Valet couldn’t get the site’s list of choices for this setting. Try a different search, or ask the person to choose it in the Valet app.',
}

/** The sentence for a refusal, with when to try again if the app gave one. */
export function refusedText(reason: WriteRefusal, until: string | undefined, wording: WriteWording): string {
  const base = REFUSED[reason]
  if (
    until === undefined ||
    (reason !== 'cooling-down' && reason !== 'daily-limit' && reason !== 'too-many-changes')
  )
    return base
  return `${base} Don’t ask again before ${clock(until, wording)}.`
}

/** The whole result of a change tool. */
export function outcomeResult(outcome: WriteOutcome, wording: WriteWording): CallToolResult {
  switch (outcome.kind) {
    case 'done':
      return text(`Done: ${outcome.what}. The person was told in Valet, Activity, Changes.`)
    case 'unchanged':
      return text(`Nothing changed: ${outcome.current}.`)
    case 'asked':
      return text(askedText(outcome.request, outcome.reused, wording))
    case 'refused':
      return text(refusedText(outcome.reason, outcome.until, wording), true)
  }
}

function capitalise(s: string): string {
  return s.length === 0 ? s : `${s[0]?.toUpperCase()}${s.slice(1)}`
}

function text(value: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text: value }], isError: true }
    : { content: [{ type: 'text', text: value }] }
}

// ---------- Inputs ----------

const noteInput = z
  .string()
  .max(280)
  .optional()
  .describe(
    'Why you are asking, in at most 280 characters. The person sees it quoted under "The agent says", ' +
      'never as the request’s title.',
  )

export const writeInputs = {
  setSetting: z.object({
    setting: z
      .enum(AGENT_SETTINGS)
      .describe(
        'messagesOtpEnabled (read login codes from Messages), notifications (Valet’s system notifications), ' +
          'traceRetentionDays (days call details are kept, 1 to 365).',
      ),
    value: z
      .union([z.boolean(), z.number().int().min(1).max(365)])
      .describe('true or false; days for traceRetentionDays.'),
    note: noteInput,
  }),
  requestSetting: z.object({
    adapterId: z
      .string()
      .regex(ADAPTER_ID)
      .describe('The site’s adapter id, as valet_list_adapters gives it.'),
    setting: z
      .string()
      .regex(SETTING_NAME)
      .describe('The setting’s name, as valet_get_adapter lists it, e.g. "store".'),
    query: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Narrows the site’s list of choices, e.g. a postcode or suburb. Not a value: the person picks.',
      ),
    note: noteInput,
  }),
  turnOffTool: z.object({
    adapterId: z.string().regex(ADAPTER_ID).describe('The site’s adapter id.'),
    tool: z
      .string()
      .regex(TOOL_NAME)
      .describe('The tool’s name within the adapter, as valet_get_adapter lists it.'),
  }),
  requestRemoval: z.object({
    adapterId: z
      .string()
      .regex(ADAPTER_ID)
      .describe('The site’s adapter id, as valet_list_adapters gives it.'),
    note: noteInput,
  }),
  disconnect: z.object({}),
  getApproval: z.object({
    approval: z
      .string()
      .regex(REF)
      .optional()
      .describe(
        'The 4-character approval ref, e.g. "7B3F". Leave out to list all of your requests Valet remembers.',
      ),
  }),
  withdraw: z.object({
    approval: z.string().regex(REF).describe('The 4-character approval ref of one of your waiting requests.'),
  }),
  listChanges: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('How many, 1 to 100; 20 by default.'),
  }),
} as const

export function isAgentSetting(value: unknown): value is AgentSetting {
  return typeof value === 'string' && (AGENT_SETTINGS as readonly string[]).includes(value)
}

// ---------- Tools ----------

/** The arguments any write tool takes, as the SDK parsed them against the tool's input schema. */
export interface WriteArgs {
  readonly setting?: unknown
  readonly value?: unknown
  readonly note?: unknown
  readonly adapterId?: unknown
  readonly query?: unknown
  readonly tool?: unknown
  readonly approval?: unknown
  readonly limit?: unknown
}

/** What a write tool returns before the shared gate words it. */
export type WriteToolResult =
  | { readonly kind: 'outcome'; readonly outcome: WriteOutcome }
  | { readonly kind: 'text'; readonly text: string; readonly isError?: true }
  | { readonly kind: 'data'; readonly data: Record<string, unknown> }

export interface WriteTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly input: z.ZodObject
  /** For tools that return data; the rest return a sentence. */
  readonly output?: z.ZodObject
  /**
   * The capability it needs: "Ask for changes", "See Valet", or none beyond being a local app the
   * person added (an agent may always disconnect itself).
   */
  readonly needs: 'ask' | 'see' | 'any'
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
  }
  readonly run: (
    writer: AdminWriter,
    args: WriteArgs,
    viewer: ClientIdentity,
    context: { readonly all: boolean; readonly wording: WriteWording },
  ) => Promise<WriteToolResult>
}

const changeSchema = z.object({
  at: z.string(),
  what: z.string(),
  tier: z.enum(['notify', 'approve']),
  approval: z
    .object({ ref: z.string(), state: z.enum(['waiting', 'approved', 'declined', 'expired', 'withdrawn']) })
    .nullable(),
  agent: z.string(),
  mine: z.boolean(),
})
export const changeListSchema = z.object({ changes: z.array(changeSchema) })

const note = (args: WriteArgs): string | null =>
  typeof args.note === 'string' && args.note.trim().length > 0 ? args.note.trim() : null
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const

export const WRITE_TOOLS: readonly WriteTool[] = [
  {
    name: 'valet_set_setting',
    title: 'Change a Valet setting',
    description:
      'Changes one of Valet’s own settings. A change that only makes Valet stricter and deletes ' +
      'nothing is made at once and the person is told. Anything else becomes a request the person ' +
      'answers in Valet, and nothing changes until they approve it. Valet decides which, not you.',
    input: writeInputs.setSetting,
    needs: 'ask',
    annotations: CHANGE,
    run: async (writer, args, viewer) => {
      const setting = args.setting
      const value = args.value
      if (!isAgentSetting(setting) || (typeof value !== 'boolean' && typeof value !== 'number'))
        return { kind: 'outcome', outcome: { kind: 'refused', reason: 'not-found' } }
      // A days count for the one setting that takes one; true or false for the rest.
      if ((setting === 'traceRetentionDays') !== (typeof value === 'number'))
        return { kind: 'outcome', outcome: { kind: 'refused', reason: 'not-found' } }
      return { kind: 'outcome', outcome: await writer.setSetting(viewer, setting, value, note(args)) }
    },
  },
  {
    name: 'valet_request_setting',
    title: 'Ask the person to choose a site setting',
    description:
      'Asks the person to choose one of a site’s settings, such as the store. You never give the ' +
      'value: Valet fetches the site’s own list (narrowed by `query`, e.g. a postcode) and the ' +
      'person picks from it on the request. Nothing changes until they do.',
    input: writeInputs.requestSetting,
    needs: 'ask',
    annotations: CHANGE,
    run: async (writer, args, viewer) => ({
      kind: 'outcome',
      outcome: await writer.requestSetting(
        viewer,
        str(args.adapterId),
        str(args.setting),
        typeof args.query === 'string' && args.query.trim().length > 0 ? args.query.trim() : null,
        note(args),
      ),
    }),
  },
  {
    name: 'valet_turn_off_tool',
    title: 'Turn off a tool for yourself',
    description:
      'Turns one site tool off for you only: it leaves your tool list, and other agents keep it. ' +
      'The person is told. Turning it back on is the person’s to do, in Valet.',
    input: writeInputs.turnOffTool,
    needs: 'ask',
    annotations: CHANGE,
    run: async (writer, args, viewer) => ({
      kind: 'outcome',
      outcome: await writer.turnOffTool(viewer, str(args.adapterId), str(args.tool)),
    }),
  },
  {
    name: 'valet_uninstall_site',
    title: 'Ask the person to remove a site',
    description:
      'Asks the person to remove a site that isn’t built into Valet, such as an adapter you built ' +
      'to try something out. If they say yes in Valet, its tools go for every agent, and Valet ' +
      'deletes its versions, approvals, the logins given to it, its settings and its browser data. ' +
      'Nothing is removed until they do. Built-in sites can’t be removed.',
    input: writeInputs.requestRemoval,
    needs: 'ask',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (writer, args, viewer) => {
      const result = await writer.requestRemoval(viewer, str(args.adapterId), note(args))
      if (result.kind === 'removal-asked' || result.kind === 'removal-already')
        return {
          kind: 'text',
          text:
            `${result.kind === 'removal-asked' ? 'Asked' : 'Already asked'}: the person will see “Remove ${result.siteName}” ` +
            'in Valet’s Needs you. Nothing is removed until they say yes. Check valet_list_adapters to see if it is gone.',
        }
      return { kind: 'outcome', outcome: result as WriteOutcome }
    },
  },
  {
    name: 'valet_disconnect',
    title: 'Disconnect from Valet',
    description:
      'Removes your own connection to Valet: your token stops working at once and your waiting ' +
      'requests are withdrawn. The person is told. Only the person can connect you again.',
    input: writeInputs.disconnect,
    needs: 'any',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (writer, _args, viewer) => ({ kind: 'outcome', outcome: await writer.disconnect(viewer) }),
  },
  {
    name: 'valet_get_approval',
    title: 'Check your requests',
    description:
      'How your requests to the person stand: waiting, approved, declined, expired or withdrawn. ' +
      'Give an approval ref for one, or leave it out for all of yours that Valet remembers.',
    input: writeInputs.getApproval,
    needs: 'ask',
    annotations: READ,
    run: async (writer, args, viewer, { wording }) => {
      const ref = typeof args.approval === 'string' ? args.approval.toUpperCase() : null
      const found = await writer.approvals(viewer, ref)
      if (found.length === 0)
        return {
          kind: 'text',
          text:
            ref === null
              ? 'You have no requests Valet remembers.'
              : `Valet has no approval ${ref} of yours. It may have ended more than a day ago, or Valet restarted.`,
          ...(ref === null ? {} : { isError: true as const }),
        }
      return { kind: 'text', text: found.map((r) => requestText(r, wording)).join('\n') }
    },
  },
  {
    name: 'valet_withdraw_approval',
    title: 'Withdraw a request',
    description: 'Takes back one of your requests that is still waiting for the person.',
    input: writeInputs.withdraw,
    needs: 'ask',
    annotations: CHANGE,
    run: async (writer, args, viewer) => {
      const ref = str(args.approval).toUpperCase()
      const done = await writer.withdraw(viewer, ref)
      if (done === 'withdrawn') return { kind: 'text', text: `Withdrawn: approval ${ref}. Nothing changed.` }
      if (done === 'closed')
        return {
          kind: 'text',
          text: `Approval ${ref} isn’t waiting any more. See valet_get_approval for how it ended.`,
          isError: true,
        }
      return { kind: 'text', text: `Valet has no waiting approval ${ref} of yours.`, isError: true }
    },
  },
  {
    name: 'valet_list_changes',
    title: 'Changes agents made',
    description:
      'Changes made through these tools and requests made to the person, newest first: yours, or ' +
      'every agent’s if the person allowed All agents’ activity.',
    input: writeInputs.listChanges,
    output: changeListSchema,
    needs: 'see',
    annotations: READ,
    run: async (writer, args, viewer, { all }) => {
      const limit = typeof args.limit === 'number' ? args.limit : 20
      return { kind: 'data', data: { changes: await writer.changes(viewer, all, limit) } }
    },
  },
]

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS.map((tool) => tool.name))
