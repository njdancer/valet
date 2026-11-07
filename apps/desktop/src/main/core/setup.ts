// setup.json: whether the person has finished (or skipped) first-run setup, so that later launches
// stop opening it. Nothing else lives here: each step's own state is the providers, the approval,
// the grant and the clients, which the setup screen reads from the API like every other screen.
//
// A file that doesn't validate reads as not finished: setup opens again, shows every step it finds
// already done, and finishing it writes a good file. Nothing is lost either way.

import { z } from 'zod'
import type { SetupStatus } from '../../shared/api'
import { JsonDocument } from './files'

const setupSchema = z.object({ completedAt: z.iso.datetime({ offset: true }).nullable() }).strict()

export class SetupStore {
  private readonly document: JsonDocument<SetupStatus>

  constructor(
    path: string,
    private readonly now: () => number,
  ) {
    this.document = new JsonDocument<SetupStatus>(path, setupSchema, () => ({ completedAt: null }), true)
  }

  status(): Promise<SetupStatus> {
    return this.document.read()
  }

  /** Keeps the first completion time: finishing again (setup opened from the control panel) changes nothing. */
  finish(): Promise<SetupStatus> {
    return this.document.update((current) =>
      current.completedAt !== null ? current : { completedAt: new Date(this.now()).toISOString() },
    )
  }
}
