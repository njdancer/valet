import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import type { AdminReader } from '../src/admin-tools'
import type { ClientIdentity } from '../src/auth'
import {
  FEEDBACK_TOOL_NAMES,
  type FeedbackDesk,
  type FeedbackGate,
  type FeedbackSendOutcome,
  type FeedbackThread,
  runGetFeedback,
  runSendFeedback,
  sendOutcomeText,
} from '../src/feedback'
import { createMcpServer, SERVER_INSTRUCTIONS } from '../src/server'
import { FakeCaller } from './fake-caller'

const LOCAL: ClientIdentity = { origin: 'local', clientId: 'c1' }
const NOW = Date.parse('2026-11-13T08:00:00.000Z')

const THREAD: FeedbackThread = {
  id: 'fb-abcd1234',
  kind: 'bug',
  title: 'Live trial refuses an egress host',
  filedAt: '2026-11-13T07:00:00.000Z',
  state: 'open',
  url: 'https://github.com/o/r/issues/1',
  replies: [],
}

function desk(overrides: Partial<FeedbackDesk> = {}): FeedbackDesk & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    sent,
    send: async (_viewer, report) => {
      sent.push(report)
      return { kind: 'filed', id: 'fb-abcd1234', url: THREAD.url ?? '', followUp: false, redacted: 0 }
    },
    thread: async () => THREAD,
    list: async () => [THREAD],
    ...overrides,
  }
}

const gate = (overrides: Partial<FeedbackGate> = {}): FeedbackGate => ({
  lockedDown: () => false,
  sensitive: () => false,
  ...overrides,
})

const text = (result: CallToolResult): string =>
  result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

const REPORT = {
  kind: 'bug',
  title: 'Live trial refuses an egress host',
  body: 'valet_live_trial fails with egress/host-not-allowed although the host is in egress.',
  draftId: 'dr-4jsgx7ln4w',
}

