// The devices whose approval keys the Mac trusts (docs/agent-run-security.md#devices-and-keys).
//
// The Mac's own record isn't stored: it is built at each launch from the signer's public keys, the
// root every other record is checked against, so a file can't swap the Mac's key. Each phone's
// record is stored as the Mac signed it and counts only if that signature verifies against the
// Mac's approval key now. Revocations only tighten and need no signature; the Mac's own id can
// never be revoked.
//
// Phones on the account's device list (relay-hub.md, step 4c) count too, while the list the Mac
// verified against its pin has them: the RosterKeeper hands them over each time it checks the
// list, and they are kept only in memory, so they count again only once the list checks again.

import {
  canRevokeDevice,
  type DeviceLookup,
  type DeviceRecord,
  type DeviceRevocation,
  deviceRecordSchema,
  keyId,
  type RosterDevice,
  type SignedText,
  verifyDeviceRecord,
} from '@valet/core'
import type { TrustedLedger } from './ledger'
import type { MacKeys } from './signer'

/** When the Mac's synthesised record says it was paired: it is the root, so this is never shown. */
const MAC_PAIRED_AT = '2026-01-01T00:00:00.000Z'

export class DeviceStore implements DeviceLookup {
  readonly mac: DeviceRecord
  private cache: { readonly source: LedgerDataRef; readonly phones: Map<string, DeviceRecord> } | null = null
  /** Phones on the account's verified list that weren't paired here. */
  private account = new Map<string, DeviceRecord>()

  constructor(
    private readonly ledger: TrustedLedger,
    keys: MacKeys,
  ) {
    const macId = keyId(keys.approvalKey)
    this.mac = deviceRecordSchema.parse({
      v: 1,
      deviceId: macId,
      macId,
      role: 'mac',
      platform: 'macos',
      name: 'This Mac',
      approvalKey: keys.approvalKey,
      transportKey: keys.transportKey,
      agreementKey: keys.agreementKey,
      pairedAt: MAC_PAIRED_AT,
    })
  }

  get macId(): string {
    return this.mac.deviceId
  }

  device(deviceId: string): DeviceRecord | null {
    if (deviceId === this.mac.deviceId) return this.mac
    return this.phones().get(deviceId) ?? this.account.get(deviceId) ?? null
  }

  /**
   * The phones on the account's list as the Mac last verified it, each with when it was added.
   * Replaces the ones before: a phone the list dropped stops counting at once.
   */
  setAccountPhones(phones: readonly AccountPhoneInput[]): void {
    const next = new Map<string, DeviceRecord>()
    for (const { device, addedAt } of phones) {
      if (device.role !== 'phone' || device.deviceId === this.mac.deviceId) continue
      const record = deviceRecordSchema.safeParse({
        v: 1,
        deviceId: device.deviceId,
        macId: this.mac.deviceId,
        role: 'phone',
        platform: device.platform,
        name: device.name,
        approvalKey: device.approvalKey,
        transportKey: device.transportKey,
        agreementKey: device.agreementKey,
        pairedAt: addedAt,
      })
      if (record.success) next.set(device.deviceId, record.data)
    }
    this.account = next
  }

  /** True if this phone counts because it is on the account's list, not because it paired here. */
  isAccountPhone(deviceId: string): boolean {
    return !this.phones().has(deviceId) && this.account.has(deviceId)
  }

  revokedAt(deviceId: string): string | null {
    if (deviceId === this.mac.deviceId) return null
    return this.ledger.data.revocations.find((r) => r.deviceId === deviceId)?.revokedAt ?? null
  }

  /** Phones paired here or on the account's list that aren't revoked. */
  activePhones(): DeviceRecord[] {
    return this.allPhones().filter((d) => this.revokedAt(d.deviceId) === null)
  }

  /** Every phone record that verifies, revoked or not, and every phone on the account's list. */
  allPhones(): DeviceRecord[] {
    const paired = this.phones()
    return [...paired.values(), ...[...this.account.values()].filter((d) => !paired.has(d.deviceId))]
  }

  /** True if this id is a paired phone that isn't revoked. */
  isActivePhone(deviceId: string): boolean {
    const device = this.device(deviceId)
    return device !== null && device.role === 'phone' && this.revokedAt(deviceId) === null
  }

  /**
   * Adds a phone the Mac has signed the record of (after a `device-pair` approval). Refuses a
   * record that doesn't verify, names another Mac, is for the Mac itself, or was revoked before.
   */
  async add(signed: SignedText): Promise<DeviceRecord> {
    const check = verifyDeviceRecord(signed, this.mac.approvalKey)
    if (!check.ok || check.record.role !== 'phone') throw new Error('device record refused')
    const id = check.record.deviceId
    if (this.ledger.data.revocations.some((r) => r.deviceId === id)) throw new Error('device was revoked')
    await this.ledger.commit((draft) => {
      draft.devices = draft.devices.filter((d) => recordId(d) !== id)
      draft.devices.push(signed)
    })
    this.cache = null
    return check.record
  }

  /** Revokes a phone. Never the Mac. Takes effect even if the write fails (it only tightens). */
  async revoke(deviceId: string, by: DeviceRevocation['by'], at: string): Promise<boolean> {
    if (!canRevokeDevice(deviceId, this.mac.deviceId)) return false
    if (this.revokedAt(deviceId) !== null) return true
    await this.ledger.commit(
      (draft) => {
        draft.revocations.push({ deviceId, macId: this.mac.deviceId, revokedAt: at, by })
      },
      { tightening: true },
    )
    return true
  }

  private phones(): Map<string, DeviceRecord> {
    const source = this.ledger.data.devices
    if (this.cache !== null && this.cache.source === source) return this.cache.phones
    const phones = new Map<string, DeviceRecord>()
    for (const signed of source) {
      const check = verifyDeviceRecord(signed, this.mac.approvalKey)
      if (check.ok && check.record.role === 'phone' && check.record.macId === this.mac.deviceId) {
        phones.set(check.record.deviceId, check.record)
      }
    }
    this.cache = { source, phones }
    return phones
  }
}

type LedgerDataRef = readonly SignedText[]

/** A phone on the account's list (roster-keeper.ts's AccountPhone). */
export interface AccountPhoneInput {
  readonly device: RosterDevice
  readonly addedAt: string
}

function recordId(signed: SignedText): string | null {
  try {
    const id = (JSON.parse(signed.payload) as { deviceId?: unknown }).deviceId
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}
