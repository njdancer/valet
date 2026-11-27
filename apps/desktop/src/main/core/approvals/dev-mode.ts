// Developer mode (docs/approval-broker.md#developer-mode): while agents iterate on adapters, the
// person turns it on once and the approvals that would keep interrupting them answer themselves.
//
// - Only an unpackaged build has it; a release build never constructs one that can turn on.
// - Turning it on is one Touch ID: the Mac's approval key signs a device record (role `dev`) for a
//   key made now. The private key is written only to the `keep` store, for a restart (below).
// - That key signs approvals like any device, and approvableOn lets it approve only an adapter's
//   version and a tool turned on. Settings (picked on the card), logins and credentials, pairing,
//   lockdown, irreversible calls and connecting agents still ask the person.
// - It ends after DEV_MODE_MS, on lockdown, and when the person turns it off. A restart doesn't end
//   it (Nick, 2026-11-27: agents keep debugging while he's away, and Valet restarts for each new
//   build): with a `keep` store, the key and its end time are kept there (the Keychain, in an
//   unpackaged build) and taken up again at the next start while its 8 hours last and its record is
//   still active. Without one, or once it ends, the record is revoked at the next start. Revoking
//   keeps what it approved while on, as for a phone, so an adapter it approved stays approved.

import { type DeviceRecord, keyId, SIGNING_DOMAINS, type SignedText } from '@valet/core'
import type { Timers } from './broker'
import type { DeviceStore } from './devices'
import { type ChannelKeys, newSoftwareKeys, type SoftwareKeys, SoftwareSigner } from './signer'

/** How long one Touch ID keeps developer mode on. */
export const DEV_MODE_MS = 8 * 3600_000

export interface DevModeStatus {
  /** Whether this build has developer mode at all (unpackaged builds only). */
  readonly available: boolean
  /** When it turns itself off, while it is on. */
  readonly until: string | null
}

export type DevModeEnd = 'expired' | 'turned-off' | 'lockdown' | 'restart'

/** What a restart needs to take developer mode up again: its key, its record and when it ends. */
export interface KeptDevMode {
  readonly keys: SoftwareKeys
  readonly deviceId: string
  readonly until: string
}

/** Where the key waits across a restart. Each call may throw; a failed write only means no resume. */
export interface DevModeKeep {
  read(): Promise<KeptDevMode | null>
  write(kept: KeptDevMode): Promise<void>
  clear(): Promise<void>
}

export interface DevModeOptions {
  readonly available: boolean
  readonly devices: DeviceStore
  /** The Mac's approval key, for the one signed record (Touch ID). Absent: can't turn on. */
  readonly channel: ChannelKeys | undefined
  readonly now: () => number
  readonly timers: Timers
  /** It turned on or off. Must not throw. */
  readonly changed: (on: boolean, why: 'on' | 'resumed' | DevModeEnd) => void
  /** Keeps it on across a restart. Absent: a restart ends it. */
  readonly keep?: DevModeKeep
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
    const software = newSoftwareKeys()
    const signer = new SoftwareSigner(() => true, software)
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
    let signature: string | null
    try {
      signature = await channel.signApproval(
        SIGNING_DOMAINS.deviceRecord,
        payload,
        'turn on developer mode for 8 hours',
      )
    } catch {
      return false
    }
    if (signature === null) return false
    const signed: SignedText = { payload, signature }
    const record = await this.options.devices.add(signed, 'dev')
    // The one before, if any, ends now: only the new key approves.
    await this.end('turned-off', false)
    const until = now + DEV_MODE_MS
    this.begin(record, signer, until)
    // Kept for a restart; without it, a restart ends it as before.
    await this.options.keep
      ?.write({ keys: software, deviceId: record.deviceId, until: new Date(until).toISOString() })
      .catch(() => undefined)
    this.options.changed(true, 'on')
    return true
  }

  /**
   * At start: on again with the key the last run kept, while its 8 hours last and its record is
   * still active with that key. False otherwise, and what was kept is cleared. `allowed` false (the
   * Mac is locked down) clears it too. Call before revokeLeftovers, which then spares its record.
   */
  async resume(allowed: boolean): Promise<boolean> {
    const keep = this.options.keep
    if (keep === undefined || this.active !== null) return false
    const kept = await keep.read().catch(() => null)
    if (kept === null) return false
    const until = Date.parse(kept.until)
    const now = this.options.now()
    const record = this.options.devices.activeDev().find((d) => d.deviceId === kept.deviceId)
    let signer: SoftwareSigner | null = null
    try {
      signer = new SoftwareSigner(() => true, kept.keys)
    } catch {
      signer = null
    }
    const keys = signer === null ? null : await signer.keys()
    const fits =
      this.options.available &&
      allowed &&
      signer !== null &&
      record !== undefined &&
      keys !== null &&
      keys.approvalKey === record.approvalKey &&
      keyId(keys.approvalKey) === record.deviceId &&
      Number.isFinite(until) &&
      until > now &&
      // Never longer than one Touch ID's 8 hours from now, whatever the kept time says.
      until <= now + DEV_MODE_MS
    if (!fits || signer === null || record === undefined) {
      await this.forget()
      return false
    }
    this.begin(record, signer, until)
    this.options.changed(true, 'resumed')
    return true
  }

  /** Clears what was kept; a failure leaves the record's revocation to stop a resume. */
  private async forget(): Promise<void> {
    try {
      await this.options.keep?.clear()
    } catch {
      // The record is revoked below, or at the next start.
    }
  }

  private begin(record: DeviceRecord, signer: SoftwareSigner, until: number): void {
    const timer = this.options.timers.setTimeout(() => void this.expire(), until - this.options.now())
    this.active = { record, signer, until, timer }
  }

  async turnOff(why: DevModeEnd): Promise<void> {
    await this.end(why, true)
  }

  private async expire(): Promise<void> {
    try {
      await this.turnOff('expired')
    } catch {
      // Already off in memory; the next start revokes the record.
    }
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
    await this.forget()
    // A millisecond on: an approval it made this same millisecond was made while it was on, and
    // stored evidence counts only what a device signed before its revocation. The key is already
    // out of reach above, so nothing can be signed in that millisecond.
    try {
      await this.options.devices.revoke(
        active.record.deviceId,
        'mac-ui',
        new Date(this.options.now() + 1).toISOString(),
      )
    } catch {
      // The kept key was cleared above, so the next start revokes the record instead of resuming.
      // Only when both writes failed (the ledger and the keep store) could it resume, and then
      // only until its own 8 hours end.
    }
    if (tell) this.options.changed(false, why)
  }
}
