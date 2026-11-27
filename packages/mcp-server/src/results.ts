// Turns a runtime outcome into an MCP tool result, with text from fixed templates: nothing the
// runtime returns is passed through except a declared output, and codes and numbers checked against
// fixed vocabularies, and a built-in tool's pictures and files checked by type and size. failed, blocked and declined are tool errors, so the agent sees them and can act
// on them; needsUser is not an error, because nothing went wrong: the person has to do something.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  clockTime,
  ERROR_CLASSES,
  type ErrorClass,
  GAVE_UP_RESULT,
  type InputIssue,
  inputIssue,
  inputIssueSentence,
  LOCKED_DOWN_RESULT,
  MAX_TOOL_CONTENT_BYTES,
  missedTitle,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  needsYouTitle,
  ownCapLabel,
  PAUSED_RESULT,
  PICTURE_TYPES,
  STAGES,
  type Stage,
  seeCallSentence,
  siteLimitingLabel,
  sitePausedResult,
  type ToolContent,
} from '@valet/core'
import type { CallOutcome, NeedsYouHint } from './tool-caller'

/**
 * What the endpoint knows about the call besides its outcome, so a result can use the app's own
 * words for it (docs/ux/information-architecture.md, section 7): the call's id, for its short ref,
 * and the names the person approved with the adapter. Without them a result falls back to codes.
 */
export interface ResultContext {
  readonly callId?: string
  /** The adapter's name, as the app shows the site. */
  readonly adapterName?: string
  /** The tool's approved title, which the confirmation was shown under. */
  readonly toolTitle?: string
  /** The adapter's id: Valet's own Mac tools (mail, calendar) word a stall their own way. */
  readonly adapterId?: string
  /** For clock times; the machine's own zone when absent. */
  readonly timeZone?: string
  readonly now?: () => number
}

const AGAIN = 'Call this tool again once they have.'

/** The classes a blocked outcome may carry. */
const RETRYABLE: readonly ErrorClass[] = ['blocked-by-site', 'rate-limited', 'busy']

/**
 * `structured`: the tool declares an output schema. MCP requires every non-error result of such a
 * tool to carry structured content matching that schema (the SDK enforces it on both ends), which a
 * needsUser result can't, so for those tools needsUser goes out flagged as an error. Its text is
 * the same either way.
 */
