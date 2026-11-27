// The site's health line with a hold on its automatic logins (issue #32).

import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { siteStatus } from '../src/renderer/lib/site-status'
import type { AdapterSummary } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

async function woolworths(patch: Partial<AdapterSummary>): Promise<AdapterSummary> {
  const base = (await createFakeApi({ now: NOW }).adapters.list()).find((a) => a.id === 'woolworths')
  if (base === undefined) throw new Error('no woolworths in the fake')
  return {
    ...base,
    approval: 'approved',
    pendingUpdate: null,
    session: { state: 'expired', checkedAt: null, needsUser: null, since: null },
    ...patch,
  }
}

describe('a site whose automatic logins are held', () => {
  it('never reads Ready, and offers to let Valet log in again', async () => {
    const status = siteStatus(await woolworths({ loginHold: { until: null, reason: 'site-changed' } }), null)
    expect(status).toEqual({
      tone: 'warning',
      text: 'Valet stopped logging in to Woolworths (site changed) · it won’t try again by itself',
      fix: 'retry-login',
    })
  })

  it('says when a backoff ends, with or without a reason', async () => {
    const until = '2026-11-07T11:00:00.000Z'
    expect(siteStatus(await woolworths({ loginHold: { until, reason: 'otp-required' } }), null).text).toMatch(
      /^Valet’s last login to Woolworths didn’t work \(one-time code\) · it tries again at /,
    )
    expect(siteStatus(await woolworths({ loginHold: { until, reason: null } }), null).text).toMatch(
      /^Valet’s last login to Woolworths didn’t work · it tries again at /,
    )
  })

  it('leads with an update waiting for review: approving it is the fix', async () => {
    const adapter = await woolworths({
      loginHold: { until: null, reason: 'site-changed' },
      pendingUpdate: { version: '0.5.2' } as AdapterSummary['pendingUpdate'],
    })
    expect(siteStatus(adapter, null)).toMatchObject({ fix: 'review-update', text: /update 0\.5\.2 waiting/ })
  })

  it('keeps the login window first when the site is waiting for the person', async () => {
    const adapter = await woolworths({
      loginHold: { until: null, reason: 'captcha' },
      session: { state: 'needs-user', checkedAt: null, needsUser: 'captcha', since: null },
    })
    expect(siteStatus(adapter, null).fix).toBe('show-login')
  })
})
