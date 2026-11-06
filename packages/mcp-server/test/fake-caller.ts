// A ToolCaller fake that records every call and answers with whatever the test sets.

import type { CallOutcome, ListedTool, ToolCall, ToolCaller } from '../src/tool-caller'

export class FakeCaller implements ToolCaller {
  tools: ListedTool[]
  readonly calls: ToolCall[] = []
  answer: (call: ToolCall) => Promise<CallOutcome> = async () => ({ status: 'ok', output: {} })

  constructor(tools: ListedTool[]) {
    this.tools = tools
  }

  listTools(): readonly ListedTool[] {
    return this.tools
  }

  call(call: ToolCall): Promise<CallOutcome> {
    this.calls.push(call)
    return this.answer(call)
  }
}
