// Developer mode (docs/approval-broker.md#developer-mode): while agents iterate on adapters, the
// person turns it on once and the approvals that would keep interrupting them answer themselves.
//
// - Only an unpackaged build has it; a release build never constructs one that can turn on.
// - Turning it on is one Touch ID: the Mac's approval key signs a device record (role `dev`) for a
//   key made now and held only in this process's memory. Nothing of the private key is written.
// - That key signs approvals like any device, and approvableOn lets it approve only an adapter's
//   version and a tool turned on. Settings (picked on the card), logins and credentials, pairing,
//   lockdown, irreversible calls and connecting agents still ask the person.
// - It ends after DEV_MODE_MS, on lockdown, when the person turns it off, and when the app stops
//   (the key goes with the process, and the record is revoked at the next start). Revoking keeps
//   what it approved while on, as for a phone, so an adapter it approved stays approved.

import { type DeviceRecord, keyId, SIGNING_DOMAINS, type SignedText } from '@valet/core'
import type { Timers } from './broker'
import type { DeviceStore } from './devices'
import { type ChannelKeys, SoftwareSigner } from './signer'

/** How long one Touch ID keeps developer mode on. */
export const DEV_MODE_MS = 8 * 3600_000

export interface DevModeStatus {
  /** Whether this build has developer mode at all (unpackaged builds only). */
  readonly available: boolean
  /** When it turns itself off, while it is on. */
  readonly until: string | null
}

export type DevModeEnd = 'expired' | 'turned-off' | 'lockdown' | 'restart'

export interface DevModeOptions {
  readonly available: boolean
  readonly devices: DeviceStore
  /** The Mac's approval key, for the one signed record (Touch ID). Absent: can't turn on. */
  readonly channel: ChannelKeys | undefined
  readonly now: () => number
  readonly timers: Timers
  /** It turned on or off. Must not throw. */
  readonly changed: (on: boolean, why: 'on' | DevModeEnd) => void
}

interface Active {
  readonly record: DeviceRecord
  readonly signer: SoftwareSigner
  readonly until: number
  readonly timer: unknown
}

export class DevMode {
  private active: Active | null = null

  constructor(private readonly options: DevModeOptions) {}

  status(): DevModeStatus {
    return {
      available: this.options.available,
      until: this.active === null ? null : new Date(this.active.until).toISOString(),
    }
  }

  /** The key's device id while it is on, for the broker. */
  deviceId(): string | null {
    return this.active?.record.deviceId ?? null
  }

  /** Signs an approval decision's payload with the key, while it is on. */
  async sign(payload: string): Promise<string | null> {
    const active = this.active
    if (active === null || this.options.now() >= active.until) return null
    return active.signer.sign(SIGNING_DOMAINS.approvalDecision, payload, 'developer mode')
  }

  /**
   * One Touch ID, then on until DEV_MODE_MS from now. Turning it on again while on starts a new
   * key and a new window. False if the build has none, or the person cancelled the prompt.
   */
  async turnOn(): Promise<boolean> {
    const channel = this.options.channel
    if (!this.options.available || channel === undefined) return false
    const signer = new SoftwareSigner()
    const keys = await signer.keys()
    const macId = this.options.devices.macId
    const now = this.options.now()
    const payload = JSON.stringify({
      v: 1,
      deviceId: keyId(keys.approvalKey),
      macId,
      role: 'dev',
      platform: 'macos',
      name: 'Developer mode',
      approvalKey: keys.approvalKey,
      transportKey: keys.transportKey,
      agreementKey: keys.agreementKey,
      pairedAt: new Date(now).toISOString(),
    })
    const signature = await channel
      .signApproval(SIGNING_DOMAINS.deviceRecord, payload, 'turn on developer mode for 8 hours')
      .catch(() => null)
    if (signature === null) return false
    const signed: SignedText = { payload, signature }
    const record = await this.options.devices.add(signed, 'dev')
    // The one before, if any, ends now: only the new key approves.
    await this.end('turned-off', false)
    const until = now + DEV_MODE_MS
    const timer = this.options.timers.setTimeout(() => {
      void this.turnOff('expired').catch(() => undefined)
    }, DEV_MODE_MS)
    this.active = { record, signer, until, timer }
    this.options.changed(true, 'on')
    return true
  }

  async turnOff(why: DevModeEnd): Promise<void> {
    await this.end(why, true)
  }

  /** At start: any key a previous run left unrevoked is gone with that process; revoke it. */
  async revokeLeftovers(): Promise<number> {
    let revoked = 0
    for (const record of this.options.devices.activeDev()) {
      if (record.deviceId === this.active?.record.deviceId) continue
      if (
        await this.options.devices.revoke(
          record.deviceId,
          'mac-ui',
          new Date(this.options.now()).toISOString(),
        )
      )
        revoked += 1
    }
    return revoked
  }

  private async end(why: DevModeEnd, tell: boolean): Promise<void> {
    const active = this.active
    this.active = null
    if (active === null) return
    this.options.timers.clearTimeout(active.timer)
    // A millisecond on: an approval it made this same millisecond was made while it was on, and
    // stored evidence counts only what a device signed before its revocation. The key is already
    // out of reach above, so nothing can be signed in that millisecond.
    await this.options.devices
      .revoke(active.record.deviceId, 'mac-ui', new Date(this.options.now() + 1).toISOString())
      .catch(() => false)
    if (tell) this.options.changed(false, why)
  }
}
