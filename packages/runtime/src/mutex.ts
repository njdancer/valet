// One lock per adapter, so two tool calls never drive the same browser session at once. Waiters run
// in arrival order.

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Waits for `key` and returns its release function. Calling release more than once is harmless.
   * The tool host uses this rather than run() when the lock must outlive the call's own result.
   */
  async acquire(key: string): Promise<() => void> {
    const { ready, release } = this.enter(key)
    await ready
    return release
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const { ready, release } = this.enter(key)
    await ready
    try {
      return await task()
    } finally {
      release()
    }
  }

  /** Joins the queue for `key` synchronously, so arrival order is call order. */
  private enter(key: string): { ready: Promise<void>; release: () => void } {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let unblock: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      unblock = resolve
    })
    const tail = previous.then(() => held)
    this.tails.set(key, tail)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      unblock()
      // Only the last waiter may forget the key; anyone queued behind us still needs the chain.
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
    return { ready: previous, release }
  }

  /** True while a task holds or waits for `key`. */
  busy(key: string): boolean {
    return this.tails.has(key)
  }
}
