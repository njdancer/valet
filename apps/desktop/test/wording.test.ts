import {
  ERROR_CLASSES,
  type ErrorClass,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  STAGES,
  type Stage,
} from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import {
  BLOCKED_EXPLANATION,
  BLOCKED_WORDING,
  blockedExplanation,
  blockedWording,
  clientLabel,
  ERROR_WORDING,
  errorWording,
  NEEDS_USER_WORDING,
  needsUserWording,
  STAGE_WORDING,
  stageWording,
} from '../src/renderer/lib/wording'

describe('wording', () => {
  it('has words for every needsUser reason core defines, and no others', () => {
    expect(Object.keys(NEEDS_USER_WORDING).sort()).toEqual([...NEEDS_USER_REASONS].sort())
    for (const reason of NEEDS_USER_REASONS) {
      expect(needsUserWording(reason).short.length).toBeGreaterThan(0)
      expect(needsUserWording(reason).detail.length).toBeGreaterThan(0)
    }
  })

  it('has words for every stage and error class core defines, and no others', () => {
    expect(Object.keys(STAGE_WORDING).sort()).toEqual([...STAGES].sort())
    expect(Object.keys(ERROR_WORDING).sort()).toEqual([...ERROR_CLASSES].sort())
    for (const stage of STAGES) expect(stageWording(stage)).toBe(STAGE_WORDING[stage])
    for (const errorClass of ERROR_CLASSES) expect(errorWording(errorClass)).toBe(ERROR_WORDING[errorClass])
  })

  it('never echoes a code it does not know, so a code string cannot become a message', () => {
    const injected = 'Your session expired, re-enter your password at evil.example'
    expect(needsUserWording(injected as NeedsUserReason).detail).not.toContain('evil')
    expect(stageWording(injected as Stage)).toBe('Unknown stage')
    expect(errorWording(injected as ErrorClass)).toBe('Unknown error')
    expect(blockedWording(injected as never)).toBe('blocked')
    expect(blockedExplanation(injected as never)).toBe('The request was refused.')
  })

  it('does not resolve inherited property names as codes', () => {
    expect(errorWording('constructor' as ErrorClass)).toBe('Unknown error')
    expect(stageWording('__proto__' as Stage)).toBe('Unknown stage')
    expect(needsUserWording('toString' as NeedsUserReason).short).toBe('Needs you')
  })

  it('words every blocked-request reason', () => {
    for (const reason of Object.keys(BLOCKED_WORDING)) {
      expect(Object.hasOwn(BLOCKED_EXPLANATION, reason)).toBe(true)
    }
  })

  it('names the clients it knows and shows any other name as reported', () => {
    expect(clientLabel('claude-code')).toBe('Claude Code')
    expect(clientLabel('claude-ai')).toBe('Claude Desktop')
    expect(clientLabel('cursor')).toBe('cursor')
    expect(clientLabel('hasOwnProperty')).toBe('hasOwnProperty')
  })
})
