import { describe, expect, it } from 'vitest'
import { SiteAdapterError, toReportable } from '../src/errors'

describe('toReportable', () => {
  it('passes a SiteAdapterError through as stage and class', () => {
    expect(toReportable(new SiteAdapterError('secret-fill', 'origin-mismatch'), 'tool-run')).toEqual({
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
  })

  it('collapses any other error to internal at the fallback stage, dropping its message', () => {
    const reported = toReportable(new Error('password hunter2 rejected'), 'tool-run')
    expect(reported).toEqual({ stage: 'tool-run', errorClass: 'internal' })
    expect(JSON.stringify(reported)).not.toContain('hunter2')
  })

  it('handles thrown non-errors', () => {
    expect(toReportable('boom', 'navigate')).toEqual({ stage: 'navigate', errorClass: 'internal' })
  })
})

describe('SiteAdapterError', () => {
  it('has a message made only of its vocabulary', () => {
    const error = new SiteAdapterError('auth-step', 'condition-timeout')
    expect(error.message).toBe('auth-step: condition-timeout')
    expect(error.name).toBe('SiteAdapterError')
  })
})
