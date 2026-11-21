// Types for cloudflared.mjs, so the tests that import it typecheck.

import type { NodeArch, NodeRuntimePin } from './node-runtime.mjs'

export type CloudflaredPin = NodeRuntimePin

export declare const CLOUDFLARED_PIN: string
export declare const CLOUDFLARED_CACHE: string
export declare const CLOUDFLARED_OUT: string
export declare const CLOUDFLARED_RELEASES: string

export declare function readCloudflaredPin(text: string): CloudflaredPin
export declare function cloudflaredUrl(pin: CloudflaredPin, arch: NodeArch): string
export declare function verifiedCloudflared(
  pin: CloudflaredPin,
  arch: NodeArch,
  options?: { cache?: string; fetch?: typeof fetch },
): Promise<string>
export declare function buildCloudflared(options?: {
  out?: string
  cache?: string
  fetch?: typeof fetch
}): Promise<{ out: string; pin: CloudflaredPin }>
export declare function cloudflaredSignArguments(
  pin: CloudflaredPin,
  identity: string,
  file: string,
  options?: { timestamp?: boolean },
): string[]
export declare function signCloudflared(pin: CloudflaredPin, identity: string, file?: string): void
