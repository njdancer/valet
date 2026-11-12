// The Mac's own device keys (docs/approval-broker.md#approving-at-the-mac). In a release build the
// Swift helper holds them in the Secure Enclave and the approval key signs only after Touch ID (or
// the Mac's password), so the person's gesture is inside the signature: no finger, no signature.
// Electron never holds a private key, and the renderer never sees a signature.
//
// The software signer here is for tests and for dev builds without the helper. It signs without
// asking anyone, so a release build must never construct one (see `allowSoftwareSigner`).

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto'
import { type SerializedRequest, SIGNING_DOMAINS, type SigningDomain, signingInput } from '@valet/core'
import { promptReason } from './prompts'

export interface MacKeys {
  readonly approvalKey: string
  readonly transportKey: string
  readonly agreementKey: string
}

export interface MacSigner {
  /** The Mac's public keys, created on first use. Never a private key. */
  keys(): Promise<MacKeys>
  /**
   * Signs `payload`, an approval of exactly `request`, with the approval key. In a release build
   * the helper checks that, shows the OS's Touch ID prompt with a reason it writes itself from the
   * request (prompts.ts's wording), and signs only once the person answers it. Resolves null if
   * they cancelled or failed the prompt; never throws for that.
   */
  signDecision(request: SerializedRequest, payload: string): Promise<string | null>
  /**
   * The phone channel's key operations (docs/relay-worker.md), or undefined where this signer
   * can't do them.
   */
  readonly channel?: ChannelKeys
}

/** What the phone channel needs from the Mac's keys. No private key ever leaves them. */
export interface ChannelKeys {
  /** The transport key's raw signature over `valet/relay-auth/v1\n<payload>`. No presence needed. */
  signTransport(payload: string): Promise<string>
  /** The agreement key's half of an ECDH with `peer`: the shared point's x coordinate. */
  agree(peer: KeyObject): Promise<Buffer>
  /**
   * The approval key's signature over `<domain>\n<payload>` for things the person already
   * approved: device records after a `device-pair` approval, the pairing challenge, the relay
   * binding. Null if the prompt was cancelled.
   */
  signApproval(domain: SigningDomain, payload: string, reason: string): Promise<string | null>
  /** Several payloads under one prompt (a pairing's two device records). Null if cancelled. */
  signApprovals?(domain: SigningDomain, payloads: readonly string[], reason: string): Promise<string[] | null>
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

function fromPkcs8(pkcs8: string): Pair {
  const privateKey = createPrivateKey({ key: Buffer.from(pkcs8, 'base64url'), format: 'der', type: 'pkcs8' })
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
  return { privateKey, spki }
}

/** A software signer's three private keys, PKCS#8 DER in base64url, as a dev build keeps them. */
export interface SoftwareKeys {
  readonly approval: string
  readonly transport: string
  readonly agreement: string
}

/** New software keys, for a dev build's key file. */
export function newSoftwareKeys(): SoftwareKeys {
  const pkcs8 = () =>
    generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'der' })
      .toString('base64url')
  return { approval: pkcs8(), transport: pkcs8(), agreement: pkcs8() }
}

/**
 * Keys in memory, and a `present` callback that stands in for the person's finger: it decides
 * whether each prompt is answered. Tests use it to show that nothing is signed without presence.
 */
export class SoftwareSigner implements MacSigner {
  private readonly approval: Pair
  private readonly transport: Pair
  private readonly agreement: Pair
  /** Every reason a prompt was shown with, in order. */
  readonly prompts: string[] = []
  readonly channel: ChannelKeys

  /** `keys`: a dev build's kept keys, so its identity (and so its evidence) survives a restart. */
  constructor(
    private readonly present: (reason: string) => boolean | Promise<boolean> = () => true,
    keys?: SoftwareKeys,
  ) {
    this.approval = keys === undefined ? p256() : fromPkcs8(keys.approval)
    this.transport = keys === undefined ? p256() : fromPkcs8(keys.transport)
    this.agreement = keys === undefined ? p256() : fromPkcs8(keys.agreement)
    this.channel = {
      signTransport: async (payload) =>
        sign('sha256', signingInput(SIGNING_DOMAINS.relayAuth, payload), {
          key: this.transport.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      agree: async (peer) => diffieHellman({ privateKey: this.agreement.privateKey, publicKey: peer }),
      signApproval: (domain, payload, reason) => this.sign(domain, payload, reason),
    }
  }

  async keys(): Promise<MacKeys> {
    return {
      approvalKey: this.approval.spki,
      transportKey: this.transport.spki,
      agreementKey: this.agreement.spki,
    }
  }

  signDecision(request: SerializedRequest, payload: string): Promise<string | null> {
    return this.sign(SIGNING_DOMAINS.approvalDecision, payload, promptReason(request))
  }

  /** Signs anything under any domain: tests use it for device records and forgeries. */
  async sign(domain: SigningDomain, payload: string, reason: string): Promise<string | null> {
    this.prompts.push(reason)
    if (!(await this.present(reason))) return null
    return sign('sha256', signingInput(domain, payload), {
      key: this.approval.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
  }
}
