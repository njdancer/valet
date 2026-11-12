// Words the approval broker puts in front of the person outside the card itself: the reason in the
// OS's Touch ID prompt, and the short reference that ties that prompt to the card on screen.
//
// Only fixed wording and facts the Mac derived itself go here: the request's digest, the hosts in
// the Mac's own permission diff, whether code runs unsandboxed, a tool's identifier (a strict
// pattern) and where it is turned on. An adapter's display name, a tool title and the agent's note
// are written by someone else and may say anything, so none of them is ever in a prompt the OS
// draws. The prompt is the one surface a compromised renderer can't draw, so it names the facts
// that matter most (docs/approval-broker.md#approving-at-the-mac).

import type { ApprovalKind, SerializedRequest } from '@valet/core'

/** macOS shows the reason after "Valet is trying to", so each starts with a verb. */
const ACTIONS: Readonly<Record<ApprovalKind, string>> = {
  'adapter-install': 'approve an adapter',
  'secret-grant': 'let an adapter use your login',
  'tool-enable': 'turn on a tool',
  'remote-client': 'let a remote agent connect',
  setting: 'change a setting',
  'authoring-session': 'let an agent use a signed-in session',
  'private-network': "let an agent's scratch browser reach your home network",
  'irreversible-call': "confirm something that can't be undone",
  resume: 'resume Valet',
  'device-pair': 'pair a new device',
}

/** Four characters of the request's digest, as the card's kind strip shows it ("7B3F"). */
export function requestRef(request: SerializedRequest): string {
  return request.digest.slice(0, 4).toUpperCase()
}

export function promptReason(request: SerializedRequest): string {
  return `${ACTIONS[request.request.kind]}${detail(request)} (request ${requestRef(request)})`
}

function detail(serialized: SerializedRequest): string {
  const request = serialized.request
  switch (request.kind) {
    case 'adapter-install': {
      if (request.subject.unsandboxed) return ' that runs without the sandbox'
      const host = request.subject.changes
        .filter((c) => (c.area === 'navigation' || c.area === 'egress') && c.change !== 'removed')
        .flatMap((c) => c.items)
        .map(hostOf)
        .find((h) => h !== null)
      return host === undefined ? '' : ` that reaches ${host}`
    }
    case 'tool-enable':
      return ` (${request.subject.tool}, ${request.subject.scope === 'remote' ? 'for remote use' : 'on this Mac'})`
    case 'private-network': {
      const { address, port } = request.subject
      return ` (${address}${port === null ? '' : ` port ${port}`})`
    }
    case 'secret-grant':
      return ` on ${request.subject.origins
        .map(hostOf)
        .filter((h) => h !== null)
        .join(', ')}`
    default:
      return ''
  }
}

/** The host of an origin or URL the Mac's diff lists; null for anything else. */
function hostOf(item: string): string | null {
  try {
    const url = new URL(item)
    return url.protocol === 'https:' ? url.host : null
  } catch {
    return /^[a-z0-9.-]{1,253}$/.test(item) ? item : null
  }
}
