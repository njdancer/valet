// Every signature that asks for the person's finger runs through a guard, so the window they were
// using comes back to the front once the prompt closes. macOS's Touch ID prompt belongs to another
// process: while it is up Valet isn't the active app, and when it closes macOS hands activation to
// the last regular app, not to a menu-bar app like Valet. The control panel then sits behind
// whatever the person had open before, right after they approved something in it.

import type { ChannelKeys, MacSigner } from './signer'

/** Runs `prompt`, and puts back afterwards whatever it may have taken from the person's window. */
export type PromptGuard = <T>(prompt: () => Promise<T>) => Promise<T>

/** The same signer, with every call that may show a prompt run through `guard`. */
export function guardPrompts(signer: MacSigner, guard: PromptGuard): MacSigner {
  const guarded: {
    -readonly [K in keyof MacSigner]: MacSigner[K]
  } = {
    keys: () => signer.keys(),
    signDecision: (request, payload) => guard(() => signer.signDecision(request, payload)),
  }
  if (signer.channel !== undefined) guarded.channel = guardChannel(signer.channel, guard)
  const worksLocked = signer.worksLocked?.bind(signer)
  if (worksLocked !== undefined) guarded.worksLocked = () => worksLocked()
  const rotate = signer.rotateChannel?.bind(signer)
  if (rotate !== undefined) guarded.rotateChannel = () => guard(() => rotate())
  return guarded
}

function guardChannel(channel: ChannelKeys, guard: PromptGuard): ChannelKeys {
  const guarded: { -readonly [K in keyof ChannelKeys]: ChannelKeys[K] } = {
    // Neither needs the person: no prompt to guard.
    signTransport: (payload) => channel.signTransport(payload),
    agree: (peer) => channel.agree(peer),
    signApproval: (domain, payload, reason) => guard(() => channel.signApproval(domain, payload, reason)),
  }
  const many = channel.signApprovals?.bind(channel)
  if (many !== undefined)
    guarded.signApprovals = (domain, payloads, reason) => guard(() => many(domain, payloads, reason))
  return guarded
}
