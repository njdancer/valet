// A ToolCaller fake that records every call and answers with whatever the test sets.

import type { CallOutcome, ListedTool, ProtocolRefusal, ToolCall, ToolCaller } from '../src/tool-caller'

export class FakeCaller implements ToolCaller {
  tools: ListedTool[]
  readonly calls: ToolCall[] = []
  /** The calls the SDK refused before call(), as the server reported them. */
  readonly refusals: ProtocolRefusal[] = []
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

  async refusedByProtocol(refusal: ProtocolRefusal): Promise<void> {
    this.refusals.push(refusal)
  }
}
