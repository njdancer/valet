// A fixed-window counter: at most `limit` events per `windowMs`, per key. In memory only, so a
// Durable Object that is evicted starts counting again; the per-source limits at the front door
// (the rate-limiting binding) don't depend on it.

export class WindowCounter {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number,
    /** Keys kept at most; the oldest window is dropped beyond it, so the map can't grow unbounded. */
    private readonly maxKeys = 1024,
  ) {}

  /** Counts one event; false when this key is over its limit for the current window. */
  take(key: string): boolean {
    const now = this.now()
    let window = this.windows.get(key)
    if (window === undefined || now - window.start >= this.windowMs) {
      if (window === undefined && this.windows.size >= this.maxKeys) {
        this.windows.delete(this.windows.keys().next().value as string)
      }
      window = { start: now, count: 0 }
      this.windows.set(key, window)
    }
    window.count++
    return window.count <= this.limit
  }

  forget(key: string): void {
    this.windows.delete(key)
  }
}
