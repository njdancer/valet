import { describe, expect, it } from 'vitest'
import {
  canonicalHref,
  href,
  NO_AUDIT_FILTERS,
  NO_CALL_FILTERS,
  parseRoute,
  placeOf,
} from '../src/renderer/lib/router'
import { panelOnlyRoute } from '../src/renderer/lib/routes'

describe('parseRoute', () => {
  it('parses the six places and every page under them', () => {
    expect(parseRoute('')).toEqual({ page: 'needs-you', item: null })
    expect(parseRoute('#/needs-you')).toEqual({ page: 'needs-you', item: null })
    expect(parseRoute('#/needs-you/cf_1')).toEqual({ page: 'needs-you', item: 'cf_1' })
    expect(parseRoute('#/sites')).toEqual({ page: 'sites' })
    expect(parseRoute('#/sites/woolworths')).toEqual({
      page: 'site',
      adapterId: 'woolworths',
      tab: 'overview',
    })
    for (const tab of ['overview', 'tools', 'permissions', 'versions']) {
      expect(parseRoute(`#/sites/woolworths/${tab}`)).toEqual({ page: 'site', adapterId: 'woolworths', tab })
    }
    expect(parseRoute('#/sites/woolworths/versions/review')).toEqual({
      page: 'review',
      adapterId: 'woolworths',
    })
    expect(parseRoute('#/sites/woolworths/login/login')).toEqual({
      page: 'grant',
      adapterId: 'woolworths',
      secret: 'login',
    })
    expect(parseRoute('#/sites/woolworths/store/store')).toEqual({
      page: 'setting',
      adapterId: 'woolworths',
      setting: 'store',
    })
    expect(parseRoute('#/activity/calls')).toEqual({ page: 'calls', callId: null, filters: NO_CALL_FILTERS })
    expect(
      parseRoute('#/activity/calls/c_1?site=woolworths&outcome=failed&login=woolworths%2Flogin'),
    ).toEqual({
      page: 'calls',
      callId: 'c_1',
      filters: { ...NO_CALL_FILTERS, site: 'woolworths', outcome: 'failed', login: 'woolworths/login' },
    })
    expect(parseRoute('#/activity/calls?outcome=nonsense')).toEqual({
      page: 'calls',
      callId: null,
      filters: NO_CALL_FILTERS,
    })
    expect(parseRoute('#/activity/audit')).toEqual({ page: 'audit', seq: null, filters: NO_AUDIT_FILTERS })
    expect(parseRoute('#/activity/audit/42?category=logins&call=c_1')).toEqual({
      page: 'audit',
      seq: 42,
      filters: { ...NO_AUDIT_FILTERS, category: 'logins', call: 'c_1' },
    })
    expect(parseRoute('#/connections')).toEqual({ page: 'connections' })
    expect(parseRoute('#/connections/remote')).toEqual({ page: 'remote' })
    expect(parseRoute('#/connections/approve')).toEqual({ page: 'approve-connection' })
    expect(parseRoute('#/connections/cl_1')).toEqual({ page: 'client', clientId: 'cl_1' })
    expect(parseRoute('#/secrets')).toEqual({ page: 'secrets' })
    expect(parseRoute('#/secrets/woolworths/login')).toEqual({
      page: 'login',
      adapterId: 'woolworths',
      secret: 'login',
    })
    expect(parseRoute('#/settings')).toEqual({ page: 'settings', section: 'general' })
    for (const section of ['general', 'notifications', 'data', 'updates', 'reset']) {
      expect(parseRoute(`#/settings/${section}`)).toEqual({ page: 'settings', section })
    }
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

  it('still reads the addresses from before the redesign, as the same pages', () => {
    // Notifications and tool results already printed may name these.
    expect(parseRoute('#/adapters')).toEqual({ page: 'sites' })
    expect(parseRoute('#/adapters/woolworths')).toEqual({
      page: 'site',
      adapterId: 'woolworths',
      tab: 'overview',
    })
    expect(parseRoute('#/adapters/woolworths/review')).toEqual({ page: 'review', adapterId: 'woolworths' })
    expect(parseRoute('#/adapters/woolworths/grant/login')).toEqual({
      page: 'grant',
      adapterId: 'woolworths',
      secret: 'login',
    })
    expect(parseRoute('#/activity')).toEqual({ page: 'calls', callId: null, filters: NO_CALL_FILTERS })
    expect(parseRoute('#/activity/c_8f2e1b')).toEqual({
      page: 'calls',
      callId: 'c_8f2e1b',
      filters: NO_CALL_FILTERS,
    })
    expect(parseRoute('#/audit')).toEqual({ page: 'audit', seq: null, filters: NO_AUDIT_FILTERS })
    expect(parseRoute('#/credentials')).toEqual({ page: 'secrets' })
    expect(parseRoute('#/clients')).toEqual({ page: 'connections' })
    expect(parseRoute('#/remote')).toEqual({ page: 'remote' })
    expect(canonicalHref(parseRoute('#/adapters/woolworths/review'))).toBe(
      '#/sites/woolworths/versions/review',
    )
    expect(canonicalHref(parseRoute('#/clients'))).toBe('#/connections')
    expect(canonicalHref(parseRoute('#/remote'))).toBe('#/connections/remote')
    expect(canonicalHref(parseRoute('#/credentials'))).toBe('#/secrets')
    expect(canonicalHref(parseRoute('#/audit'))).toBe('#/activity/audit')
    expect(canonicalHref(parseRoute('#/activity/c_1'))).toBe('#/activity/calls/c_1')
  })

  it('refuses extra segments and unknown pages rather than guessing', () => {
    for (const hash of [
      '#/needs-you/a/b',
      '#/sites/a/b',
      '#/sites/a/versions/x',
      '#/sites/a/login',
      '#/adapters/a/b',
      '#/adapters/a/grant',
      '#/adapters/a/grant/x/y',
      '#/adapters/a/review/x',
      '#/activity/a/b',
      '#/activity/calls/a/b',
      '#/activity/audit/x',
      '#/audit/x',
      '#/clients/x',
      '#/remote/x',
      '#/credentials/x',
      '#/connections/a/b',
      '#/secrets/a',
      '#/settings/elsewhere',
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
    expect(parseRoute('#/sites/%E0%A4%A')).toEqual({ page: 'not-found' })
    expect(parseRoute('#/activity/calls?site=%E0%A4%A')).toEqual({ page: 'not-found' })
    expect(parseRoute(`#/sites/${'a'.repeat(201)}`)).toEqual({ page: 'not-found' })
  })

  it('round-trips ids with slashes and other reserved characters through href', () => {
    const odd = 'a/b?c#d&e=f'
    const round = (h: `#/${string}`) => canonicalHref(parseRoute(h))
    for (const h of [
      href.needsYou(odd),
      href.site(odd),
      href.site(odd, 'tools'),
      href.review(odd),
      href.grant(odd, '__proto__'),
      href.setting(odd, odd),
      href.call(odd, { site: odd, tool: odd, client: odd, outcome: 'failed', login: odd }),
      href.calls({ site: odd }),
      href.audit({ category: 'blocked', site: odd, call: odd }, 7),
      href.client(odd),
      href.login(odd, odd),
      href.settings('updates'),
    ]) {
      expect(round(h)).toBe(h)
    }
    expect(parseRoute(href.confirm(odd))).toEqual({ page: 'confirm', confirmationId: odd })
    expect(parseRoute(href.needsUser(odd))).toEqual({ page: 'needs-user', adapterId: odd })
    expect(href.calls()).toBe('#/activity/calls')
    expect(href.audit()).toBe('#/activity/audit')
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
    expect(canonicalHref(parseRoute(href.setup()))).toBeNull()
    expect(canonicalHref({ page: 'not-found' })).toBeNull()
  })

  it('names the place each page belongs to', () => {
    expect(placeOf(parseRoute(href.grant('w', 's')))).toBe('sites')
    expect(placeOf(parseRoute(href.audit()))).toBe('activity')
    expect(placeOf(parseRoute(href.approveConnection()))).toBe('connections')
    expect(placeOf(parseRoute(href.login('w', 's')))).toBe('secrets')
    expect(placeOf(parseRoute(href.settings('reset')))).toBe('settings')
    expect(placeOf(parseRoute(href.needsYou()))).toBe('needs-you')
    expect(placeOf(parseRoute(href.confirm('x')))).toBeNull()
  })
})

describe('panelOnlyRoute', () => {
  it('keeps the confirmation panel and the hand-off banner out of the control panel', () => {
    expect(panelOnlyRoute(href.confirm('cf_1'))).toBe(true)
    expect(panelOnlyRoute(href.needsUser('woolworths'))).toBe(true)
    expect(panelOnlyRoute(href.review('woolworths'))).toBe(false)
    expect(panelOnlyRoute(href.calls())).toBe(false)
  })
})
