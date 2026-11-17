// This Mac's approval keys changed (persona QA, key loss): nothing the old keys signed counts, and the
// app says so in plain words instead of reading as a first run. The main process decides what no
// longer counts (test/main/service.test.ts); these check what the person sees.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { needsYouView } from '../src/renderer/lib/needs-you'
import { siteStatus } from '../src/renderer/lib/site-status'
import type { AdapterDetail, AdapterSummary, AttentionItem, KeysChangedItem } from '../src/shared/api'

const NOW = Date.parse('2026-11-17T21:48:00+11:00')

const KEYS_ITEM: KeysChangedItem = {
  kind: 'keys-changed',
  id: 'keys-changed',
  sites: [
    { adapterId: 'woolworths', adapterName: 'Woolworths', review: true, logins: ['login', 'messages'] },
  ],
  others: 0,
}

function renderAt(hash: string, api: FakeApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TooltipProvider>
        <ControlPanel />
      </TooltipProvider>
    </ApiProvider>,
  )
}

/**
 * The fake after the keys changed: Woolworths approved before under the old keys and not now, its
 * login and code grants lapsed, setup finished long ago. `notice` adds the keys-changed item.
 */
function afterKeyLoss(notice = true): FakeApi & { dismissed: string[] } {
  const api = createFakeApi({ now: NOW })
  const dismissed: string[] = []
  let shown = notice
  const patch = <T extends AdapterSummary>(a: T): T =>
    a.id !== 'woolworths'
      ? a
      : {
          ...a,
          approval: 'unapproved',
          approvedBefore: true,
          secrets: [{ name: 'login', granted: false, lapsed: true }],
          messagesSources: [{ sender: '+61 400 000 111', granted: false, lapsed: true }],
          ...('secretRequests' in a
            ? {
                secretRequests: (a as unknown as AdapterDetail).secretRequests.map((s) => ({
                  ...s,
                  grant: null,
                })),
                messages: [],
              }
            : {}),
        }
  return {
    ...api,
    dismissed,
    adapters: {
      ...api.adapters,
      list: async () => (await api.adapters.list()).map(patch),
      get: async (id) => {
        const d = await api.adapters.get(id)
        return d === null ? null : patch(d)
      },
    },
    attention: {
      ...api.attention,
      list: async () => [...(await api.attention.list()), ...(shown ? [KEYS_ITEM] : [])],
      dismiss: async (id) => {
        dismissed.push(id)
        shown = false
        api.fake.emit({ type: 'attention-changed' })
      },
    },
    setup: { ...api.setup, status: async () => ({ completedAt: '2026-11-01T00:00:00.000Z' }) },
  }
}

describe('when this Mac’s approval keys changed', () => {
  it('says so in Needs you, lists what to do again, and can be dismissed', async () => {
    const api = afterKeyLoss()
    renderAt('#/needs-you', api)
    const list = await screen.findByRole('list', { name: 'Waiting for you' })
    const item = await within(list).findByText('This Mac’s approval keys changed')
    const row = item.closest('li') as HTMLElement
    expect(row.textContent).toContain(
      'The approvals and logins you gave before no longer count. Review each site again to turn it back on: Woolworths (approve again, login, SMS codes).',
    )
    expect(within(row).getByRole('button', { name: 'Review Woolworths again' })).toBeTruthy()
    // Setup was finished: the steps read as undone only because the approvals stopped counting.
    expect(screen.queryByText(/^Finish setup/)).toBeNull()
    await userEvent.click(within(row).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(screen.queryByText('This Mac’s approval keys changed')).toBeNull())
    expect(api.dismissed).toEqual(['keys-changed'])
  })

  it('still offers to finish setup when the keys never changed', async () => {
    renderAt('#/needs-you', afterKeyLoss(false))
    expect(await screen.findByText(/^Finish setup/)).toBeTruthy()
  })

  it('words the site as approving again, not as a first look', async () => {
    renderAt('#/sites/woolworths', afterKeyLoss())
    expect(await screen.findByText('Approve again', { selector: '[data-slot="badge"], span' })).toBeTruthy()
    expect(screen.queryByText('Not approved yet')).toBeNull()
    expect(
      await screen.findByText('Approve Woolworths again: this Mac’s approval keys changed.'),
    ).toBeTruthy()
    expect(
      screen.getByText(/that approval was signed with this Mac’s old keys, so it no longer counts/),
    ).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review Woolworths again' })).toBeTruthy()
  })
})

describe('the words for it', () => {
  const adapter: AdapterSummary = {
    id: 'woolworths',
    name: 'Woolworths',
    site: 'woolworths.com.au',
    version: '0.3.0',
    hash: 'a'.repeat(64),
    approval: 'approved',
    pendingUpdate: null,
    toolCounts: { read: 1, write: 0, irreversible: 0 },
    secrets: [{ name: 'login', granted: true }],
    messagesSources: [{ sender: 'Woolworths', granted: true }],
    session: { state: 'logged-in', checkedAt: null, needsUser: null, since: null },
    calls7d: 21,
    settingsNeeded: [],
    cartUrl: null,
    paused: false,
  }

  it('never shows "Ready" over a grant that no longer counts', () => {
    expect(siteStatus(adapter, null).text).toBe('Ready')
    const lapsedCodes = {
      ...adapter,
      messagesSources: [{ sender: 'Woolworths', granted: false, lapsed: true }],
    }
    expect(siteStatus(lapsedCodes, null)).toEqual({
      tone: 'warning',
      text: 'Allow Woolworths its SMS codes again · the permission you gave no longer counts',
      fix: 'login',
    })
    // Codes never allowed are optional, as before.
    expect(
      siteStatus({ ...adapter, messagesSources: [{ sender: 'Woolworths', granted: false }] }, null).text,
    ).toBe('Ready')
    expect(
      siteStatus({ ...adapter, secrets: [{ name: 'login', granted: false, lapsed: true }] }, null).text,
    ).toBe('Give Valet your Woolworths login again · the one you gave no longer counts')
  })

  it('titles the review as approving again', () => {
    const review: AttentionItem = {
      kind: 'review',
      id: 'rv_woolworths',
      adapterId: 'woolworths',
      adapterName: 'Woolworths',
      version: '0.3.0',
      addsPermissions: false,
      firstInstall: false,
      approvedBefore: true,
    }
    const view = needsYouView(review, () => true)
    expect(view.title).toBe('Approve Woolworths again')
    expect(view.description).toContain('approval keys changed')
    expect(needsYouView({ ...review, approvedBefore: undefined, firstInstall: true }, () => true).title).toBe(
      'Review Woolworths before first use',
    )
  })

  it('points the notice at the first thing to do again', () => {
    expect(needsYouView(KEYS_ITEM, () => false).action).toEqual({
      kind: 'route',
      to: '#/sites/woolworths/versions/review',
    })
    const codesOnly: KeysChangedItem = {
      ...KEYS_ITEM,
      sites: [{ adapterId: 'woolworths', adapterName: 'Woolworths', review: false, logins: ['messages'] }],
      others: 2,
    }
    const view = needsYouView(codesOnly, () => false)
    expect(view.actionLabel).toBe('Allow SMS codes again…')
    expect(view.description).toContain('Woolworths (SMS codes)')
    expect(view.description).toContain('Other approvals')
  })
})