export function toolResult(
  outcome: CallOutcome,
  structured: boolean,
  context: ResultContext = {},
): CallToolResult {
  switch (outcome.status) {
    case 'ok':
      return okResult(outcome.output, structured, outcome.content ?? [])
    case 'needsUser': {
      const named = needsYouText(outcome.reason, outcome.needsYou, context)
      if (named !== null) return textResult(named, structured)
      // Nothing in the app is waiting on this one: the person has to open the adapter and choose.
      if (outcome.reason === 'setting-required') {
        return textResult(
          'Not done yet: the person needs to choose a setting for this adapter in the Valet app, such as ' +
            'which store to shop at (reason: setting-required). Tell them, and call this tool again once they have.',
          structured,
        )
      }
      return textResult(
        `Not done yet: the person has been asked to act in the Valet app (reason: ${needsUserCode(outcome.reason)}). ` +
          'Call this tool again once they have.',
        structured,
      )
    }
    case 'failed': {
      const { stage, errorClass } = safeCodes(outcome.stage, outcome.errorClass)
      if (outcome.needsYou?.kind === 'login-missing' && context.adapterName !== undefined) {
        const title = needsYouTitle({ kind: 'login-missing', adapterName: context.adapterName })
        return textResult(
          `Not done yet: Valet has no login for this site, so nothing was sent (stage ${stage}: ${errorClass}). ` +
            `The person can give it one in Valet, Needs you, "${title}". ${AGAIN}`,
          true,
        )
      }
      if (stage === 'tool-input' && errorClass === 'invalid' && outcome.issue !== undefined) {
        const issue = inputIssue(outcome.issue)
        if (issue !== undefined) return inputResult(issue, context)
      }
      return failedResult(outcome.stage, outcome.errorClass, context)
    }
    case 'blocked': {
      // Only a site's refusal or a rate limit passes with time; a guard's refusal (denied-path,
      // request-ceiling, ...) never will, and "try again" would invite a retry loop against it.
      if (outcome.stage === 'login' && outcome.errorClass === 'login-in-progress') {
        // D50: the call started a login and was answered without waiting for it.
        return textResult(
          'Valet is logging in to the site first, so this call was not carried out and nothing was ' +
            'changed (stage login: login-in-progress). Call it again in ' +
            `${retryAfterSeconds(outcome.retryAfterMs)} seconds; if the login needs the person, that call will say so.`,
          true,
        )
      }
      if (!RETRYABLE.includes(outcome.errorClass))
        return failedResult(outcome.stage, outcome.errorClass, context)
      const { stage, errorClass } = safeCodes(outcome.stage, outcome.errorClass)
      if (errorClass === 'busy' && outcome.waitingFor === 'login') {
        // A login an earlier call started holds the site: nothing to wait in a queue for.
        return textResult(
          `Valet is still logging in to ${siteName(context)}, so this call was not started and nothing ` +
            `was sent (stage ${stage}: busy). Call it again in ${retryAfterSeconds(outcome.retryAfterMs)} ` +
            'seconds; if the login needs the person, that call will say so.',
          true,
        )
      }
      if (errorClass === 'busy') {
        // Our own queue, not the site: the call gave up its turn and never started.
        return textResult(
          `Valet is still working through earlier calls (${aheadCount(outcome.ahead)} ahead of this ` +
            `one), so this call was not started and nothing was sent (stage ${stage}: busy). ` +
            `Try again in ${retryAfterSeconds(outcome.retryAfterMs)} seconds, one call at a time.`,
          true,
        )
      }
      if (stage === 'tool-run' && errorClass === 'rate-limited') {
        // Our own hourly cap for the site, not the site refusing: the call never started.
        return textResult(
          'Valet has sent this site as many requests as it allows itself in an hour, so this call ' +
            `was not started and nothing was sent (stage ${stage}: ${errorClass}). ` +
            until(context, outcome.retryAfterMs, ownCapLabel) +
            `Try again in ${retryAfterSeconds(outcome.retryAfterMs)} seconds.`,
          true,
        )
      }
      // Stage config is the app's own limit (the remote policy's per-client cap), not the site's.
      const who =
        stage === 'config'
          ? 'Valet is limiting calls from this client'
          : 'The site is refusing or limiting requests'
      return textResult(
        `${who} (stage ${stage}: ${errorClass}). ` +
          (stage === 'config' ? '' : until(context, outcome.retryAfterMs, siteLimitingLabel)) +
          `Try again in ${retryAfterSeconds(outcome.retryAfterMs)} seconds.`,
        true,
      )
    }
    case 'declined': {
      const ref = seeCall(context)
      if (outcome.timedOut === true) {
        const missed =
          context.adapterName !== undefined && context.toolTitle !== undefined
            ? ` Valet lists it under Needs you as "${missedTitle(
                needsYouTitle({
                  kind: 'confirmation',
                  adapterName: context.adapterName,
                  toolTitle: context.toolTitle,
                }),
              )}".`
            : ''
        return textResult(
          'Nobody answered the confirmation in the Valet app in time, so this action was not done ' +
            `and nothing was sent (stage confirm: timed-out).${missed}${ref}`,
          true,
        )
      }
      return textResult(
        `The person did not approve this action in the Valet app (stage confirm: declined).${ref}`,
        true,
      )
    }
  }
}

/**
 * A failure as stage and error class only. Values outside the fixed vocabularies are replaced, so
 * a runtime bug that put free text here still can't reach the client. The app's own refusals
 * (stage config: Valet paused, the site paused, Valet locked down) say so in the app's words.
 */
/** Valet's own tools over the Mac's apps, by adapter id, and the app each one waits on. */
const MAC_APPS: Readonly<Record<string, string>> = {
  mail: 'Mail',
  calendar: 'Calendar',
  reminders: 'Reminders',
  messages: 'Messages',
}

