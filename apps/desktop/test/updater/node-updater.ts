// electron-updater's own AppUpdater, run in plain Node against a local feed. Everything up to the
// hand-off to Squirrel.Mac is electron-updater's real code: reading app-update.yml, the generic
// provider fetching <channel>-mac.yml, its version comparison, choosing the zip for the
// architecture (MacUpdater.filterFilesForArch), and the download with its SHA-512 check. What is
// replaced: Electron's `net` (a Node http executor in its place, as electron-updater's own tests do),
// the Electron app (an AppAdapter over a temp directory), and Squirrel.Mac (quitAndInstall records).
// Electron's session partition is emulated as far as the guard needs: every request the executor
// makes, each redirect hop included, is shown to the partition's onBeforeRequest listener first, and
// a cancelled one fails as Electron's net does (net::ERR_BLOCKED_BY_CLIENT, no code).

import { EventEmitter } from 'node:events'
import { request } from 'node:http'
import * as builderRuntime from 'builder-util-runtime'
import { AppUpdater, MacUpdater } from 'electron-updater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { findFile } from 'electron-updater/out/providers/Provider'
import type { SessionLike } from '../../src/main/updater'

// The same builder-util-runtime electron-updater's providers use (one copy in the lockfile), so the
// executor below is the class they expect. Its typings are generic over the request type; untyped here.
const runtime: any = builderRuntime

type BeforeRequest = Parameters<SessionLike['webRequest']['onBeforeRequest']>[0]

/** The "electron-updater" partition, as far as webRequest.onBeforeRequest goes. */
export class FakePartition implements SessionLike {
  private listener: BeforeRequest | null = null
  readonly seen: string[] = []
  readonly webRequest = {
    onBeforeRequest: (listener: BeforeRequest) => {
      this.listener = listener
    },
  }

  /** True if the request may go ahead. */
  allows(url: string, method: string): boolean {
    this.seen.push(url)
    if (this.listener === null) return true
    let cancel = true
    this.listener({ url, method }, (response) => {
      cancel = response.cancel
    })
    return !cancel
  }
}

/** What Electron's net.request does with a request webRequest cancelled. */
function blockedRequest() {
  const fake = Object.assign(new EventEmitter(), {
    end: () => {
      setImmediate(() => fake.emit('error', new Error('net::ERR_BLOCKED_BY_CLIENT')))
    },
    abort: () => {},
    destroy: () => {},
  })
  return fake
}

/** The request options builder-util-runtime's configureRequestUrl fills in. */
interface RequestTarget {
  readonly protocol?: string
  readonly hostname?: string
  readonly port?: string | number | null
  readonly path?: string
  readonly method?: string
}

/** HttpExecutor over node:http, with the download method electron-updater's executor has. */
class NodeHttpExecutor extends runtime.HttpExecutor {
  constructor(private readonly partition: FakePartition) {
    super()
  }

  createRequest(options: RequestTarget, callback: (response: unknown) => void) {
    const port = options.port == null || options.port === '' ? '' : `:${options.port}`
    const url = `${options.protocol ?? 'https:'}//${options.hostname}${port}${options.path ?? '/'}`
    if (!this.partition.allows(url, options.method ?? 'GET')) return blockedRequest()
    return request(options, callback)
  }

  download(url: URL, destination: string, options: { cancellationToken: unknown; headers?: unknown }) {
    const token = options.cancellationToken as any
    return token.createPromise(
      (resolve: (value: string) => void, reject: (error: unknown) => void, onCancel: unknown) => {
        const requestOptions: Record<string, unknown> = { headers: options.headers ?? undefined }
        runtime.configureRequestUrl(url, requestOptions)
        runtime.configureRequestOptions(requestOptions)
        ;(this as any).doDownload(
          requestOptions,
          {
            destination,
            options,
            onCancel,
            callback: (error: unknown) => (error == null ? resolve(destination) : reject(error)),
            responseHandler: null,
          },
          0,
        )
      },
    )
  }
}

export class NodeAppAdapter implements AppAdapter {
  readonly name = 'siteadapter'
  readonly isPackaged = true
  constructor(
    readonly version: string,
    readonly appUpdateConfigPath: string,
    readonly userDataPath: string,
    readonly baseCachePath: string,
  ) {}
  whenReady(): Promise<void> {
    return Promise.resolve()
  }
  relaunch(): void {}
  quit(): void {}
  onQuit(): void {}
}

export class NodeUpdater extends AppUpdater {
  readonly installs: Array<[boolean | undefined, boolean | undefined]> = []
  /** The session partition every request goes through. */
  readonly partition = new FakePartition()

  constructor(
    app: AppAdapter,
    private readonly arm64Mac: boolean,
  ) {
    super(null, app)
    const self = this as any
    self.httpExecutor = new NodeHttpExecutor(this.partition)
    self._testOnlyOptions = { platform: 'darwin' }
  }

  protected doDownloadUpdate(options: DownloadUpdateOptions) {
    const { info, provider } = options.updateInfoAndProvider
    // Protected in the typings, public in the JavaScript: the same function MacUpdater calls.
    const files = (MacUpdater as any).filterFilesForArch(provider.resolveFiles(info), this.arm64Mac)
    const zip = findFile(files, 'zip', ['pkg', 'dmg'])
    if (zip == null) throw runtime.newError('ZIP file not provided', 'ERR_UPDATER_ZIP_FILE_NOT_FOUND')
    return this.executeDownload({
      fileExtension: 'zip',
      fileInfo: zip,
      downloadUpdateOptions: options,
      task: (destination, downloadOptions) =>
        (this as any).httpExecutor.download(zip.url, destination, downloadOptions),
      // Where MacUpdater would hand the zip to Squirrel.Mac through its local proxy.
      done: async (event) => {
        this.dispatchUpdateDownloaded(event)
        return []
      },
    })
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter])
  }
}
