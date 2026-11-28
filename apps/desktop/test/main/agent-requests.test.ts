import type { SerializedRequest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { agentRequestItem } from '../../src/main/core/agent-requests'

/** An agent's agent-access request, as the broker serializes it, with the subject given. */
function asked(subject: Record<string, unknown>): SerializedRequest {
  return {
    request: {
      kind: 'agent-access',
      id: 'req_0000000000000001',
      requester: { kind: 'agent', clientId: 'remote:abc', clientName: 'claude.example' },
      agentNote: 'to help',
      createdAt: '2026-11-28T00:00:00.000Z',
      expiresAt: '2026-11-29T00:00:00.000Z',
      subject: { clientId: 'remote:abc', items: [], full: [], tools: [], capabilities: [], ...subject },
    },
    text: '',
    digest: 'abcd0123',
  } as unknown as SerializedRequest
}

describe('agentRequestItem for agent-access', () => {
  it('lists tools and Valet itself, not only items', () => {
    const item = agentRequestItem(
      asked({
        items: [{ app: 'calendar', id: 'c1', label: 'Home', level: 'edit' }],
        tools: [
          { adapterId: 'shop', adapterHash: 'h', tool: 'add', label: 'Shop: Add', sideEffect: 'write' },
        ],
        capabilities: ['see-valet', 'ask-for-changes'],
      }),
    )
    expect(item).toMatchObject({
      title: 'Give claude.example 3 more things',
      details: [
        'Calendar, “Home”: Edit, to see, add, change and delete its events (and, with Full access, delete the calendar itself).',
        'The tool “Shop: Add”, which changes things on the site.',
        'Ask for changes: build and repair adapters, and ask you for access, settings and logins.',
      ],
    })
  })

  it('words See Valet alone', () => {
    expect(agentRequestItem(asked({ capabilities: ['see-valet'] }))).toMatchObject({
      title: 'Give claude.example more access',
      details: ['See Valet: its status, its sites and their health, and its own calls.'],
    })
  })
})
