// serve.ts can't import the runtime's protocol (the sandbox preload bundles it, and the protocol
// pulls in Node), so it keeps its own copy of the wire's message cap. This keeps the two equal.

import { MAX_MESSAGE_CHARS } from '@valet/runtime/protocol'
import { expect, it } from 'vitest'
import { MAX_POSTED_CHARS } from '../src/serve'

it("drops what QuickJS posts past the same cap the host's wire enforces", () => {
  expect(MAX_POSTED_CHARS).toBe(MAX_MESSAGE_CHARS)
})
