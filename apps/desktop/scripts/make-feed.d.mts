// Types for make-feed.mjs, so the tests that import it typecheck.

import type { KeyObject } from 'node:crypto'

export declare class FeedError extends Error {}

export declare const RELEASE_APP_ID: string
export declare const ENVELOPE_KEYS: readonly string[]
export declare const MAX_VALID_DAYS: number

export interface FeedFile {
  readonly name: string
  /** Base64, as electron-updater compares it. */
  readonly sha512: string
  readonly size: number
}

export interface BundleInfo {
  readonly bundleId: unknown
  readonly version: unknown
}

export declare function channelsForVersion(version: string): Array<'latest' | 'beta'>

export declare function buildFeedYaml(input: {
  readonly version: string
  readonly files: readonly FeedFile[]
  readonly releaseDate: string
}): string

export declare function buildEnvelope(input: {
  readonly channel: 'latest' | 'beta'
  readonly version: string
  readonly yml: string
  readonly minimumVersion: string
  readonly issuedAt: string
  readonly expiresAt: string
}): string

export declare function signEnvelope(envelope: string, privateKey: KeyObject | string): string

export declare function readZipBundleInfo(path: string): BundleInfo

export declare function hashZip(path: string): Promise<FeedFile>

export declare function makeFeed(input: {
  readonly version: string
  readonly zips: readonly string[]
  readonly outDir: string
  readonly releaseDate?: string
  readonly signingKey?: KeyObject | string
  readonly minimumVersion?: string
  readonly validDays?: number
  readonly appId?: string
  readonly readBundleInfo?: (path: string) => BundleInfo | Promise<BundleInfo>
}): Promise<string[]>
