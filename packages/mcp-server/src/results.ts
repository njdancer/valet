// Turns a runtime outcome into an MCP tool result, with text from fixed templates: nothing the
// runtime returns is passed through except a declared output, and codes and numbers checked against
// fixed vocabularies. failed, blocked and declined are tool errors, so the agent sees them and can act
// on them; needsUser is not an error, because nothing went wrong: the person has to do something.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  clockTime,
  ERROR_CLASSES,
  type ErrorClass,
  GAVE_UP_RESULT,
  LOCKED_DOWN_RESULT,
  missedTitle,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  needsYouTitle,
  ownCapLabel,
  PAUSED_RESULT,
  STAGES,
  type Stage,
  seeCallSentence,
  siteLimitingLabel,
  sitePausedResult,
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
      return okResult(outcome.output, structured)
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
  return textResult(`The tool failed at stage ${safe.stage}: ${safe.errorClass}.${seeCall(context)}`, true)
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

function okResult(output: unknown, structured: boolean): CallToolResult {
  // undefined (a tool with nothing to say) still needs a JSON text block.
  const text = JSON.stringify(output) ?? 'null'
  const result: CallToolResult = { content: [{ type: 'text', text }] }
  if (structured) result.structuredContent = output as Record<string, unknown>
  return result
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
