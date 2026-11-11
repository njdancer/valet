// For adapter tests: runs one tool from a built tool script in the same kind of context the tool
// process gives it (worker.ts: JavaScript's built-ins only, no URL, no timers, no fetch), with its
// capability calls answered by a ToolContext the test supplies. Values cross as JSON both ways, as
// they do over the real channel, so a test that passes here passes in the app's tool process.
// Not used by the app.

import { NeedsUserError, type ToolContext, ValetError } from '@valet/core'
import type { HostMessage, ProcessMessage, WireError } from './protocol'
import { evaluateToolScript } from './worker'

/** What the tool threw, as the host would see it: `other` is anything but a ValetError or NeedsUserError. */
export class ToolThrew extends Error {
  constructor(readonly wire: WireError) {
    super(wire.kind === 'valet' ? `${wire.stage}/${wire.errorClass}` : wire.kind)
  }
}

function toWire(error: unknown): WireError {
  if (error instanceof ValetError) return { kind: 'valet', stage: error.stage, errorClass: error.errorClass }
  if (error instanceof NeedsUserError) return { kind: 'needsUser', reason: error.reason }
  return { kind: 'other' }
}

async function answer(ctx: ToolContext, capability: string, args: readonly unknown[]): Promise<unknown> {
  const a = args as [never, never]
  switch (capability) {
    case 'page.goto':
      return ctx.page.goto(a[0])
    case 'page.click':
      return ctx.page.click(a[0])
    case 'page.fill':
      return ctx.page.fill(a[0], a[1])
    case 'page.extract':
      return ctx.page.extract(a[0], a[1])
    case 'page.evaluate':
      return ctx.page.evaluate(a[0], a[1])
    case 'page.fetch':
      return ctx.page.fetch(a[0], a[1])
    case 'session.ensure':
      return ctx.session.ensure()
    case 'confirm':
      return ctx.confirm(a[0])
    default:
      throw new ValetError('tool-run', 'invalid')
  }
}

/**
 * Runs `tool` with `input` in a fresh tool-process context. Resolves with what it returned, or
 * rejects with a ToolThrew. A tool that touches a global the context lacks rejects with
 * ToolThrew({ kind: 'other' }).
 */
export function runInToolContext(
  script: string,
  tool: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let deliver: (text: string) => void = () => {}
    const send = (message: HostMessage): void => deliver(JSON.stringify(message))
    deliver = evaluateToolScript(script, (text) => {
      const message = JSON.parse(text) as ProcessMessage
      if (message.t === 'done') {
        if (message.ok) resolve(message.value)
        else reject(new ToolThrew(message.error))
        return
      }
      if (message.t !== 'call') return
      answer(ctx, message.capability, message.args).then(
        (value) =>
          send({
            t: 'reply',
            id: message.id,
            ok: true,
            value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
            url: ctx.page.currentUrl(),
          }),
        (error: unknown) =>
          send({ t: 'reply', id: message.id, ok: false, error: toWire(error), url: ctx.page.currentUrl() }),
      )
    })
    send({ t: 'run', tool, input, url: ctx.page.currentUrl() })
  })
}
