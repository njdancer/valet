import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NEEDS_USER_REASONS } from '../src/errors'
import {
  callRef,
  clockTime,
  GAVE_UP_RESULT,
  HANDOFF_PHRASES,
  handoffPhrase,
  LOCKED_DOWN_RESULT,
  missedTitle,
  needsYouTitle,
  ownCapLabel,
  plainName,
  seeCallSentence,
  siteLimitingLabel,
  sitePausedLabel,
  sitePausedResult,
} from '../src/vocabulary'

const SYDNEY = 'Australia/Sydney'

/** The rows of a Markdown table under `heading` in the IA, as arrays of cell text. */
function iaTable(heading: string): string[][] {
  const doc = readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'docs', 'ux', 'information-architecture.md'),
    'utf8',
  )
  const section = doc.slice(doc.indexOf(heading))
  const lines = section.split('\n').filter((l) => l.startsWith('|'))
  const end = lines.findIndex((l, i) => i > 1 && !l.startsWith('|'))
  return lines.slice(2, end === -1 ? undefined : end).map((l) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim()),
  )
}

describe('callRef', () => {
  it('is the first four hex digits of the call id, uppercased', () => {
    expect(callRef('7f2a91c0-e4b1-4c55')).toBe('7F2A')
    expect(callRef('7f-2a-91')).toBe('7F2A')
    expect(callRef('cf_9a71beef')).toBe('9A71')
    expect(callRef('c_8f2e1b')).toBe('8F2E')
  })

  it('falls back to the id’s first letters and digits, or dashes', () => {
    expect(callRef('call-1')).toBe('CALL')
    expect(callRef('xyz')).toBe('XYZ')
    expect(callRef('')).toBe('----')
  })
})

describe('clockTime', () => {
  it('reads as the person says it', () => {
    expect(clockTime('2026-11-07T10:50:00Z', SYDNEY)).toBe('9:50 pm')
    expect(clockTime(Date.parse('2026-11-06T22:05:00Z'), SYDNEY)).toBe('9:05 am')
    expect(clockTime(new Date('2026-11-07T13:00:00Z'), SYDNEY)).toBe('12:00 am')
    expect(clockTime('2026-11-07T01:30:00Z', SYDNEY)).toBe('12:30 pm')
    expect(clockTime('not a time')).toBe('soon')
    expect(clockTime(Date.now())).toMatch(/^\d{1,2}:\d{2} (am|pm)$/)
  })
})

describe('Needs you titles', () => {
  it('match the IA’s table of item types (section 5)', () => {
    const titles = new Map(iaTable('## 5. Needs you item types').map((row) => [row[0], row[1]]))
    expect(
      needsYouTitle({ kind: 'confirmation', adapterName: 'Woolworths', toolTitle: 'Remove from cart' }),
    ).toBe(titles.get('Confirmation'))
    expect(needsYouTitle({ kind: 'remote-consent' })).toBe(titles.get('Remote connection'))
    expect(needsYouTitle({ kind: 'needs-user', adapterName: 'Woolworths', reason: 'captcha' })).toBe(
      titles.get('Login hand-off'),
    )
    expect(needsYouTitle({ kind: 'review', adapterName: 'Woolworths', version: '0.4.0' })).toBe(
      titles.get('Update review'),
    )
    expect(
      needsYouTitle({ kind: 'review', adapterName: 'Woolworths', version: '0.3.0', firstInstall: true }),
    ).toBe(titles.get('First install'))
    expect(needsYouTitle({ kind: 'setting-missing', adapterName: 'Woolworths', settingTitle: 'Store' })).toBe(
      titles.get('Setting missing'),
    )
    expect(needsYouTitle({ kind: 'login-missing', adapterName: 'Woolworths' })).toBe(
      titles.get('Login missing'),
    )
    expect(needsYouTitle({ kind: 'onepassword-locked' })).toBe(titles.get('1Password locked'))
    expect(needsYouTitle({ kind: 'setup', stepsLeft: 2 })).toBe(titles.get('Setup unfinished'))
    expect(needsYouTitle({ kind: 'repair', adapterName: 'Woolworths' })).toBe(titles.get('Repair ticket'))
    expect(needsYouTitle({ kind: 'audit-broken' }).replace('’', "'")).toBe(titles.get('Audit chain broken'))
    expect(
      missedTitle(
        needsYouTitle({ kind: 'confirmation', adapterName: 'Woolworths', toolTitle: 'Remove from cart' }),
      ),
    ).toBe(titles.get('Missed (any kind)'))
  })

  it('match the IA’s shared vocabulary (section 7)', () => {
    const rows = new Map(iaTable('## 7. Shared vocabulary').map((row) => [row[0], row]))
    expect(rows.get('Login hand-off')?.[1]).toBe(
      needsYouTitle({ kind: 'needs-user', adapterName: 'Woolworths', reason: 'captcha' }),
    )
    expect(rows.get("One-time code Valet can't read")?.[1]).toBe(
      needsYouTitle({ kind: 'needs-user', adapterName: 'Woolworths', reason: 'otp-required' }),
    )
    expect(rows.get('Missing setting')?.[1]).toBe(
      needsYouTitle({ kind: 'setting-missing', adapterName: 'Woolworths', settingTitle: 'Store' }),
    )
    expect(rows.get('Missing login')?.[1]).toBe(
      needsYouTitle({ kind: 'login-missing', adapterName: 'Woolworths' }),
    )
    expect(rows.get('Failure')?.[2]).toBe(seeCallSentence('7f2a0000'))
    expect(rows.get('Locked down')?.[2]).toBe(LOCKED_DOWN_RESULT.replace(/\.$/, ''))
    expect(rows.get('One site paused')?.[2]).toBe(sitePausedResult('Woolworths').replace(/\.$/, ''))
    expect(rows.get('One site paused')?.[1]).toBe(`${sitePausedLabel('Woolworths')} · Resume`)
    expect(rows.get('Login given up / window closed')?.[2]).toBe(GAVE_UP_RESULT.replace(/\.$/, ''))
    expect(rows.get('Site limiting')?.[1]).toBe(
      siteLimitingLabel('Woolworths', '2026-11-07T10:52:00Z', SYDNEY),
    )
    expect(rows.get("Valet's own cap")?.[1]).toBe(ownCapLabel('Woolworths', '2026-11-07T11:00:00Z', SYDNEY))
  })

  it('has a phrase for every hand-off reason', () => {
    for (const reason of NEEDS_USER_REASONS) expect(HANDOFF_PHRASES[reason]).toBeTruthy()
    expect(handoffPhrase('smuggled' as never)).toBe('needs you')
  })

  it('keeps names to one bounded line, and an acronym setting title as it is', () => {
    expect(plainName('Wool\nworths​  Metro')).toBe('Wool worths Metro')
    expect(plainName('x'.repeat(80))).toHaveLength(60)
    expect(needsYouTitle({ kind: 'setting-missing', adapterName: 'Bank', settingTitle: 'PIN pad' })).toBe(
      'Choose your Bank PIN pad',
    )
    expect(needsYouTitle({ kind: 'setup', stepsLeft: 1 })).toBe('Finish setup (1 step left)')
  })
})
