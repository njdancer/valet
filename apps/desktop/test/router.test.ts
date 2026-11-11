import { describe, expect, it } from 'vitest'
import { href, parseRoute } from '../src/renderer/lib/router'
import { panelOnlyRoute } from '../src/renderer/lib/routes'

describe('parseRoute', () => {
  it('parses every route the main process may open', () => {
    expect(parseRoute('')).toEqual({ page: 'adapters' })
    expect(parseRoute('#/adapters')).toEqual({ page: 'adapters' })
    expect(parseRoute('#/adapters/woolworths')).toEqual({ page: 'adapter', adapterId: 'woolworths' })
    expect(parseRoute('#/adapters/woolworths/review')).toEqual({ page: 'review', adapterId: 'woolworths' })
    expect(parseRoute('#/adapters/woolworths/grant/login')).toEqual({
      page: 'grant',
      adapterId: 'woolworths',
      secret: 'login',
    })
    expect(parseRoute('#/activity')).toEqual({ page: 'activity', callId: null })
    expect(parseRoute('#/activity/c_8f2e1b')).toEqual({ page: 'activity', callId: 'c_8f2e1b' })
    expect(parseRoute('#/audit')).toEqual({ page: 'audit' })
    expect(parseRoute('#/credentials')).toEqual({ page: 'credentials' })
    expect(parseRoute('#/clients')).toEqual({ page: 'clients' })
    expect(parseRoute('#/settings')).toEqual({ page: 'settings' })
    expect(parseRoute('#/confirm/cf_1')).toEqual({ page: 'confirm', confirmationId: 'cf_1' })
    expect(parseRoute('#/needs-user/woolworths')).toEqual({ page: 'needs-user', adapterId: 'woolworths' })
    const setup = { page: 'setup', review: false, secret: null }
    expect(parseRoute('#/setup')).toEqual({ ...setup, step: null })
    for (const step of ['welcome', 'onepassword', 'approve', 'grant', 'store', 'clients']) {
      expect(parseRoute(`#/setup/${step}`)).toEqual({ ...setup, step })
    }
    expect(parseRoute('#/setup/approve/review')).toEqual({ ...setup, step: 'approve', review: true })
    expect(parseRoute('#/setup/grant/login')).toEqual({ ...setup, step: 'grant', secret: 'login' })
  })

  it('refuses extra segments and unknown pages rather than guessing', () => {
    for (const hash of [
      '#/adapters/a/b',
      '#/adapters/a/grant',
      '#/adapters/a/grant/x/y',
      '#/adapters/a/review/x',
      '#/activity/a/b',
      '#/audit/x',
      '#/confirm',
      '#/confirm/a/b',
      '#/needs-user',
      '#/needs-user/a/b',
      '#/setup/elsewhere',
      '#/setup/welcome/review',
      '#/setup/approve/x',
      '#/setup/grant/login/x',
      '#/elsewhere',
    ]) {
      expect(parseRoute(hash)).toEqual({ page: 'not-found' })
    }
  })

  it('refuses malformed percent-encoding and absurdly long segments', () => {
    expect(parseRoute('#/adapters/%E0%A4%A')).toEqual({ page: 'not-found' })
    expect(parseRoute(`#/adapters/${'a'.repeat(201)}`)).toEqual({ page: 'not-found' })
  })

  it('round-trips ids with slashes and other reserved characters through href', () => {
    const odd = 'a/b?c#d'
    expect(parseRoute(href.adapter(odd))).toEqual({ page: 'adapter', adapterId: odd })
    expect(parseRoute(href.grant(odd, '__proto__'))).toEqual({
      page: 'grant',
      adapterId: odd,
      secret: '__proto__',
    })
    expect(parseRoute(href.review(odd))).toEqual({ page: 'review', adapterId: odd })
    expect(parseRoute(href.activity(odd))).toEqual({ page: 'activity', callId: odd })
    expect(parseRoute(href.confirm(odd))).toEqual({ page: 'confirm', confirmationId: odd })
    expect(parseRoute(href.needsUser(odd))).toEqual({ page: 'needs-user', adapterId: odd })
    expect(href.activity()).toBe('#/activity')
    expect(href.adapters()).toBe('#/adapters')
    expect(href.audit()).toBe('#/audit')
    expect(href.credentials()).toBe('#/credentials')
    expect(href.clients()).toBe('#/clients')
    expect(href.settings()).toBe('#/settings')
    expect(href.setup()).toBe('#/setup')
    expect(href.setup('clients')).toBe('#/setup/clients')
    expect(parseRoute(href.setupReview())).toEqual({
      page: 'setup',
      step: 'approve',
      review: true,
      secret: null,
    })
    expect(parseRoute(href.setupGrant(odd))).toEqual({
      page: 'setup',
      step: 'grant',
      review: false,
      secret: odd,
    })
  })
})

describe('panelOnlyRoute', () => {
  it('keeps the confirmation panel and the hand-off banner out of the control panel', () => {
    expect(panelOnlyRoute(href.confirm('cf_1'))).toBe(true)
    expect(panelOnlyRoute(href.needsUser('woolworths'))).toBe(true)
    expect(panelOnlyRoute(href.review('woolworths'))).toBe(false)
    expect(panelOnlyRoute(href.activity())).toBe(false)
  })
})
