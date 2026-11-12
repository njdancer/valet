// The permission-diff lines for an adapter's sandbox declaration (docs/sandbox.md#the-permission-diff),
// in the app's words, for the approval card (D) and the review screen. Computed by the Mac from the
// old and new manifests; the agent that wrote the adapter never writes these. An exception's
// `purpose` is the author's claim and is shown beside its line, never as it.

import type { PermissionChange } from './permission-change'
import {
  DEFAULT_SANDBOX,
  exceptionKey,
  exceptionRisk,
  type SandboxDeclaration,
  type SandboxException,
  sandboxWidening,
} from './sandbox'

/** One exception as the card says it. */
export function describeException(exception: SandboxException): string {
  switch (exception.kind) {
    case 'files':
      return `${exception.access === 'read' ? 'Read' : 'Read and write'} ${exception.paths.join(', ')}`
    case 'app':
      return `Apple Events to ${exception.bundleId}`
    case 'local-service':
      return `This Mac's service on port ${exception.port}`
    case 'network':
      return `HTTPS from tool code to ${exception.hosts.join(', ')}`
    case 'command':
      return `Run ${exception.path}, which can read your files`
  }
}

/**
 * The sandbox lines between the approved declaration (null for a first install) and the new one:
 * becoming unsandboxed is one critical line; each added exception is a line at its own risk; each
 * removed one, and going back into the sandbox, is low.
 */
export function sandboxPermissionChanges(
  previous: SandboxDeclaration | null,
  next: SandboxDeclaration | undefined,
): PermissionChange[] {
  const before = previous ?? DEFAULT_SANDBOX
  const after = next ?? DEFAULT_SANDBOX
  const changes: PermissionChange[] = []
  const widening = sandboxWidening(before, after)
  if (widening.becameUnsandboxed) {
    changes.push({
      area: 'sandbox-mode',
      change: 'added',
      items: ['Runs without the sandbox'],
      risk: 'critical',
    })
    return changes
  }
  if (before.mode === 'unsandboxed' && after.mode === 'sandboxed')
    changes.push({
      area: 'sandbox-mode',
      change: 'narrowed',
      items: ['Runs in the sandbox again'],
      risk: 'low',
    })
  for (const exception of widening.added)
    changes.push({
      area: 'sandbox-exception',
      change: 'added',
      items: [describeException(exception)],
      risk: exceptionRisk(exception),
    })
  if (before.mode === 'sandboxed' && after.mode === 'sandboxed') {
    const kept = new Set(after.exceptions.map(exceptionKey))
    for (const exception of before.exceptions)
      if (!kept.has(exceptionKey(exception)))
        changes.push({
          area: 'sandbox-exception',
          change: 'removed',
          items: [describeException(exception)],
          risk: 'low',
        })
  }
  return changes
}
