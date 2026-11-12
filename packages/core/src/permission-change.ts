// One line of an adapter's permission diff, as the Mac computes it from the old and new manifests
// (docs/registry-and-sandbox.md#permission-diff-on-install-and-update). Workstream C computes the
// list; approval cards render it. The agent that wrote the adapter never writes these.

import { z } from 'zod'
import { displayText } from './display-text'

/** How a change is shown. `critical` is red and never part of a batch. */
export const riskSchema = z.enum(['low', 'medium', 'high', 'critical'])
export type Risk = z.infer<typeof riskSchema>

export const PERMISSION_AREAS = [
  'navigation',
  'egress',
  'auth-frames',
  'secret',
  'secret-origins',
  'messages-sender',
  'requests',
  'tool',
  'side-effect',
  'session-cookies',
  'session-storage',
  'setting',
  'limits',
  'sandbox-mode',
  'sandbox-exception',
] as const
export type PermissionArea = (typeof PERMISSION_AREAS)[number]

export const manifestPermissionChangeSchema = z
  .object({
    area: z.enum(PERMISSION_AREAS),
    change: z.enum(['added', 'removed', 'widened', 'narrowed']),
    /** What changed, in the app's wording: hosts, origins, paths, tool names. */
    items: z.array(displayText(200)).min(1).max(50),
    risk: riskSchema,
  })
  .strict()
export type PermissionChange = z.infer<typeof manifestPermissionChangeSchema>
