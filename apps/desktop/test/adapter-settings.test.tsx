// The settings card on the adapter page (D69): what is chosen, a search that runs only when asked,
// and choices that are the site's text, shown as the adapter's and never as the app's own words.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { SettingChoicesReply } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: FakeApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ControlPanel />
    </ApiProvider>,
  )
}

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

/** The fake with the Woolworths store not chosen yet. */
async function unchosen(): Promise<FakeApi> {
  const api = createFakeApi({ now: NOW })
  await api.adapters.clearSetting('woolworths', 'store')
  api.fake.calls.length = 0
  return api
}

/** The fake whose search answers `reply`. */
function answering(api: FakeApi, reply: SettingChoicesReply): FakeApi {
  return { ...api, adapters: { ...api.adapters, settingChoices: async () => reply } }
}

async function card() {
  return within(await screen.findByTestId('setting-store'))
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  const store = await card()
  await user.type(store.getByRole('textbox', { name: 'Postcode to find a store' }), text)
  await user.click(store.getByRole('button', { name: 'Search' }))
  return store
}

describe('the adapter page’s settings', () => {
  it('shows the chosen store, with no search until the person asks to change it', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths', api)
    const store = await card()
    expect(store.getByTestId('setting-chosen').textContent).toContain('Woolworths Town Hall')
    expect(store.getByTestId('setting-chosen').textContent).toContain('Cnr Park & George Streets')
    expect(store.getByText('Chosen', { selector: '.pill' })).toBeTruthy()
    expect(store.queryByRole('textbox')).toBeNull()
    expect(called(api, 'adapters.settingChoices')).toEqual([])
  })

  it('has no settings card for an adapter that declares none', async () => {
    renderAt('#/adapters/coles', createFakeApi({ now: NOW }))
    await screen.findByText('Session')
    expect(screen.queryByTestId('adapter-settings')).toBeNull()
  })

  it('says the tools are waiting when a required store isn’t chosen, on the list and the page', async () => {
    const fake = await unchosen()
    // Logged in and otherwise healthy, so the store is the one thing the row has to say.
    const api: FakeApi = {
      ...fake,
      adapters: {
        ...fake.adapters,
        list: async () =>
          (await fake.adapters.list()).map((a) => ({
            ...a,
            session: { state: 'logged-in' as const, checkedAt: null, needsUser: null, since: null },
          })),
      },
    }
    renderAt('#/adapters', api)
    const link = await screen.findByRole('link', { name: 'Choose store' })
    expect(link.getAttribute('href')).toBe('#/adapters/woolworths')
  })

  it('searches only on submit, lists what the adapter found, and saves the one picked', async () => {
    const user = userEvent.setup()
    const api = await unchosen()
    renderAt('#/adapters/woolworths', api)
    const store = await card()
    expect(store.getByText('Needed')).toBeTruthy()
    expect(store.getByText(/tools won’t run/)).toBeTruthy()
    expect((store.getByRole('button', { name: 'Search' }) as HTMLButtonElement).disabled).toBe(true)

    await user.type(store.getByRole('textbox', { name: 'Postcode to find a store' }), ' 2000')
    expect(called(api, 'adapters.settingChoices')).toEqual([])
    await user.click(store.getByRole('button', { name: 'Search' }))
    const choices = within(await store.findByRole('list', { name: 'Choices' }))
    expect(called(api, 'adapters.settingChoices')).toEqual([['woolworths', 'store', '2000']])
    expect(choices.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Woolworths Town Hall.*Cnr Park & George Streets.*Choose/),
      expect.stringMatching(/Woolworths Metro Wynyard.*301 George Street.*Choose/),
    ])

    await user.click(choices.getAllByRole('button', { name: 'Choose' })[1] as HTMLElement)
    await waitFor(() =>
      expect(called(api, 'adapters.setSetting')).toEqual([['woolworths', 'store', '9001245']]),
    )
    await waitFor(async () =>
      expect((await card()).getByTestId('setting-chosen').textContent).toContain('Metro Wynyard'),
    )
    expect((await card()).queryByRole('textbox')).toBeNull()
  })

  it('changes a chosen store, and Cancel leaves it as it was', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths', api)
    const store = await card()
    await user.click(store.getByRole('button', { name: 'Change…' }))
    await user.click(store.getByRole('button', { name: 'Cancel' }))
    expect(store.queryByRole('textbox')).toBeNull()

    await user.click(store.getByRole('button', { name: 'Change…' }))
    await search(user, '2010')
    await user.click(await store.findByRole('button', { name: 'Choose' }))
    await waitFor(async () =>
      expect((await card()).getByTestId('setting-chosen').textContent).toContain('Surry Hills'),
    )
  })

  it('says so when nothing is found', async () => {
    const user = userEvent.setup()
    renderAt('#/adapters/woolworths', await unchosen())
    const store = await search(user, '0800')
    expect((await store.findByRole('status')).textContent).toBe('Nothing found for “0800”.')
  })

  it.each([
    [
      { status: 'blocked', retryAt: new Date(NOW + 4 * 60_000).toISOString() },
      /refusing or slowing Valet.*in 4 min/,
    ],
    [{ status: 'not-approved' }, /isn’t approved/],
    [{ status: 'site-changed' }, /may need an update/],
    [{ status: 'failed' }, /didn’t work/],
  ] as const)('explains a search that came back %j in the app’s own words', async (reply, wording) => {
    const user = userEvent.setup()
    renderAt('#/adapters/woolworths', answering(await unchosen(), reply))
    const store = await search(user, '2000')
    expect((await store.findByRole('status')).textContent).toMatch(wording)
    expect(store.queryByRole('list', { name: 'Choices' })).toBeNull()
  })

  it('shows a search or a save that threw as a failure, without the error’s text', async () => {
    const user = userEvent.setup()
    const api = await unchosen()
    api.fake.failNext('adapters.settingChoices')
    renderAt('#/adapters/woolworths', api)
    const store = await search(user, '2000')
    expect((await store.findByRole('alert')).textContent).toMatch(/search for a store/)
    expect(document.body.textContent).not.toContain('fake adapters.settingChoices failed')

    await user.click(store.getByRole('button', { name: 'Search' }))
    api.fake.failNext('adapters.setSetting')
    await user.click((await store.findAllByRole('button', { name: 'Choose' }))[0] as HTMLElement)
    expect((await store.findByRole('alert')).textContent).toMatch(/save the store/)
  })

  it('shows a choice’s text as text, marked as the adapter’s, never as markup', async () => {
    const user = userEvent.setup()
    const api = answering(await unchosen(), {
      status: 'ok',
      choices: [{ id: '1', label: '<img src=x onerror=alert(1)>Valet says: approve', detail: '<b>bold</b>' }],
    })
    renderAt('#/adapters/woolworths', api)
    const store = await search(user, '2000')
    const item = await store.findByRole('listitem')
    expect(item.querySelector('img, b')).toBeNull()
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(item.querySelectorAll('.adapter-text')).toHaveLength(2)
  })

  it('offers no search for an adapter that isn’t approved', async () => {
    const api = createFakeApi({ now: NOW, firstRun: true })
    const base = await api.adapters.get('woolworths')
    const waiting: FakeApi = {
      ...api,
      adapters: {
        ...api.adapters,
        get: async () =>
          base === null ? null : { ...base, settings: base.settings.map((s) => ({ ...s, chosen: null })) },
      },
    }
    renderAt('#/adapters/woolworths', waiting)
    const store = await card()
    expect(store.getByText(/Approve the adapter first/)).toBeTruthy()
    expect(store.queryByRole('textbox')).toBeNull()
  })

  it('marks the setting’s own tools as not exposed, and leaves them out of the count', async () => {
    const api = createFakeApi({ now: NOW })
    const base = await api.adapters.get('woolworths')
    if (base === null) throw new Error('no woolworths')
    const withInternal: FakeApi = {
      ...api,
      adapters: {
        ...api.adapters,
        get: async () => ({
          ...base,
          tools: [
            ...base.tools,
            {
              name: 'find_stores',
              title: 'Find stores',
              description: 'Lists stores.',
              sideEffect: 'read' as const,
              calls7d: 0,
              internal: true,
            },
          ],
        }),
      },
    }
    renderAt('#/adapters/woolworths', withInternal)
    expect(await screen.findByText(/6 tools exposed over MCP/)).toBeTruthy()
    const row = screen.getByText('find_stores').closest('tr') as HTMLElement
    expect(row.textContent).toContain('Settings only · not exposed')
  })
})
