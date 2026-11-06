// Turns a runtime outcome into an MCP tool result. Anything that is not `ok` is a tool error, so
// the agent sees it and can act on it, with text from fixed templates: nothing the runtime returns
// is passed through except a declared output, a needsUser reason and a retry delay.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ERROR_CLASSES, type ErrorClass, STAGES, type Stage } from '@siteadapter/core'
import type { CallOutcome } from './tool-caller'

const MAX_REASON_LENGTH = 200

export function toolResult(outcome: CallOutcome, structured: boolean): CallToolResult {
  switch (outcome.status) {
    case 'ok':
      return okResult(outcome.output, structured)
    case 'needsUser':
      return errorResult(
        `The person needs to open siteadapter to continue (${cleanReason(outcome.reason)}). ` +
          'Ask them to, then call this tool again.',
      )
    case 'failed':
      return failedResult(outcome.stage, outcome.errorClass)
    case 'blocked':
      return errorResult(
        `The site is limiting requests. Try again in ${retryAfterSeconds(outcome.retryAfterMs)} seconds.`,
      )
    case 'declined':
      return errorResult('the person declined this action')
  }
}

/**
 * A failure as stage and error class only. Values outside the fixed vocabularies are replaced, so
 * a runtime bug that put free text here still can't reach the client.
 */
export function failedResult(stage: Stage, errorClass: ErrorClass): CallToolResult {
  const safeStage = STAGES.includes(stage) ? stage : 'tool-run'
  const safeClass = ERROR_CLASSES.includes(errorClass) ? errorClass : 'internal'
  return errorResult(`The tool failed at stage ${safeStage}: ${safeClass}.`)
}

function okResult(output: unknown, structured: boolean): CallToolResult {
  // undefined (a tool with nothing to say) still needs a JSON text block.
  const text = JSON.stringify(output) ?? 'null'
  const result: CallToolResult = { content: [{ type: 'text', text }] }
  if (structured) result.structuredContent = output as Record<string, unknown>
  return result
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function cleanReason(reason: string): string {
  // Control characters could forge extra lines in what the agent reads.
  const flat = reason.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim()
  return flat.length > MAX_REASON_LENGTH ? `${flat.slice(0, MAX_REASON_LENGTH)}…` : flat
}

function retryAfterSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.ceil(ms / 1000))
}
