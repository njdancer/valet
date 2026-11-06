// The fixed vocabularies, with no Node imports, so a browser bundle (the desktop renderer) can
// import values as well as types: import { STAGES } from '@siteadapter/core/vocab'.

export { MESSAGES_SECRET } from './credentials'
export {
  ERROR_CLASSES,
  type ErrorClass,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  STAGES,
  type Stage,
} from './errors'

/** Why the driver refused a tool-partition request; mirrors BlockedRequest['reason'] in page.ts. */
export const BLOCK_REASONS = [
  'host-not-allowed',
  'undeclared',
  'denied-path',
  'ambiguous-path',
  'purpose-exceeded',
  'request-ceiling',
  'bad-url',
] as const
