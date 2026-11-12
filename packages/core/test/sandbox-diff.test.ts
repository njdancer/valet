import { describe, expect, it } from 'vitest'
import type { SandboxDeclaration } from '../src/sandbox'
import { describeException, sandboxPermissionChanges } from '../src/sandbox-diff'

const receipts: SandboxDeclaration = {
  mode: 'sandboxed',
  exceptions: [
    { kind: 'files', access: 'read', paths: ['~/Documents/Receipts/**'], purpose: 'Your receipts' },
  ],
}

describe('sandbox permission lines', () => {
  it('has nothing to say about an adapter that declares nothing, before or after', () => {
    expect(sandboxPermissionChanges(null, undefined)).toEqual([])
    expect(sandboxPermissionChanges(receipts, receipts)).toEqual([])
  })

  it('lists each new exception at its own risk, and each removed one as low', () => {
    expect(sandboxPermissionChanges(null, receipts)).toEqual([
      { area: 'sandbox-exception', change: 'added', items: ['Read ~/Documents/Receipts/**'], risk: 'high' },
    ])
    const more: SandboxDeclaration = {
      mode: 'sandboxed',
      exceptions: [
        { kind: 'network', hosts: ['api.example.com'], purpose: 'prices' },
        { kind: 'local-service', port: 11434, purpose: 'a model' },
      ],
    }
    expect(sandboxPermissionChanges(receipts, more)).toEqual([
      {
        area: 'sandbox-exception',
        change: 'added',
        items: ['HTTPS from tool code to api.example.com'],
        risk: 'high',
      },
      {
        area: 'sandbox-exception',
        change: 'added',
        items: ["This Mac's service on port 11434"],
        risk: 'medium',
      },
      { area: 'sandbox-exception', change: 'removed', items: ['Read ~/Documents/Receipts/**'], risk: 'low' },
    ])
  })

  it('says going unsandboxed in one critical line, and coming back in a low one', () => {
    const out: SandboxDeclaration = { mode: 'unsandboxed', reason: 'needs everything' }
    expect(sandboxPermissionChanges(receipts, out)).toEqual([
      { area: 'sandbox-mode', change: 'added', items: ['Runs without the sandbox'], risk: 'critical' },
    ])
    expect(sandboxPermissionChanges(out, out)).toEqual([])
    expect(sandboxPermissionChanges(out, receipts)).toEqual([
      { area: 'sandbox-mode', change: 'narrowed', items: ['Runs in the sandbox again'], risk: 'low' },
      { area: 'sandbox-exception', change: 'added', items: ['Read ~/Documents/Receipts/**'], risk: 'high' },
    ])
  })

  it('words every kind, and says a command can read files', () => {
    expect(
      describeException({ kind: 'files', access: 'read-write', paths: ['~/Documents/Out/*'], purpose: 'p' }),
    ).toBe('Read and write ~/Documents/Out/*')
    expect(describeException({ kind: 'app', bundleId: 'com.apple.reminders', purpose: 'p' })).toBe(
      'Apple Events to com.apple.reminders',
    )
    expect(describeException({ kind: 'command', path: '/usr/bin/sips', purpose: 'p' })).toBe(
      'Run /usr/bin/sips, which can read your files',
    )
  })
})
