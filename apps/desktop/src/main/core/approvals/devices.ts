// The devices whose approval keys the Mac trusts (docs/agent-run-security.md#devices-and-keys).
//
// The Mac's own record isn't stored: it is built at each launch from the signer's public keys, the
// root every other record is checked against, so a file can't swap the Mac's key. Each phone's
// record is stored as the Mac signed it and counts only if that signature verifies against the
// Mac's approval key now. Revocations only tighten and need no signature; the Mac's own id can
// never be revoked.

import {
  canRevokeDevice,
  type DeviceLookup,
  type DeviceRecord,
  type DeviceRevocation,
  deviceRecordSchema,
  keyId,
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
    return this.phones().get(deviceId) ?? null
  }

  revokedAt(deviceId: string): string | null {
    if (deviceId === this.mac.deviceId) return null
    return this.ledger.data.revocations.find((r) => r.deviceId === deviceId)?.revokedAt ?? null
  }

  /** Paired phones that aren't revoked. */
  activePhones(): DeviceRecord[] {
    return [...this.phones().values()].filter((d) => this.revokedAt(d.deviceId) === null)
  }

  /** Every phone record that verifies, revoked or not. */
  allPhones(): DeviceRecord[] {
    return [...this.phones().values()]
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

function recordId(signed: SignedText): string | null {
  try {
    const id = (JSON.parse(signed.payload) as { deviceId?: unknown }).deviceId
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}
