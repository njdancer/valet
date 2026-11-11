// A site's one-line health (IA: "each site's health line"), shared by the sidebar's dots, the Sites
// list, the site's Overview, Needs you's status block and the menu bar. One function so the four
// never disagree about whether Woolworths is fine.

import type { DotTone } from '@valet/ui'
import type { AdapterSummary, SiteHealth } from '../../shared/api'
import { formatClock } from './format'
import { needsUserWording } from './wording'

export interface SiteStatus {
  readonly tone: DotTone
  /** "Ready", "Woolworths is limiting requests · calls resume at 9:52 pm". */
  readonly text: string
  /** What fixes it, when the person can: the IA's "do the task where you notice it". */
  readonly fix: 'review' | 'review-update' | 'login' | 'show-login' | 'choose-setting' | 'resume' | null
}

/**
 * Whether the site waits for its first review, as opposed to an update. In the main process a
 * changed bundle is unapproved with pendingUpdate set (its tools are off until the person approves);
 * a first install is unapproved with no update.
 */
export function isFirstReview(adapter: Pick<AdapterSummary, 'approval' | 'pendingUpdate'>): boolean {
  return adapter.approval !== 'approved' && adapter.pendingUpdate === null
}

export function healthFor(adapter: AdapterSummary, sites: readonly SiteHealth[]): SiteHealth | null {
  return sites.find((s) => s.adapterIds.includes(adapter.id)) ?? null
}

export function siteStatus(adapter: AdapterSummary, health: SiteHealth | null): SiteStatus {
  if (adapter.approval === 'rejected')
    return { tone: 'danger', text: 'You turned this version down · its tools are off', fix: 'review' }
  if (adapter.approval === 'unapproved' && adapter.pendingUpdate !== null)
    return {
      tone: 'accent',
      text: `Update ${adapter.pendingUpdate.version} waiting for review · its tools are off until you approve it`,
      fix: 'review-update',
    }
  if (adapter.approval === 'unapproved')
    return { tone: 'accent', text: 'Not approved yet · its tools are off until you review it', fix: 'review' }
  if (adapter.paused)
    return { tone: 'neutral', text: `${adapter.name} paused · calls are refused`, fix: 'resume' }
  // An open breaker leads: nothing reaches the site until it closes, whatever else is waiting. A
  // login the person can still give keeps its button.
  if (health !== null && health.breaker === 'open') {
    const when = health.retryAt === null ? null : formatClock(health.retryAt)
    const who =
      health.cause === 'rate-limited'
        ? `Valet is limiting its requests to ${adapter.name}`
        : `${adapter.name} is limiting requests`
    return {
      tone: 'warning',
      text: when === null ? who : `${who} · calls resume at ${when}`,
      fix: adapter.session.state === 'needs-user' ? 'show-login' : null,
    }
  }
  if (adapter.session.state === 'needs-user') {
    const reason = adapter.session.needsUser
    return {
      tone: 'warning',
      text: `Waiting for you to log in${reason ? ` (${needsUserWording(reason).short.toLowerCase()})` : ''}`,
      fix: 'show-login',
    }
  }
  if (adapter.settingsNeeded.length > 0)
    return {
      tone: 'warning',
      text: `Choose your ${adapter.name} ${adapter.settingsNeeded[0]?.toLowerCase() ?? 'setting'} · calls wait until you do`,
      fix: 'choose-setting',
    }
  const missingLogin = adapter.secrets.find((s) => !s.granted)
  if (missingLogin !== undefined)
    return { tone: 'warning', text: `Give Valet your ${adapter.name} login`, fix: 'login' }
  if (adapter.pendingUpdate !== null)
    return {
      tone: 'success',
      text: `Ready · update ${adapter.pendingUpdate.version} waiting for review`,
      fix: 'review-update',
    }
  if (adapter.session.state === 'logging-in') return { tone: 'success', text: 'Logging in…', fix: null }
  if (adapter.session.state === 'expired')
    return { tone: 'success', text: 'Ready · logs in again on the next call', fix: null }
  if (health !== null && health.calls > 0)
    return {
      tone: 'success',
      text: health.calls === 1 ? 'Working on 1 call' : `Working on ${health.calls} calls`,
      fix: null,
    }
  return { tone: 'success', text: 'Ready', fix: null }
}
