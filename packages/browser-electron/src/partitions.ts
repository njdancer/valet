// Partition names. Each adapter gets one persistent partition per role, and the two never share
// storage: see docs/security-model.md, "Why pages aren't enough".

import { ValetError } from '@valet/core'
import type { Role } from './platform'

// The manifest's id rule, checked again here because the id becomes part of an on-disk path.
const ADAPTER_ID = /^[a-z][a-z0-9-]{1,63}$/

export function partitionName(role: Role, adapterId: string): string {
  if (!ADAPTER_ID.test(adapterId)) throw new ValetError('manifest', 'invalid')
  return `persist:${role}:${adapterId}`
}
