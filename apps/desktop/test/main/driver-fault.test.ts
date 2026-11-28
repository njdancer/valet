import { faulted, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { callFault, diagnosticLines, safeMessage } from '../../src/main/core/driver-fault'

describe('safeMessage', () => {
  it('keeps the browser’s own fixed wording', () => {
    expect(safeMessage('Render frame was disposed before WebFrameMain could be accessed')).toBe(
      'Render frame was disposed before WebFrameMain could be accessed',
    )
    expect(safeMessage('No target with given id found')).toBe('No target with given id found')
  })

  it('drops anything that could carry an address, a path, a quote or a value', () => {
    for (const message of [
      'Failed to load https://www.woolworths.com.au/shop',
      'ENOENT: no such file, open /Users/nick/x',
      'Unexpected token "secret-value"',
      'token abc123def456',
      'x'.repeat(200),
      '',
      'line one\nline two',
    ]) {
      expect(safeMessage(message)).toBeNull()
    }
    expect(safeMessage(42)).toBeNull()
  })
})

describe('callFault', () => {
  it('names the driver’s step and what it really threw', () => {
    const cause = new TypeError('Object has been destroyed')
    expect(callFault('tool-page', faulted('egress', 'internal', 'tool-storage-watch', cause))).toEqual({
      step: 'tool-page',
      at: 'tool-storage-watch',
      error: 'TypeError',
      message: 'Object has been destroyed',
    })
  })

  it('reads a plain error or a ValetError without a fault as itself', () => {
    expect(callFault('begin-run', new Error('see https://x.test/'))).toEqual({
      step: 'begin-run',
      at: null,
      error: 'Error',
      message: null,
    })
    expect(callFault('tool-page', new ValetError('egress', 'internal'))).toMatchObject({
      error: 'ValetError',
      message: 'egress: internal',
    })
    expect(callFault('Bad Step!', 'a string')).toEqual({
      step: 'unknown',
      at: null,
      error: 'string',
      message: null,
    })
  })
})

describe('diagnosticLines', () => {
  it('logs a driver failure with its step, the cause’s name and safe message, and its frames', () => {
    const cause = new Error('No target with given id found')
    const lines = diagnosticLines({
      type: 'driver-failed',
      adapterId: 'woolworths',
      callId: 'c1',
      step: 'tool-page',
      error: faulted('egress', 'internal', 'tool-user-agent', cause),
    })
    expect(lines[0]).toBe(
      'diagnostic: driver-failed woolworths (tool-page at tool-user-agent): Error: No target with given id found',
    )
    expect(lines.slice(1).every((line) => line.startsWith('    at '))).toBe(true)
    expect(lines.length).toBeGreaterThan(1)
  })

  it('logs a dead page by adapter, role, reason and exit code', () => {
    expect(
      diagnosticLines({
        type: 'browser',
        adapterId: 'woolworths',
        diagnostic: { type: 'renderer-gone', role: 'tool', reason: 'crashed', exitCode: 5 },
      }),
    ).toEqual(['diagnostic: woolworths tool page renderer gone (crashed, exit 5); its window was closed'])
  })

  it('logs a failed set-up step, never an unsafe message', () => {
    const [head] = diagnosticLines({
      type: 'browser',
      adapterId: 'woolworths',
      diagnostic: {
        type: 'setup-failed',
        role: 'tool',
        step: 'partition',
        error: new Error('cannot reach https://secret.test/?t=abc'),
      },
    })
    expect(head).toBe('diagnostic: woolworths tool set-up failed (partition): Error')
  })

  it('keeps unknown words out of driver lines, and logs other diagnostics as they are', () => {
    expect(diagnosticLines({ type: 'audit-write-failed', event: 'tool-finished' } as never)).toEqual([
      'diagnostic: audit-write-failed',
    ])
    // The app's own lines that travel as a diagnostic's type are logged as they always were.
    expect(diagnosticLines({ type: '[blind relay] online' })).toEqual(['diagnostic: [blind relay] online'])
    expect(diagnosticLines({ type: '[phone door] 1a2b3c4d connected' })).toEqual([
      'diagnostic: [phone door] 1a2b3c4d connected',
    ])
    expect(diagnosticLines({ type: 'browser', adapterId: '../x y', diagnostic: null })).toEqual([
      'diagnostic: unknown browser unknown',
    ])
    expect(
      diagnosticLines({
        type: 'browser',
        adapterId: 'shop',
        diagnostic: { type: 'renderer-gone', role: 'tool', reason: 'crashed\n', exitCode: 1.5 },
      }),
    ).toEqual(['diagnostic: shop tool page renderer gone (unknown, exit unknown); its window was closed'])
  })
})
