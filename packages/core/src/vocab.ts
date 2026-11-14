// The fixed vocabularies, with no Node imports, so a browser bundle (the desktop renderer) can
// import values as well as types: import { STAGES } from '@valet/core/vocab'.

export { MESSAGES_SECRET } from './credentials'
export {
  ERROR_CLASSES,
  type ErrorClass,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  STAGES,
  type Stage,
} from './errors'

/** Why the driver refused a request, in either partition; BlockedRequest['reason'] in page.ts. */
export const BLOCK_REASONS = [
  'host-not-allowed',
  'undeclared',
  'denied-path',
  'ambiguous-path',
  'purpose-exceeded',
  'request-ceiling',
  'bad-url',
  /** The page tool code ran in refused it: its own Content-Security-Policy, not ours. */
  'page-policy',
] as const
