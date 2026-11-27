// @vitest-environment node
// The page a login stopped on, as the call trace keeps it: no query, no field values, no secrets.

import { SecretValue } from '@valet/core'
import { SecretRedactionSet } from '@valet/runtime'
import { describe, expect, it } from 'vitest'
import {
  cleanStallSnapshot,
  loginStall,
  STALL_REDACTED_LINE,
  STALL_SNAPSHOT_CHARS,
  stallUrl,
} from '../../src/main/core/login-stall'

const none = () => false

describe('stallUrl', () => {
  it('keeps the origin and path only', () => {
    expect(stallUrl('https://auth.shop.test/u/login/password?state=abc&ui=1#frag')).toBe(
      'https://auth.shop.test/u/login/password',
    )
    expect(stallUrl('not a url')).toBe('')
  })
})

describe('cleanStallSnapshot', () => {
  it('drops every field’s value and keeps the rest', () => {
    const yaml = [
      '- form:',
      '  - textbox "Email address" [ref=e3]: person@example.com',
      '  - textbox "Password" [ref=e4]',
      '  - searchbox "Search": milk',
      '  - combobox "Country" [expanded=false]: Australia',
      '  - spinbutton "Qty": "2"',
      '  - text: "Enter the code: we sent it to ***123"',
      '  - button "Continue" [ref=e5]',
    ].join('\n')
    expect(cleanStallSnapshot(yaml, none)).toEqual({
      snapshot: [
        '- form:',
        '  - textbox "Email address" [ref=e3]',
        '  - textbox "Password" [ref=e4]',
        '  - searchbox "Search"',
        '  - combobox "Country" [expanded=false]',
        '  - spinbutton "Qty"',
        '  - text: "Enter the code: we sent it to ***123"',
        '  - button "Continue" [ref=e5]',
      ].join('\n'),
      cut: false,
    })
  })

  it('replaces a line holding a login secret in any form the redaction knows', () => {
    const set = new SecretRedactionSet()
    const secret = SecretValue.fromString('person@example.com')
    set.register(secret)
    secret.dispose()
    const yaml = [
      '- heading "Welcome back" [level=1]',
      '  - text: Signed in as person@example.com',
      '  - link "Not you? person%40example.com" [ref=e9]',
    ].join('\n')
    const out = cleanStallSnapshot(yaml, (text) => set.occursIn(text))
    expect(out.snapshot).toBe(
      ['- heading "Welcome back" [level=1]', `  - ${STALL_REDACTED_LINE}`, `  - ${STALL_REDACTED_LINE}`].join(
        '\n',
      ),
    )
    expect(out.snapshot).not.toContain('person')
    set.dispose()
  })

  it('cuts a long snapshot at a line', () => {
    const line = `- text: ${'x'.repeat(90)}`
    const yaml = Array.from({ length: 400 }, () => line).join('\n')
    const out = cleanStallSnapshot(yaml, none)
    expect(out.cut).toBe(true)
    expect(out.snapshot.length).toBeLessThanOrEqual(STALL_SNAPSHOT_CHARS)
    expect(out.snapshot.endsWith(line)).toBe(true)
  })
})

describe('loginStall', () => {
  const at = new Date('2026-11-27T10:00:00Z')

  it('says the page couldn’t be read', () => {
    expect(loginStall(at, 'failed', 'auth-step/element-missing', null, none)).toEqual({
      at: '2026-11-27T10:00:00.000Z',
      outcome: 'failed',
      reason: 'auth-step/element-missing',
      page: null,
    })
  })

  it('withholds a title or URL that holds a secret', () => {
    const holds = (text: string) => text.includes('person')
    const stall = loginStall(
      at,
      'needsUser',
      'site-changed',
      { url: 'https://auth.shop.test/u/person/x', title: 'Hi person', snapshot: '- text: ok' },
      holds,
    )
    expect(stall.page).toEqual({ url: '', title: STALL_REDACTED_LINE, snapshot: '- text: ok', cut: false })
  })
})
