// electron-updater's own AppUpdater, run in plain Node against a local feed. Everything up to the
// hand-off to Squirrel.Mac is electron-updater's real code: reading app-update.yml, the generic
// provider fetching <channel>-mac.yml, its version comparison, choosing the zip for the
// architecture (MacUpdater.filterFilesForArch), and the download with its SHA-512 check. What is
// replaced: Electron's `net` (a Node http executor in its place, as electron-updater's own tests do),
// the Electron app (an AppAdapter over a temp directory), and Squirrel.Mac (quitAndInstall records).

import { request } from 'node:http'
import { createRequire } from 'node:module'
import { AppUpdater, MacUpdater } from 'electron-updater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { findFile } from 'electron-updater/out/providers/Provider'

// builder-util-runtime isn't a dependency of this package; take electron-updater's own copy, so the
// executor below is the same class electron-updater's providers expect.
const fromUpdater = createRequire(createRequire(import.meta.url).resolve('electron-updater'))
const runtime: any = fromUpdater('builder-util-runtime')

/** HttpExecutor over node:http, with the download method electron-updater's executor has. */
class NodeHttpExecutor extends runtime.HttpExecutor {
  createRequest(options: Record<string, unknown>, callback: (response: unknown) => void) {
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

  constructor(
    app: AppAdapter,
    private readonly arm64Mac: boolean,
  ) {
    super(null, app)
    const self = this as any
    self.httpExecutor = new NodeHttpExecutor()
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
