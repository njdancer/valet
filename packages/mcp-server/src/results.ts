// Turns a runtime outcome into an MCP tool result, with text from fixed templates: nothing the
// runtime returns is passed through except a declared output, and codes and numbers checked against
// fixed vocabularies. failed, blocked and declined are tool errors, so the agent sees them and can act
// on them; needsUser is not an error, because nothing went wrong: the person has to do something.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  ERROR_CLASSES,
  type ErrorClass,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  STAGES,
  type Stage,
} from '@valet/core'
import type { CallOutcome } from './tool-caller'

/** The classes a blocked outcome may carry. */
const RETRYABLE: readonly ErrorClass[] = ['blocked-by-site', 'rate-limited', 'busy']

/**
 * `structured`: the tool declares an output schema. MCP requires every non-error result of such a
 * tool to carry structured content matching that schema (the SDK enforces it on both ends), which a
 * needsUser result can't, so for those tools needsUser goes out flagged as an error. Its text is
 * the same either way.
 */
export function toolResult(outcome: CallOutcome, structured: boolean): CallToolResult {
  switch (outcome.status) {
    case 'ok':
      return okResult(outcome.output, structured)
    case 'needsUser':
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
    case 'failed':
      return failedResult(outcome.stage, outcome.errorClass)
    case 'blocked': {
      // Only a site's refusal or a rate limit passes with time; a guard's refusal (denied-path,
      // request-ceiling, ...) never will, and "try again" would invite a retry loop against it.
      if (!RETRYABLE.includes(outcome.errorClass)) return failedResult(outcome.stage, outcome.errorClass)
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
      // Stage config is the app's own limit (the remote policy's per-client cap), not the site's.
      const who =
        stage === 'config'
          ? 'Valet is limiting calls from this client'
          : 'The site is refusing or limiting requests'
      return textResult(
        `${who} (stage ${stage}: ${errorClass}). ` +
          `Try again in ${retryAfterSeconds(outcome.retryAfterMs)} seconds.`,
        true,
      )
    }
    case 'declined':
      return textResult(
        'The person did not approve this action in the Valet app (stage confirm: declined).',
        true,
      )
  }
}

/**
 * A failure as stage and error class only. Values outside the fixed vocabularies are replaced, so
 * a runtime bug that put free text here still can't reach the client.
 */
export function failedResult(stage: Stage, errorClass: ErrorClass): CallToolResult {
  const safe = safeCodes(stage, errorClass)
  return textResult(`The tool failed at stage ${safe.stage}: ${safe.errorClass}.`, true)
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
