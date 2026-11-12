import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { failedResult, type ResultContext, toolResult } from '../src/results'

/** Saturday 7 November 2026, 9:48 pm in Sydney: the wireframes' moment. */
const NOW = Date.parse('2026-11-07T10:48:00Z')

const context: ResultContext = {
  callId: '7f2a91c0e4',
  adapterName: 'Woolworths',
  toolTitle: 'Remove from cart',
  timeZone: 'Australia/Sydney',
  now: () => NOW,
}

function text(result: CallToolResult): string {
  return (result.content as { text: string }[]).map((c) => c.text).join('\n')
}

describe('tool results in the app’s words (IA section 7)', () => {
  it('tells a decline from a confirmation nobody answered, with the call’s ref', () => {
    const declined = toolResult({ status: 'declined' }, false, context)
    expect(declined.isError).toBe(true)
    expect(text(declined)).toBe(
      'The person did not approve this action in the Valet app (stage confirm: declined). ' +
        'The person can see it in Valet, Activity, call 7F2A.',
    )
    const missed = toolResult({ status: 'declined', timedOut: true }, false, context)
    expect(missed.isError).toBe(true)
    expect(text(missed)).toBe(
      'Nobody answered the confirmation in the Valet app in time, so this action was not done and ' +
        'nothing was sent (stage confirm: timed-out). Valet lists it under Needs you as ' +
        '"Missed: Confirm: Remove from cart (Woolworths)". The person can see it in Valet, Activity, call 7F2A.',
    )
    expect(text(toolResult({ status: 'declined', timedOut: true }, false))).toBe(
      'Nobody answered the confirmation in the Valet app in time, so this action was not done and ' +
        'nothing was sent (stage confirm: timed-out).',
    )
  })

  it('never says the person was asked when a login hold has nothing open for them', () => {
    const waiting = toolResult(
      {
        status: 'needsUser',
        reason: 'login-required',
        needsYou: { kind: 'login-waiting', retryAt: '2026-11-07T10:53:00Z' },
      },
      false,
      context,
    )
    expect(waiting.isError).toBeUndefined()
    expect(text(waiting)).toBe(
      "Not done yet: Valet's last login to this site didn't work, so it is waiting before it tries again, " +
        'and this call sent nothing (reason: login-required). Nobody has been asked to act. ' +
        'Call this tool again after 9:53 pm.',
    )
    expect(text(waiting)).not.toContain('person has been asked')
    const stopped = toolResult(
      { status: 'needsUser', reason: 'captcha', needsYou: { kind: 'login-stopped' } },
      true,
    )
    expect(stopped.isError).toBe(true)
    expect(text(stopped)).toBe(
      'Not done yet: Valet has stopped logging in to this site by itself until the person signs in from ' +
        'the Valet app, and this call sent nothing (reason: captcha). Nothing in the app is asking them yet: ' +
        'tell them, and call this tool again once they have.',
    )
  })

  it('names the login hand-off’s Needs you item and when its window closes', () => {
    const result = toolResult(
      { status: 'needsUser', reason: 'captcha', needsYou: { kind: 'login', until: '2026-11-07T11:03:00Z' } },
      false,
      context,
    )
    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe(
      'Not done yet: the person has been asked to act in the Valet app (reason: captcha). Open Valet, ' +
        'Needs you, "Log in to Woolworths (verification check)", open until 10:03 pm. ' +
        'Call this tool again once they have.',
    )
    expect(
      text(
        toolResult(
          { status: 'needsUser', reason: 'otp-required', needsYou: { kind: 'login', until: null } },
          true,
          context,
        ),
      ),
    ).toContain('"Log in to Woolworths (one-time code)". Call')
  })

  it('says when the person closed the login without finishing', () => {
    expect(
      text(
        toolResult({ status: 'needsUser', reason: 'login-required', needsYou: { kind: 'gave-up' } }, false),
      ),
    ).toBe('The person closed the login without finishing (needs-user: gave-up); nothing was sent.')
  })

  it('names a missing setting and a missing login as the app does', () => {
    expect(
      text(
        toolResult(
          {
            status: 'needsUser',
            reason: 'setting-required',
            needsYou: { kind: 'setting-missing', settingTitle: 'Store' },
          },
          false,
          context,
        ),
      ),
    ).toContain('(reason: setting-required). Valet, Needs you, "Choose your Woolworths store".')
    expect(
      text(
        toolResult(
          { status: 'needsUser', reason: 'login-required', needsYou: { kind: 'login-missing' } },
          false,
          context,
        ),
      ),
    ).toContain('"Give Valet your Woolworths login"')
    const failed = toolResult(
      {
        status: 'failed',
        stage: 'secret-fill',
        errorClass: 'not-granted',
        needsYou: { kind: 'login-missing' },
      },
      false,
      context,
    )
    expect(failed.isError).toBe(true)
    expect(text(failed)).toBe(
      'Not done yet: Valet has no login for this site, so nothing was sent (stage secret-fill: not-granted). ' +
        'The person can give it one in Valet, Needs you, "Give Valet your Woolworths login". ' +
        'Call this tool again once they have.',
    )
    // Without the site's name, the codes alone.
    expect(
      text(
        toolResult(
          {
            status: 'failed',
            stage: 'secret-fill',
            errorClass: 'not-granted',
            needsYou: { kind: 'login-missing' },
          },
          false,
        ),
      ),
    ).toBe('The tool failed at stage secret-fill: not-granted.')
    expect(
      text(
        toolResult(
          { status: 'needsUser', reason: 'login-required', needsYou: { kind: 'login-missing' } },
          false,
        ),
      ),
    ).toContain('(reason: login-required). Call this tool again')
  })

  it('tells paused, one site paused and locked down apart', () => {
    expect(text(failedResult('config', 'unavailable', context))).toBe(
      'Valet is paused, so this call was not started and nothing was sent (stage config: unavailable); ' +
        'the person can resume from the menu bar or the Valet window.',
    )
    expect(text(failedResult('config', 'site-paused', context))).toBe(
      'Woolworths is paused in Valet, so this call was not started and nothing was sent ' +
        '(config: site-paused); ask the person to resume Woolworths in Valet.',
    )
    expect(text(failedResult('config', 'site-paused'))).toContain('This site is paused in Valet')
    expect(text(failedResult('config', 'locked-down', context))).toBe(
      'Valet is locked down by the person, so this call was refused and nothing was sent ' +
        '(config: locked-down). The endpoint stays up so agents get this text; cloud agents were removed.',
    )
  })

  it('gives the call’s ref on a guard’s refusal', () => {
    expect(
      text(
        toolResult(
          { status: 'blocked', stage: 'request-surface', errorClass: 'denied-path', retryAfterMs: 1 },
          false,
          context,
        ),
      ),
    ).toBe(
      'The tool failed at stage request-surface: denied-path. The person can see it in Valet, Activity, call 7F2A.',
    )
  })
})
