// The update provider electron-updater asks for the channel file, in place of its generic one. It
// fetches the channel file, its envelope and the envelope's signature from the compiled-in feed
// base only, and hands electron-updater the update info only if verifyFeed accepts them. The bytes
// that were checked are the bytes that are parsed. Zip URLs in the file must stay under the base.
//
// electron-updater builds the provider itself, `new updateProvider(options, updater, runtime)`, so
// the dependencies are bound in a factory around the class.

import type { KeyObject } from 'node:crypto'
import type { OutgoingHttpHeaders } from 'node:http'
import { Provider, type ResolvedUpdateFileInfo, type UpdateInfo } from 'electron-updater'
import {
  type ProviderRuntimeOptions,
  parseUpdateInfo,
  resolveFiles,
} from 'electron-updater/out/providers/Provider'
import { type FeedChannel, type FeedRefusal, verifyFeed } from './feed-envelope'
import { isUnderFeedBase } from './request-guard'

/** Thrown by the provider. The code is all classifyUpdateError reads; the message is fixed. */
export class FeedRefusedError extends Error {
  override name = 'FeedRefusedError'
  readonly code: string
  constructor(readonly reason: FeedRefusal | 'file-outside-feed') {
    super('update feed refused')
    this.code = FEED_REFUSAL_CODES[reason]
  }
}

export const FEED_REFUSAL_CODES: Readonly<Record<FeedRefusal | 'file-outside-feed', string>> = {
  'signature-invalid': 'ERR_SITEADAPTER_FEED_UNVERIFIED',
  'envelope-invalid': 'ERR_SITEADAPTER_FEED_UNVERIFIED',
  'channel-mismatch': 'ERR_SITEADAPTER_FEED_UNVERIFIED',
  'yml-mismatch': 'ERR_SITEADAPTER_FEED_UNVERIFIED',
  'file-outside-feed': 'ERR_SITEADAPTER_FEED_UNVERIFIED',
  expired: 'ERR_SITEADAPTER_FEED_EXPIRED',
}

export interface SignedFeedDeps {
  /** The validated feed base, ending in "/". */
  readonly baseUrl: string
  readonly publicKey: KeyObject
  readonly now: () => number
  /** Sent in place of electron-updater's per-install id. */
  readonly stagingId: string
}

/** The provider shape electron-updater's `setFeedURL({ provider: 'custom', updateProvider })` takes. */
export type SignedFeedProviderClass = new (
  options: unknown,
  updater: { readonly channel: string | null },
  runtime: ProviderRuntimeOptions,
) => Provider<UpdateInfo>

function statusCode(error: unknown): unknown {
  try {
    return typeof error === 'object' && error !== null
      ? (error as { statusCode?: unknown }).statusCode
      : undefined
  } catch {
    return undefined
  }
}

function feedChannel(channel: string | null): FeedChannel {
  return channel === 'beta' ? 'beta' : 'latest'
}

export function signedFeedProvider(deps: SignedFeedDeps): SignedFeedProviderClass {
  const base = new URL(deps.baseUrl)
  return class SignedFeedProvider extends Provider<UpdateInfo> {
    constructor(
      _options: unknown,
      private readonly updater: { readonly channel: string | null },
      runtime: ProviderRuntimeOptions,
    ) {
      super(runtime)
    }

    override setRequestHeaders(headers: OutgoingHttpHeaders | null): void {
      super.setRequestHeaders({ ...(headers ?? {}), 'x-user-staging-id': deps.stagingId })
    }

    async getLatestVersion(): Promise<UpdateInfo> {
      const channel = feedChannel(this.updater.channel)
      const url = (suffix: string) => new URL(`${channel}-mac.${suffix}`, base)
      const ymlUrl = url('yml')
      const yml = await this.httpRequest(ymlUrl)
      const envelope = await this.fetchSigning(url('envelope.json'), 'envelope-invalid')
      const signature = await this.fetchSigning(url('envelope.json.sig'), 'signature-invalid')
      const parsed: { info: UpdateInfo | null } = { info: null }
      const verdict = verifyFeed(
        { yml, envelope, signature },
        {
          publicKey: deps.publicKey,
          channel,
          now: deps.now(),
          // Only called once the bytes match the envelope; the info parsed is the info returned.
          readYmlVersion: (text) => {
            parsed.info = parseUpdateInfo(text, `${channel}-mac.yml`, ymlUrl)
            return parsed.info?.version
          },
        },
      )
      const info = parsed.info
      if (!verdict.ok) throw new FeedRefusedError(verdict.reason)
      if (info === null) throw new FeedRefusedError('yml-mismatch')
      // Fail now rather than at download: every file must be under the feed base.
      this.resolveFiles(info)
      return info
    }

    /** A channel file without its envelope or signature is unverified, not an unreachable feed. */
    private async fetchSigning(url: URL, missing: FeedRefusal): Promise<string | null> {
      try {
        return await this.httpRequest(url)
      } catch (error) {
        if (statusCode(error) === 404) throw new FeedRefusedError(missing)
        throw error
      }
    }

    resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
      const files = resolveFiles(info, base)
      if (files.some((file) => !isUnderFeedBase(file.url.href, deps.baseUrl))) {
        throw new FeedRefusedError('file-outside-feed')
      }
      return files
    }
  }
}
