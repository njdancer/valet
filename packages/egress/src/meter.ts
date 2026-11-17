// Byte accounting for one run (docs/adapter-kinds.md#f1-the-egress-broker). Every byte the broker
// sends for a run is spent from its upload budget before it leaves, and every byte it receives
// earns a little more: 1 KB for each 100 KB. So a `read` tool can fetch as much as its other limits
// allow, but can only carry a small amount out, however it encodes it (a path, a query, a header,
// a body, a WebSocket message).

import { ValetError } from '@valet/core'

/** Bytes received for each extra kilobyte of upload budget. */
export const EARN_EVERY_BYTES = 100 * 1024
export const EARNED_BYTES = 1024

export class RunMeter {
  private up = 0
  private down = 0

  /** `budget`: what the run may send before receiving anything (uploadBudget in core). */
  constructor(readonly budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('budget must be a whole number of bytes')
  }

  get bytesUp(): number {
    return this.up
  }

  get bytesDown(): number {
    return this.down
  }

  /** What the run may send in all, given what it has received so far. */
  allowance(): number {
    return this.budget + Math.floor(this.down / EARN_EVERY_BYTES) * EARNED_BYTES
  }

  /** Whether `bytes` more could be sent now. */
  fits(bytes: number): boolean {
    return this.up + bytes <= this.allowance()
  }

  /**
   * Spends `bytes` of the budget, before they are sent. Throws `egress/upload-budget`, spending
   * nothing, when they don't fit: nothing is sent then.
   */
  spend(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ValetError('egress', 'upload-budget')
    if (!this.fits(bytes)) throw new ValetError('egress', 'upload-budget')
    this.up += bytes
  }

  /** Counts bytes received. */
  receive(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes > 0) this.down += bytes
  }
}
