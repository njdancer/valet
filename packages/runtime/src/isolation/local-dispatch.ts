// Answers a `local.*` capability call from the ToolContext's `local` (docs/sandbox.md). The
// arguments are whatever tool code sent, unchecked: the LocalAccess implementation checks each one
// against its declared exceptions. No `local` at all (a context without exceptions wired) refuses
// every call as not-granted, as an undeclared kind would be.

import { type LocalAccess, ValetError } from '@valet/core'

export function dispatchLocal(
  local: LocalAccess | undefined,
  capability: string,
  args: readonly unknown[],
): Promise<unknown> {
  if (local === undefined) return Promise.reject(new ValetError('tool-run', 'not-granted'))
  const [a, b, c] = args as [never, never, never]
  switch (capability) {
    case 'local.files.list':
      return local.files.list(a)
    case 'local.files.stat':
      return local.files.stat(a)
    case 'local.files.read':
      return local.files.read(a, b)
    case 'local.files.write':
      return local.files.write(a, b, c)
    case 'local.files.mkdir':
      return local.files.mkdir(a)
    case 'local.fetch':
      return local.fetch(a, b)
    case 'local.service':
      return local.service(a, b, c)
    case 'local.run':
      return local.run(a, b)
    case 'local.appleScript':
      return local.appleScript(a, b)
    default:
      return Promise.reject(new ValetError('tool-run', 'invalid'))
  }
}
