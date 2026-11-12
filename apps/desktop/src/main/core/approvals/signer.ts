// The Mac's own device keys (docs/approval-broker.md#approving-at-the-mac). In a release build the
// Swift helper holds them in the Secure Enclave and the approval key signs only after Touch ID (or
// the Mac's password), so the person's gesture is inside the signature: no finger, no signature.
// Electron never holds a private key, and the renderer never sees a signature.
//
// The software signer here is for tests and for dev builds without the helper. It signs without
// asking anyone, so a release build must never construct one (see `allowSoftwareSigner`).

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { type SigningDomain, signingInput } from '@valet/core'

export interface MacKeys {
  readonly approvalKey: string
  readonly transportKey: string
  readonly agreementKey: string
}

export interface MacSigner {
  /** The Mac's public keys, created on first use. Never a private key. */
  keys(): Promise<MacKeys>
  /**
   * Signs `payload` under `domain` with the approval key. In a release build this shows the OS's
   * Touch ID prompt with `reason`, in the app's words. Resolves null if the person cancelled or
   * failed the prompt; never throws for that.
   */
  sign(domain: SigningDomain, payload: string, reason: string): Promise<string | null>
}

/** Release builds use only the Secure Enclave helper. */
export function allowSoftwareSigner(isPackaged: boolean): boolean {
  return !isPackaged
}

interface Pair {
  readonly privateKey: KeyObject
  readonly spki: string
}

function p256(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { privateKey, spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }
}

/**
 * Keys in memory, and a `present` callback that stands in for the person's finger: it decides
 * whether each prompt is answered. Tests use it to show that nothing is signed without presence.
 */
export class SoftwareSigner implements MacSigner {
  private readonly approval = p256()
  private readonly transport = p256()
  private readonly agreement = p256()
  /** Every reason a prompt was shown with, in order. */
  readonly prompts: string[] = []

  constructor(private readonly present: (reason: string) => boolean | Promise<boolean> = () => true) {}

  async keys(): Promise<MacKeys> {
    return {
      approvalKey: this.approval.spki,
      transportKey: this.transport.spki,
      agreementKey: this.agreement.spki,
    }
  }

  async sign(domain: SigningDomain, payload: string, reason: string): Promise<string | null> {
    this.prompts.push(reason)
    if (!(await this.present(reason))) return null
    return sign('sha256', signingInput(domain, payload), {
      key: this.approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
  }
}
