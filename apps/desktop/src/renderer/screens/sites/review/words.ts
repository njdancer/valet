// The review page's fixed wording. Adapter-supplied text (a secret's description, a tool's title) is
// shown only as plain text, quoted, capped and attributed; everything else here is the app's own.

import type { AuthStepEntry, PendingReview } from '../../../../shared/api'

/** Why an added login step matters, by op. The step's detail is the runtime's rendering of the manifest. */
const STEP_WHY: Readonly<Record<AuthStepEntry['op'], string>> = {
  goto: 'The login opens this page.',
  waitFor: 'The login waits for this before going on.',
  click: 'The login clicks this. A click can accept terms or confirm something on the site.',
  fill: 'The login types into this field.',
  otp: 'The login types a one-time code here.',
  pause: 'The login pauses here.',
  when: 'The login branches on this.',
  retry: 'The login repeats these steps.',
  assertLoggedIn: 'The login checks that it worked before handing the session over.',
  needsUser: 'The login stops here and hands over to you.',
  fail: 'The login gives up here.',
}

export function stepWhy(op: string): string {
  return Object.hasOwn(STEP_WHY, op) ? STEP_WHY[op as AuthStepEntry['op']] : 'A login step.'
}

export const SOURCE_WORDING: Readonly<Record<PendingReview['source'], string>> = {
  import: 'Imported',
  ide: 'Made in the IDE',
  'authoring-agent': 'Made by the authoring agent (IDE)',
}

/** The longest adapter-supplied string shown anywhere, so a manifest can't fill the screen. */
const MAX_ADAPTER_TEXT = 280

export function capText(text: string, max = MAX_ADAPTER_TEXT): string {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export const PURPOSE_WORDING = { read: 'Reads', write: 'Changes', irreversible: 'Can’t be undone' } as const

/** The heading over each purpose's new request declarations. */
export const REQUEST_GROUP: Readonly<Record<'read' | 'write' | 'irreversible', string>> = {
  irreversible: 'New irreversible requests: each asks you first',
  write: 'New write requests: change your account',
  read: 'New read requests',
}
