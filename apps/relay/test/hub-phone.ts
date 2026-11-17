// A phone on the Valet account, talking to the hub as the iPhone app does (core's hub-phone.ts):
// a challenge, the transport key's answer, the account's list back, and changes it signed with
// its approval key. The relay suite and the desktop end-to-end suite both use it.

import { sign } from 'node:crypto'
import {
  type HubPhoneAccount,
  hubPhoneAccountSchema,
  hubPhoneChallengeSchema,
  joinRecordDevice,
  keyId,
  nextRosterChange,
  type Roster,
  type RosterDevice,
  relayAuthPayload,
  SIGNING_DOMAINS,
  type SignedText,
  signingInput,
  verifyRoster,
} from '@valet/core'
import type { PhoneKeys } from './phone'

export class HubPhone {
  readonly deviceId: string

  constructor(
    readonly keys: PhoneKeys,
    /** The hub's origin, as it names itself in the payload the phone signs. */
    private readonly origin: string,
    /** POSTs JSON to a path on the hub. */
    private readonly post: (path: string, body: unknown) => Promise<Response>,
  ) {
    this.deviceId = keyId(keys.approval.spki)
  }

  /** This phone as a device on the account's list. */
  device(name = 'Test iPhone'): RosterDevice {
    return {
      deviceId: this.deviceId,
      role: 'phone',
      platform: 'ios',
      name,
      approvalKey: this.keys.approval.spki,
      transportKey: this.keys.transport.spki,
      agreementKey: this.keys.agreement.spki,
    }
  }

  /** The account as the hub has it, after appending `append` if given. Throws if refused entry. */
  async account(append?: readonly SignedText[]): Promise<HubPhoneAccount> {
    const challenge = await this.post('/phone/challenge', {})
    if (!challenge.ok) throw new Error(`challenge: ${challenge.status}`)
    const { nonce } = hubPhoneChallengeSchema.parse(await challenge.json())
    const payload = relayAuthPayload({ nonce, relay: this.origin, role: 'phone', id: this.deviceId })
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.relayAuth, payload), {
      key: this.keys.transport.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    const response = await this.post('/phone/account', {
      deviceId: this.deviceId,
      nonce,
      signature,
      ...(append === undefined ? {} : { append }),
    })
    if (!response.ok) throw new Error(`account: ${response.status} ${await response.text()}`)
    return hubPhoneAccountSchema.parse(await response.json())
  }

  /** The account's list, checked here as the phone checks it. */
  static roster(account: HubPhoneAccount): Roster {
    const check = verifyRoster(account.changes)
    if (!check.ok) throw new Error(`roster: ${check.reason} at ${check.at}`)
    return check.roster
  }

  signRoster(payload: string): SignedText {
    const signature = sign('sha256', signingInput(SIGNING_DOMAINS.rosterChange, payload), {
      key: this.keys.approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    return { payload, signature }
  }

  /**
   * Adds every Mac waiting to join, as the phone does after the person says yes with Face ID:
   * each one's own signed record decides the keys added, never what the hub says.
   */
  async addWaitingMacs(): Promise<HubPhoneAccount> {
    const account = await this.account()
    let roster = HubPhone.roster(account)
    const changes: SignedText[] = []
    const at = new Date().toISOString()
    for (const join of account.joining) {
      const device = joinRecordDevice(join.record, { macId: join.macId })
      if (device === null) throw new Error('a join record that does not check')
      const signed = this.signRoster(
        nextRosterChange(roster, roster.account, this.deviceId, { op: 'add', device }, at),
      )
      changes.push(signed)
      const next = verifyRoster([...account.changes, ...changes])
      if (!next.ok) throw new Error(next.reason)
      roster = next.roster
    }
    if (changes.length === 0) throw new Error('no Mac is waiting to join')
    return this.account(changes)
  }
}
