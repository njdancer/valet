// @vitest-environment node
// What a confirmation's signed request shows on the phone, and for a raw adapter's call
// (docs/adapter-kinds.md#raw-confirmation) whether that is the whole input: when it isn't, only the
// Mac, which shows all of it, may approve (core's approvableOn).

import { describe, expect, it } from 'vitest'
import { confirmationPreview } from '../../src/main/core/service'
import type { ConfirmationItem } from '../../src/shared/api'

const BASE: ConfirmationItem = {
  kind: 'confirmation',
  id: 'cf_1',
  adapterId: 'nas',
  adapterName: 'NAS',
  adapterVersion: '1.0.0',
  adapterHash: 'a'.repeat(64),
  approvedAt: null,
  tool: 'remove',
  toolTitle: 'Remove',
  sideEffect: 'irreversible',
  trigger: 'raw-tool',
  client: 'Claude Code',
  clientTransport: 'http',
  callId: 'call_1',
  requestedAt: '2026-11-18T00:00:00.000Z',
  expiresAt: '2026-11-18T00:02:00.000Z',
  requestCeiling: 5,
  unlocks: [],
  requests: [],
  input: [{ kind: 'text', text: '{\n  "path": "/photos/2024"\n}' }],
  adapterNote: null,
  raw: {
    endpoints: ['nas.example.com:443', '192.168.1.20:8123'],
    credentials: ['token'],
    readFolders: [],
    writeFolders: [],
  },
  ref: null,
}

const raw = (input: ConfirmationItem['input']) => confirmationPreview({ ...BASE, input }).raw

describe('confirmationPreview: a raw adapter’s call', () => {
  it('carries the reach, and says the input is whole when every line is shown as it is', () => {
    expect(confirmationPreview(BASE)).toEqual({
      preview: ['{', '"path": "/photos/2024"', '}'],
      raw: {
        endpoints: ['nas.example.com:443', '192.168.1.20:8123'],
        credentials: ['token'],
        readFolders: [],
        writeFolders: [],
        inputComplete: true,
      },
    })
  })

  it('says it isn’t whole when a line is cut', () => {
    expect(raw([{ kind: 'text', text: `"${'x'.repeat(250)}"` }])?.inputComplete).toBe(false)
    expect(raw([{ kind: 'text', text: `"${'x'.repeat(190)}"` }])?.inputComplete).toBe(true)
  })

  it('says it isn’t whole past 20 lines, and the last line says how many more there are', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    const preview = confirmationPreview({ ...BASE, input: [{ kind: 'text', text: lines }] })
    expect(preview.raw?.inputComplete).toBe(false)
    expect(preview.preview).toHaveLength(20)
    expect(preview.preview.at(-1)).toBe('and 6 more lines not shown')
    const twenty = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(raw([{ kind: 'text', text: twenty }])?.inputComplete).toBe(true)
  })

  it('says it isn’t whole when a line can only be shown changed: an invisible character, spaces run together', () => {
    expect(raw([{ kind: 'text', text: '"/photos​/2024"' }])?.inputComplete).toBe(false)
    expect(raw([{ kind: 'text', text: '"rm  -r"' }])?.inputComplete).toBe(false)
    expect(raw([{ kind: 'text', text: '"a\tb"' }])?.inputComplete).toBe(false)
  })

  it('counts a redacted secret as shown: its label stands for a value the person can’t be shown anyway', () => {
    expect(
      raw([
        { kind: 'text', text: '{ "token": ' },
        { kind: 'redacted', label: 'secret', ref: null },
        { kind: 'text', text: ' }' },
      ])?.inputComplete,
    ).toBe(true)
  })

  it('refuses to make the request without the reach: it would read as an ordinary confirmation', () => {
    expect(() => confirmationPreview({ ...BASE, raw: null })).toThrow()
    expect(() =>
      confirmationPreview({
        ...BASE,
        raw: { endpoints: [], credentials: [], readFolders: [], writeFolders: [] },
      }),
    ).toThrow()
  })

  it('adds nothing for any other confirmation', () => {
    expect(confirmationPreview({ ...BASE, trigger: 'irreversible-tool', raw: null })).toEqual({
      preview: ['{', '"path": "/photos/2024"', '}'],
    })
  })
})
