// @vitest-environment node
// Every signer call that can show Touch ID runs through the prompt guard, which brings the person's
// window back once the prompt closes; calls that never prompt don't.

import { describe, expect, it } from 'vitest'
import { guardPrompts, type MacSigner, type PromptGuard } from '../../src/main/core/approvals'

function counting(): { guard: PromptGuard; runs: () => number } {
  let runs = 0
  const guard: PromptGuard = async (prompt) => {
    runs += 1
    return prompt()
  }
  return { guard, runs: () => runs }
}

const request = { id: 'r1', kind: 'resume', text: 'Resume Valet' } as unknown as Parameters<
  MacSigner['signDecision']
>[0]

const keys = { approvalKey: 'a', transportKey: 't', agreementKey: 'g' }

describe('guardPrompts', () => {
  it('guards a decision, and answers with what the signer answered', async () => {
    const { guard, runs } = counting()
    const signer = guardPrompts(
      { keys: async () => keys, signDecision: async (_r, payload) => `sig:${payload}` },
      guard,
    )
    expect(await signer.signDecision(request, 'p')).toBe('sig:p')
    expect(runs()).toBe(1)
    expect(await signer.keys()).toEqual(keys)
    expect(runs()).toBe(1)
    expect(signer.channel).toBeUndefined()
    expect(signer.rotateChannel).toBeUndefined()
  })

  it('guards a cancelled prompt too, and a failure still reaches the caller', async () => {
    const { guard, runs } = counting()
    const cancelled = guardPrompts({ keys: async () => keys, signDecision: async () => null }, guard)
    expect(await cancelled.signDecision(request, 'p')).toBeNull()
    const failing = guardPrompts(
      {
        keys: async () => keys,
        signDecision: async () => {
          throw new Error('helper died')
        },
      },
      guard,
    )
    await expect(failing.signDecision(request, 'p')).rejects.toThrow('helper died')
    expect(runs()).toBe(2)
  })

  it('guards the channel calls that ask for the finger, and only those', async () => {
    const { guard, runs } = counting()
    class Helper implements MacSigner {
      private readonly secret = 'kept'
      keys = async () => keys
      signDecision = async () => 'd'
      readonly channel = {
        signTransport: async () => 'transport',
        agree: async () => Buffer.from('shared'),
        signApproval: async () => 'one',
        signApprovals: async (_d: unknown, payloads: readonly string[]) => payloads.map(() => 'many'),
      }
      async worksLocked(): Promise<boolean> {
        return this.secret === 'kept'
      }
      async rotateChannel() {
        return { ...keys, transportKey: this.secret }
      }
    }
    const signer = guardPrompts(new Helper(), guard)
    const channel = signer.channel
    if (channel === undefined) throw new Error('no channel')
    expect(await channel.signTransport('x')).toBe('transport')
    expect((await channel.agree({} as never)).toString()).toBe('shared')
    expect(runs()).toBe(0)
    expect(await channel.signApproval('valet/relay-binding/v1' as never, 'x', 'why')).toBe('one')
    expect(await channel.signApprovals?.('valet/device/v1' as never, ['a', 'b'], 'why')).toEqual([
      'many',
      'many',
    ])
    expect(runs()).toBe(2)
    // Methods keep their own `this`.
    expect(await signer.worksLocked?.()).toBe(true)
    expect((await signer.rotateChannel?.())?.transportKey).toBe('kept')
    expect(runs()).toBe(3)
  })
})
