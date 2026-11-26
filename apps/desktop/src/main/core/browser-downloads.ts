// What agents' browser sessions downloaded, held in memory for a short while at a capability
// address (docs/agent-browser.md, "Downloads"): the agent fetches https://<the Mac's name>/d/<id>/<name>
// with its own fetch tool. Nothing is written to disk. A file is gone after DOWNLOAD_LIMITS.keepMs,
// when its session closes, or when newer files push it out.

import { randomBytes } from 'node:crypto'
import type { ServedFile } from '@valet/mcp-server'

export const DOWNLOAD_LIMITS = {
  keepMs: 10 * 60_000,
  /** Files and bytes held in all; the oldest go first. */
  files: 30,
  bytes: 200 * 1024 * 1024,
} as const

interface Held extends ServedFile {
  readonly owner: string
  readonly expiresAt: number
}

export class DownloadShelf {
  private readonly held = new Map<string, Held>()

  constructor(
    private readonly now: () => number,
    private readonly newId: () => string = () => randomBytes(18).toString('base64url'),
  ) {}

  /** Holds a file for `owner` (a session), and gives its address id and when it goes. */
  put(owner: string, file: ServedFile): { readonly id: string; readonly expiresAt: number } {
    this.sweep()
    const id = this.newId()
    const expiresAt = this.now() + DOWNLOAD_LIMITS.keepMs
    this.held.set(id, { ...file, owner, expiresAt })
    let bytes = [...this.held.values()].reduce((sum, f) => sum + f.data.length, 0)
    for (const [oldest, file] of this.held) {
      if (this.held.size <= DOWNLOAD_LIMITS.files && bytes <= DOWNLOAD_LIMITS.bytes) break
      if (oldest === id) break
      this.held.delete(oldest)
      bytes -= file.data.length
    }
    return { id, expiresAt }
  }

  /** The file at an address id while it is held; null otherwise. */
  get(id: string): ServedFile | null {
    this.sweep()
    const file = this.held.get(id)
    return file === undefined ? null : { name: file.name, mimeType: file.mimeType, data: file.data }
  }

  /** Lets go of everything a session downloaded, when it closes. */
  drop(owner: string): void {
    for (const [id, file] of this.held) if (file.owner === owner) this.held.delete(id)
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, file] of this.held) if (file.expiresAt <= now) this.held.delete(id)
  }
}