describe('valet_send_feedback', () => {
  it('passes the report to the desk and says where it went and how to read replies', async () => {
    const d = desk()
    const result = await runSendFeedback(d, gate(), LOCAL, REPORT, { now: () => NOW })
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('Filed as fb-abcd1234')
    expect(text(result)).toContain('valet_get_feedback')
    expect(d.sent).toEqual([
      {
        kind: 'bug',
        title: REPORT.title,
        body: REPORT.body,
        adapterId: null,
        draftId: 'dr-4jsgx7ln4w',
        callId: null,
        followUpOn: null,
      },
    ])
  })

  it('refuses while Valet is locked down without reaching the desk', async () => {
    const d = desk()
    const result = await runSendFeedback(d, gate({ lockedDown: () => true }), LOCAL, REPORT, {
      now: () => NOW,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('locked down')
    expect(d.sent).toEqual([])
  })

  it('gives a fixed sentence when the desk throws, never its message', async () => {
    const d = desk({
      send: async () => {
        throw new Error('token ghp_secret leaked')
      },
    })
    const result = await runSendFeedback(d, gate(), LOCAL, REPORT, { now: () => NOW })
    expect(result.isError).toBe(true)
    expect(text(result)).not.toContain('ghp_')
  })

  it('words every outcome', () => {
    const outcomes: FeedbackSendOutcome[] = [
      { kind: 'filed', id: 'fb-1', url: 'u', followUp: true, redacted: 2 },
      { kind: 'saved', id: 'fb-1', followUp: false, redacted: 1, why: 'not-set-up' },
      { kind: 'saved', id: 'fb-1', followUp: false, redacted: 0, why: 'unreachable' },
      { kind: 'refused', reason: 'too-many', until: '2026-11-13T09:00:00.000Z' },
      { kind: 'refused', reason: 'sensitive' },
    ]
    const words = outcomes.map((o) => sendOutcomeText(o, { now: () => NOW, timeZone: 'Australia/Sydney' }))
    expect(words[0]).toContain('Added to fb-1')
    expect(words[0]).toContain('replaced 2 tokens')
    expect(words[1]).toContain('isn’t set up')
    expect(words[2]).toContain('couldn’t reach GitHub')
    expect(words[3]).toContain('after 8:00 pm')
    expect(words[4]).toContain('nothing was kept')
  })
})

describe('valet_get_feedback', () => {
  it('lists the agent’s reports when no id is given', async () => {
    const result = await runGetFeedback(desk(), gate(), LOCAL, {}, { now: () => NOW })
    const data = result.structuredContent as { reports: FeedbackThread[]; note: string }
    expect(data.reports.map((r) => r.id)).toEqual(['fb-abcd1234'])
    expect(data.note).toContain('No new replies')
  })

  it('says not-found for a report that isn’t the agent’s', async () => {
    const result = await runGetFeedback(
      desk({ thread: async () => null }),
      gate(),
      LOCAL,
      { id: 'fb-zzzzzzzz' },
      {
        now: () => NOW,
      },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not-found')
  })

  it('waits for a new reply, looking again every poll, and stops once one comes', async () => {
    let clock = NOW
    let looks = 0
    const reply = { at: '2026-11-13T08:00:20.000Z', from: 'njdancer', text: 'Fixed in #107.', new: true }
    const d = desk({
      thread: async () => {
        looks += 1
        return looks < 3 ? THREAD : { ...THREAD, replies: [reply] }
      },
    })
    const result = await runGetFeedback(
      d,
      gate(),
      LOCAL,
      { id: 'fb-abcd1234', waitSeconds: 50 },
      {
        now: () => clock,
        pollMs: 10_000,
        sleep: async (ms) => {
          clock += ms
        },
      },
    )
    expect(looks).toBe(3)
    expect(clock - NOW).toBe(20_000)
    const data = result.structuredContent as { reports: FeedbackThread[]; note: string }
    expect(data.reports[0]?.replies).toEqual([reply])
    expect(data.note).toContain('1 new reply')
  })

  it('gives up at the deadline', async () => {
    let clock = NOW
    let looks = 0
    const d = desk({
      thread: async () => {
        looks += 1
        return THREAD
      },
    })
    await runGetFeedback(
      d,
      gate(),
      LOCAL,
      { id: 'fb-abcd1234', waitSeconds: 25 },
      {
        now: () => clock,
        pollMs: 10_000,
        sleep: async (ms) => {
          clock += ms
        },
      },
    )
    expect(looks).toBe(3)
  })

  it('withholds a result that holds something sensitive', async () => {
    const result = await runGetFeedback(
      desk(),
      gate({ sensitive: () => true }),
      LOCAL,
      {},
      { now: () => NOW },
    )
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('The tool failed at stage tool-output: internal.')
  })
})

describe('registration', () => {
  function reader(feedback: FeedbackDesk | undefined): AdminReader {
    const empty = async () => {
      throw new Error('not used')
    }
    return {
      access: () => ({ seeValet: false, allActivity: false, name: 'Claude Code' }),
      lockedDown: () => false,
      sensitive: () => false,
      status: empty,
      adapters: empty,
      adapter: empty,
      health: empty,
      needsYou: empty,
      calls: empty,
      call: empty,
      audit: empty,
      ...(feedback === undefined ? {} : { feedback }),
    }
  }

  async function listed(r: AdminReader, identity: ClientIdentity, remoteAdmin = false) {
    const { server } = createMcpServer(
      new FakeCaller([]),
      { name: 'valet', version: '0' },
      { admin: r, identity, remoteAdmin },
    )
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 't', version: '0' })
    await client.connect(b)
    const { tools } = await client.listTools()
    await client.close()
    return tools.map((t) => t.name)
  }

  it('adds both tools to a local session, even one that may not see Valet', async () => {
    const names = await listed(reader(desk()), LOCAL)
    for (const name of FEEDBACK_TOOL_NAMES) expect(names).toContain(name)
  })

  it('adds them for a cloud agent the person gave Valet’s own tools, and no one else', async () => {
    const remote: ClientIdentity = { origin: 'remote', clientId: 'r1' }
    expect(await listed(reader(desk()), remote, true)).toContain('valet_send_feedback')
    expect(await listed(reader(desk()), remote, false)).not.toContain('valet_send_feedback')
    expect(await listed(reader(undefined), LOCAL)).not.toContain('valet_send_feedback')
  })

  it('tells every agent it is a tester and to report problems itself', () => {
    expect(SERVER_INSTRUCTIONS).toContain('valet_send_feedback')
    expect(SERVER_INSTRUCTIONS).toContain('helping test Valet')
  })
})