/**
 * Feedback #34: a Mac app that stopped answering came back as a bare "tool-run: unavailable" after
 * a long wait, which told the agent nothing it could act on.
 */
export function macAppUnavailable(app: string, context: ResultContext = {}): string {
  return (
    `The Mac's ${app} didn't answer Valet in time (stage tool-run: unavailable). A tool that only ` +
    'reads changed nothing. One that changes something may have done it anyway, so read the current ' +
    'state before trying it again. Try again in a few minutes. If it keeps happening, tell the person: ' +
    `quitting and reopening ${app}, or restarting Valet or the Mac, fixes it.${seeCall(context)}`
  )
}

export function failedResult(
  stage: Stage,
  errorClass: ErrorClass,
  context: ResultContext = {},
): CallToolResult {
  const safe = safeCodes(stage, errorClass)
  if (safe.stage === 'config') {
    if (safe.errorClass === 'unavailable') return textResult(PAUSED_RESULT, true)
    if (safe.errorClass === 'locked-down') return textResult(LOCKED_DOWN_RESULT, true)
    if (safe.errorClass === 'site-paused')
      return textResult(sitePausedResult(context.adapterName ?? 'This site'), true)
  }
  const app = context.adapterId === undefined ? undefined : MAC_APPS[context.adapterId]
  if (app !== undefined && safe.stage === 'tool-run' && safe.errorClass === 'unavailable')
    return textResult(macAppUnavailable(app, context), true)
  return textResult(`The tool failed at stage ${safe.stage}: ${safe.errorClass}.${seeCall(context)}`, true)
}

/**
 * A refusal of the call's input with where and why: a fixed sentence per reason, naming a path of
 * plain identifiers and indexes and a numeric bound, nothing else (core's input-issue.ts).
 */
function inputResult(issue: InputIssue, context: ResultContext): CallToolResult {
  return textResult(
    `The tool refused this input (stage tool-input: invalid): ${inputIssueSentence(issue)}. ` +
      `Correct it and call again.${seeCall(context)}`,
    true,
  )
}

/** The site's name as the person approved it with the adapter, or a plain stand-in. */
function siteName(context: ResultContext): string {
  return context.adapterName ?? 'the site'
}

/** " The person can see it in Valet, Activity, call 7F2A." when the call id is known. */
function seeCall(context: ResultContext): string {
  return context.callId === undefined ? '' : ` ${seeCallSentence(context.callId)}.`
}

/** "Woolworths is limiting requests · calls resume at 9:52 pm. " when the site's name is known. */
function until(
  context: ResultContext,
  retryAfterMs: number,
  label: (name: string, at: number, timeZone?: string) => string,
): string {
  if (context.adapterName === undefined) return ''
  const at = (context.now ?? Date.now)() + retryAfterSeconds(retryAfterMs) * 1000
  return `${label(context.adapterName, at, context.timeZone).replace(' · ', '; ')}. `
}

/**
 * A needsUser result that names its Needs you item, or null when the app gave no hint (or the
 * endpoint has no name for the site) and the plain wording applies.
 */
