// Partition names. Each adapter gets one persistent partition per role, and the two never share
// storage: see docs/security-model.md, "Why pages aren't enough". A draft's live trial
// (docs/authoring-tools.md#live-trials) gets a pair of its own that live in memory only, so a trial
// never sees, or leaves anything in, the installed adapter's session.

import { ValetError } from '@valet/core'
import type { Role } from './platform'

// The manifest's id rule, checked again here because the id becomes part of an on-disk path.
const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/
/** A trial's label: the app's own `<draftId>-<n>`. */
const TRIAL_LABEL = /^[a-z0-9][a-z0-9-]{0,79}$/

export function partitionName(role: Role, adapterId: string): string {
  if (!ADAPTER_ID.test(adapterId)) throw new ValetError('manifest', 'invalid')
  return `persist:${role}:${adapterId}`
}

/** An in-memory partition (no `persist:` prefix) for one trial: nothing in it outlives the app. */
export function trialPartitionName(role: Role, label: string): string {
  if (!TRIAL_LABEL.test(label)) throw new ValetError('config', 'invalid')
  return `trial:${role}:${label}`
}
