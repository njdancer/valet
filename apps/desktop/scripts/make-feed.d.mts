// Types for make-feed.mjs, so the tests that import it typecheck.

export declare class FeedError extends Error {}

export interface FeedFile {
  readonly name: string
  /** Base64, as electron-updater compares it. */
  readonly sha512: string
  readonly size: number
}

export declare function channelsForVersion(version: string): Array<'latest' | 'beta'>

export declare function buildFeedYaml(input: {
  readonly version: string
  readonly files: readonly FeedFile[]
  readonly releaseDate: string
}): string

export declare function hashZip(path: string): Promise<FeedFile>

export declare function makeFeed(input: {
  readonly version: string
  readonly zips: readonly string[]
  readonly outDir: string
  readonly releaseDate?: string
}): Promise<string[]>
