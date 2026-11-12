// Messages from paired phones, after workstream G's channel opened their envelope
// (docs/approval-broker.md#approving-on-a-phone). The Mac reads a phone's message only through
// core's parsePhoneToMac, and only from a phone that is paired and not revoked.
//
// - An approval goes to the broker, which checks its signature; the envelope's sender must be the
//   device that signed it.
// - A decline needs no signature.
// - Commands only tighten: pause remote, lock down, revoke a client, revoke a device (never the
//   Mac). Undoing any of them is a `resume` approval.

import { type PhoneToMacMessage, parsePhoneToMac } from '@valet/core'
import type { AnswerResult, ApprovalBroker } from './broker'
import type { DeviceStore } from './devices'

/** The app's safety switches, which the service owns (lockdown also revokes remote clients). */
export interface SafetySwitches {
  pauseRemote(by: string): Promise<void>
  lockdown(by: string): Promise<void>
  revokeClient(clientId: string, by: string): Promise<void>
  revokeDevice(deviceId: string, by: string): Promise<void>
}

export type InboxResult =
  | { readonly handled: 'decision'; readonly result: AnswerResult }
  | { readonly handled: 'decline'; readonly declined: boolean }
  | { readonly handled: 'command' }
  | { readonly handled: 'ack'; readonly ackSeq: number }
  | { readonly handled: 'dropped'; readonly why: 'unknown-device' | 'malformed' }

export class PhoneInbox {
  constructor(
    private readonly broker: ApprovalBroker,
    private readonly devices: DeviceStore,
    private readonly safety: SafetySwitches,
  ) {}

  /** `plaintext` is the opened envelope's content; `from` the envelope's authenticated sender. */
  async receive(from: string, plaintext: string): Promise<InboxResult> {
    if (!this.devices.isActivePhone(from)) return { handled: 'dropped', why: 'unknown-device' }
    let raw: unknown
    try {
      raw = JSON.parse(plaintext)
    } catch {
      return { handled: 'dropped', why: 'malformed' }
    }
    const message: PhoneToMacMessage | null = parsePhoneToMac(raw, this.devices.macId)
    if (message === null) return { handled: 'dropped', why: 'malformed' }
    switch (message.type) {
      case 'approval-decision':
        return {
          handled: 'decision',
          result: await this.broker.answer(message.decision, { via: 'phone', deviceId: from }),
        }
      case 'approval-decline':
        return {
          handled: 'decline',
          declined: await this.broker.decline(message.requestId, { via: 'phone', deviceId: from }),
        }
      case 'command': {
        const command = message.command
        if (command.kind === 'pause-remote') await this.safety.pauseRemote(from)
        else if (command.kind === 'lockdown') await this.safety.lockdown(from)
        else if (command.kind === 'revoke-client') await this.safety.revokeClient(command.clientId, from)
        else await this.safety.revokeDevice(command.deviceId, from)
        return { handled: 'command' }
      }
      case 'ack':
        return { handled: 'ack', ackSeq: message.ackSeq }
    }
  }
}
