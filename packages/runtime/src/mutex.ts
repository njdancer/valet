// One lock per adapter, so two tool calls never drive the same browser session at once. Waiters run
// in arrival order.

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => held)
    this.tails.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      // Only the last waiter may forget the key; anyone queued behind us still needs the chain.
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** True while a task holds or waits for `key`. */
  busy(key: string): boolean {
    return this.tails.has(key)
  }
}