function needsYouText(
  reason: NeedsUserReason,
  hint: NeedsYouHint | undefined,
  context: ResultContext,
): string | null {
  if (hint === undefined) return null
  if (hint.kind === 'gave-up') return GAVE_UP_RESULT
  // Neither of these has anything open for the person, so the text never says they were asked.
  if (hint.kind === 'login-waiting') {
    const at = Date.parse(hint.retryAt)
    const when = Number.isFinite(at) ? clockTime(at, context.timeZone) : null
    return (
      `Not done yet: Valet's last login to this site didn't work, so it is waiting before it tries again, ` +
      `and this call sent nothing (reason: ${needsUserCode(reason)}). Nobody has been asked to act. ` +
      (when === null ? 'Call this tool again later.' : `Call this tool again after ${when}.`)
    )
  }
  if (hint.kind === 'login-stopped')
    return (
      'Not done yet: Valet has stopped logging in to this site by itself until the person signs in from ' +
      `the Valet app, and this call sent nothing (reason: ${needsUserCode(reason)}). Nothing in the app is ` +
      'asking them yet: tell them, and call this tool again once they have.'
    )
  const adapterName = context.adapterName
  if (adapterName === undefined) return null
  const code = needsUserCode(reason)
  switch (hint.kind) {
    case 'login': {
      const title = needsYouTitle({ kind: 'needs-user', adapterName, reason: code })
      const open = hint.until === null ? '' : `, open until ${clockTime(hint.until, context.timeZone)}`
      return (
        `Not done yet: the person has been asked to act in the Valet app (reason: ${code}). ` +
        `Open Valet, Needs you, "${title}"${open}. ${AGAIN}`
      )
    }
    case 'setting-missing': {
      const title = needsYouTitle({ kind: 'setting-missing', adapterName, settingTitle: hint.settingTitle })
      return (
        `Not done yet: the person needs to choose a setting for this site in the Valet app (reason: ${code}). ` +
        `Valet, Needs you, "${title}". Tell them, and call this tool again once they have.`
      )
    }
    case 'login-missing': {
      const title = needsYouTitle({ kind: 'login-missing', adapterName })
      return (
        `Not done yet: Valet has no login for this site (reason: ${code}). ` +
        `The person can give it one in Valet, Needs you, "${title}". ${AGAIN}`
      )
    }
  }
}

function okResult(output: unknown, structured: boolean, extra: readonly ToolContent[]): CallToolResult {
  // undefined (a tool with nothing to say) still needs a JSON text block.
  const text = JSON.stringify(output) ?? 'null'
  const result: CallToolResult = { content: [{ type: 'text', text }, ...contentBlocks(extra)] }
  if (structured) result.structuredContent = output as Record<string, unknown>
  return result
}

/** A MIME type as a plain token pair; anything else is sent as application/octet-stream. */
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/
/** A URI Valet makes itself: its own scheme and nothing that isn't printable ASCII. */
const VALET_URI = /^valet-[a-z]+:\/\/[\x21-\x7e]{1,1024}$/

/**
 * A built-in tool's pictures and files as MCP content blocks, after the JSON text: images by the
 * types every client shows, files as embedded resources. Whatever would take the result past
 * MAX_TOOL_CONTENT_BYTES is left out; the output says what was meant to go with it.
 */
function contentBlocks(extra: readonly ToolContent[]): CallToolResult['content'] {
  const blocks: CallToolResult['content'] = []
  let total = 0
  for (const item of extra) {
    if (!Buffer.isBuffer(item.data) || item.data.length === 0) continue
    if (total + item.data.length > MAX_TOOL_CONTENT_BYTES) continue
    if (item.kind === 'image') {
      if (!(PICTURE_TYPES as readonly string[]).includes(item.mimeType)) continue
      blocks.push({ type: 'image', mimeType: item.mimeType, data: item.data.toString('base64') })
    } else if (item.kind === 'file') {
      if (!VALET_URI.test(item.uri)) continue
      const mimeType = MIME_TYPE.test(item.mimeType) ? item.mimeType : 'application/octet-stream'
      blocks.push({
        type: 'resource',
        resource: { uri: item.uri, mimeType, blob: item.data.toString('base64') },
      })
    } else continue
    total += item.data.length
  }
  return blocks
}

function textResult(text: string, isError: boolean): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

function safeCodes(stage: Stage, errorClass: ErrorClass): { stage: Stage; errorClass: ErrorClass } {
  return {
    stage: STAGES.includes(stage) ? stage : 'tool-run',
    errorClass: ERROR_CLASSES.includes(errorClass) ? errorClass : 'internal',
  }
}

/** Only a code from the fixed vocabulary; anything else, such as manifest text, becomes `other`. */
function needsUserCode(reason: NeedsUserReason): NeedsUserReason {
  return NEEDS_USER_REASONS.includes(reason) ? reason : 'other'
}

/** A whole number from 1 to 99, whatever arrived. */
function aheadCount(ahead: number | undefined): number {
  if (ahead === undefined || !Number.isFinite(ahead)) return 1
  return Math.min(99, Math.max(1, Math.floor(ahead)))
}

function retryAfterSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.ceil(ms / 1000))
}
