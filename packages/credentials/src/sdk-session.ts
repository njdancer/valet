// One cached @1password/sdk client, shared by both SDK providers (service account and desktop app).
// The client is created on first use, never cached if creating it failed, and dropped when 1Password
// rejects its authentication, so the next call starts again. Every call is bounded.

import { CredentialError } from '@valet/core'
import type { Timers } from './process'

export class SdkSession<C> {
  readonly #create: () => Promise<C>
  readonly #timers: Timers
  readonly #timeoutMs: number
  #client: Promise<C> | null = null
  #ready = false

  constructor(create: () => Promise<C>, timers: Timers, timeoutMs: number) {
    this.#create = create
    this.#timers = timers
    this.#timeoutMs = timeoutMs
  }

  /** Whether a client is up and hasn't been dropped since: using it won't ask the person again. */
  get live(): boolean {
    return this.#ready
  }

  /**
   * Runs `work` with the client, bounded. A CredentialError passes through as a fresh one (so no
   * provider message rides along); anything else is classified, and dropping the client is the
   * classifier's call.
   */
  async use<T>(
    work: (client: C) => Promise<T>,
    classify: (error: unknown) => { failure: CredentialError['failure']; dropClient: boolean },
  ): Promise<T> {
    const pending = this.#current()
    try {
      const client = await pending
      return await this.bounded(work(client))
    } catch (error) {
      if (error instanceof CredentialError) throw new CredentialError(error.failure)
      const { failure, dropClient } = classify(error)
      if (dropClient) this.#drop(pending)
      throw new CredentialError(failure)
    }
  }

  /** Forgets the client, so the next use creates one (and, for the desktop app, asks again). */
  reset(): void {
    this.#client = null
    this.#ready = false
  }

  #current(): Promise<C> {
    if (this.#client === null) {
      const created = this.#create()
      this.#client = created
      created.then(
        () => {
          if (this.#client === created) this.#ready = true
        },
        // A client that failed to come up is never cached.
        () => this.#drop(created),
      )
    }
    return this.#client
  }

  #drop(client: Promise<C>): void {
    if (this.#client === client) {
      this.#client = null
      this.#ready = false
    }
  }

  bounded<T>(work: Promise<T>, timeoutMs = this.#timeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.#timers.setTimeout(() => reject(new CredentialError('unavailable')), timeoutMs)
      work.then(
        (value) => {
          this.#timers.clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          this.#timers.clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}
