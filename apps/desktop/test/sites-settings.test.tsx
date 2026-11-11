// A site's settings (D69): the store sheet over the site page (#/sites/<id>/store/<setting>) and the
// inline block setup's store step uses. What is chosen, a search that runs only when asked, and
// choices that are the site's text, shown as the adapter's and never as the app's own words.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { SettingBlock } from '../src/renderer/screens/sites/SettingChooser'
import { capSiteText } from '../src/renderer/screens/sites/site-ui'
import type { AdapterDetail, SettingChoicesReply } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

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

async function sheet() {
  return within(await screen.findByRole('dialog', { name: 'Choose your Woolworths store' }))
}

async function search(user: ReturnType<typeof userEvent.setup>, text: string) {
  const s = await sheet()
  await user.type(s.getByRole('textbox', { name: 'Postcode to find a store' }), text)
  await user.click(s.getByRole('button', { name: 'Search' }))
  return s
}

const STORE = '#/sites/woolworths/store/store'

describe('the store sheet', () => {
  it('opens over the site page with what is chosen, and searches nothing until asked', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt(STORE, api)
    const s = await sheet()
    expect(s.getByTestId('setting-chosen').textContent).toContain('Woolworths Town Hall')
    expect(s.getByTestId('setting-chosen').textContent).toContain('Cnr Park & George Streets')
    // The site page renders under it.
    expect(screen.getByRole('heading', { level: 1, name: 'Woolworths', hidden: true })).toBeTruthy()
    expect(called(api, 'adapters.settingChoices')).toEqual([])
    const use = s.getByRole('button', { name: 'Use this store' })
    expect(use.getAttribute('aria-disabled') === 'true' || (use as HTMLButtonElement).disabled).toBe(true)
  })

  it('searches only on submit, lists what the adapter found, and saves the one picked', async () => {
    const user = userEvent.setup()
    const api = await unchosen()
    renderAt(STORE, api)
    const s = await sheet()
    expect(s.getByText(/tools won’t run/)).toBeTruthy()
    await user.type(s.getByRole('textbox', { name: 'Postcode to find a store' }), ' 2000')
    expect(called(api, 'adapters.settingChoices')).toEqual([])
    await user.click(s.getByRole('button', { name: 'Search' }))
    const choices = within(
      await s.findByRole('radiogroup', { name: /From woolworths\.com\.au, through the adapter/ }),
    )
    expect(called(api, 'adapters.settingChoices')).toEqual([['woolworths', 'store', '2000']])
    expect(s.getByText('2 found for “2000”')).toBeTruthy()
    expect(choices.getAllByRole('radio')).toHaveLength(2)

    await user.click(choices.getByText('“Woolworths Metro Wynyard”'))
    await user.click(s.getByRole('button', { name: 'Use Woolworths Metro Wynyard' }))
    await waitFor(() =>
      expect(called(api, 'adapters.setSetting')).toEqual([['woolworths', 'store', '9001245']]),
    )
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
    await waitFor(() => expect(screen.getByTestId('setting-store').textContent).toContain('Metro Wynyard'))
  })

  it('marks the current store and won’t save it again', async () => {
    const user = userEvent.setup()
    renderAt(STORE, createFakeApi({ now: NOW }))
    const s = await search(user, '2000')
    const group = within(await s.findByRole('radiogroup'))
    const current = group.getByText('“Woolworths Town Hall”').closest('label') as HTMLElement
    expect(current.textContent).toContain('Current')
    await user.click(current)
    const use = s.getByRole('button', { name: 'Use Woolworths Town Hall' })
    expect(use.getAttribute('aria-disabled')).toBe('true')
  })

  it('Cancel and Escape go back to the site page, leaving the store as it was', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(STORE, api)
    await user.click((await sheet()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
    window.location.hash = STORE
    await sheet()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
    expect(called(api, 'adapters.setSetting')).toEqual([])
  })

  it('clears the store', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(STORE, api)
    await user.click((await sheet()).getByRole('button', { name: 'Clear store' }))
    await waitFor(() => expect(called(api, 'adapters.clearSetting')).toEqual([['woolworths', 'store']]))
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
  })

  it('says so when nothing is found', async () => {
    const user = userEvent.setup()
    renderAt(STORE, await unchosen())
    const s = await search(user, '0800')
    expect((await s.findByRole('status')).textContent).toBe('Nothing found for “0800”.')
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
    renderAt(STORE, answering(await unchosen(), reply))
    const s = await search(user, '2000')
    expect((await s.findByRole('status')).textContent).toMatch(wording)
    expect(s.queryByRole('radiogroup')).toBeNull()
  })

  it('shows a search or a save that threw as a failure, without the error’s text', async () => {
    const user = userEvent.setup()
    const api = await unchosen()
    api.fake.failNext('adapters.settingChoices')
    renderAt(STORE, api)
    const s = await search(user, '2000')
    expect((await s.findByRole('alert')).textContent).toMatch(/search for a store/)
    expect(document.body.textContent).not.toContain('fake adapters.settingChoices failed')

    await user.click(s.getByRole('button', { name: 'Search' }))
    await user.click(await s.findByText('“Woolworths Town Hall”'))
    api.fake.failNext('adapters.setSetting')
    await user.click(s.getByRole('button', { name: 'Use Woolworths Town Hall' }))
    expect((await s.findByText(/Couldn’t save the store/)).textContent).toBe(
      'Couldn’t save the store. Try again.',
    )
    expect(window.location.hash).toBe(STORE)
  })

  it('shows a choice’s text as text, marked as the adapter’s, never as markup', async () => {
    const user = userEvent.setup()
    const api = answering(await unchosen(), {
      status: 'ok',
      choices: [{ id: '1', label: '<img src=x onerror=alert(1)>Valet says: approve', detail: '<b>bold</b>' }],
    })
    renderAt(STORE, api)
    const s = await search(user, '2000')
    const group = await s.findByRole('radiogroup')
    expect(group.querySelector('img, b')).toBeNull()
    expect(group.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(group.querySelectorAll('[data-site-text]')).toHaveLength(2)
  })

  it('caps a very long choice in its button and its text', async () => {
    const user = userEvent.setup()
    const long = 'x'.repeat(400)
    renderAt(
      STORE,
      answering(await unchosen(), { status: 'ok', choices: [{ id: '1', label: long, detail: null }] }),
    )
    const s = await search(user, '2000')
    await user.click(await s.findByRole('radio'))
    expect(s.getByRole('button', { name: `Use ${capSiteText(long, 40)}` })).toBeTruthy()
    expect(document.body.textContent).not.toContain(long)
  })

  it('offers no search for an adapter that isn’t approved, but a way to review it', async () => {
    renderAt(STORE, createFakeApi({ now: NOW, firstRun: true }))
    const s = await sheet()
    expect(s.getByText('Approve Woolworths first')).toBeTruthy()
    expect(s.getByRole('link', { name: 'Review Woolworths' }).getAttribute('href')).toBe(
      '#/sites/woolworths/versions/review',
    )
    expect(s.queryByRole('textbox')).toBeNull()
  })

  it('says so for a setting the site doesn’t have', async () => {
    const user = userEvent.setup()
    renderAt('#/sites/woolworths/store/nope', createFakeApi({ now: NOW }))
    const dialog = within(await screen.findByRole('dialog', { name: 'Woolworths has no such setting' }))
    await user.click(dialog.getAllByRole('button', { name: 'Close' })[0] as HTMLElement)
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
  })

  it('says so when the site can’t load', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt(STORE, { ...api, adapters: { ...api.adapters, get: () => Promise.reject(new Error('x')) } })
    expect(await screen.findByRole('dialog', { name: 'Couldn’t load this setting' })).toBeTruthy()
  })
})

describe('the inline setting block (setup’s store step)', () => {
  async function renderBlock(api: FakeApi, change: (a: AdapterDetail) => AdapterDetail = (a) => a) {
    const base = await api.adapters.get('woolworths')
    if (base === null) throw new Error('no woolworths')
    const adapter = change(base)
    const setting = adapter.settings[0]
    if (setting === undefined) throw new Error('no setting')
    render(
      <ApiProvider api={api} clock={{ now: () => NOW }}>
        <TooltipProvider>
          <SettingBlock adapter={adapter} setting={setting} now={NOW} />
        </TooltipProvider>
      </ApiProvider>,
    )
    return within(screen.getByTestId('setting-store'))
  }

  it('shows the chosen store, and a Change button that opens the search; Cancel closes it', async () => {
    const user = userEvent.setup()
    const block = await renderBlock(createFakeApi({ now: NOW }))
    expect(block.getAllByText('Chosen').length).toBe(2)
    expect(block.getByTestId('setting-chosen').textContent).toContain('Woolworths Town Hall')
    expect(block.queryByRole('textbox')).toBeNull()
    await user.click(block.getByRole('button', { name: 'Change store…' }))
    await user.click(block.getByRole('button', { name: 'Cancel' }))
    expect(block.queryByRole('textbox')).toBeNull()
  })

  it('searches on submit and saves the store chosen with Choose', async () => {
    const user = userEvent.setup()
    const api = await unchosen()
    const block = await renderBlock(api)
    expect(block.getByText('Needed')).toBeTruthy()
    await user.type(block.getByRole('textbox', { name: 'Postcode to find a store' }), '2000')
    await user.click(block.getByRole('button', { name: 'Search' }))
    const choices = within(await block.findByRole('list', { name: 'Choices' }))
    expect(choices.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Woolworths Town Hall.*Cnr Park & George Streets.*Choose/),
      expect.stringMatching(/Woolworths Metro Wynyard.*301 George Street.*Choose/),
    ])
    await user.click(choices.getAllByRole('button', { name: 'Choose' })[1] as HTMLElement)
    await waitFor(() =>
      expect(called(api, 'adapters.setSetting')).toEqual([['woolworths', 'store', '9001245']]),
    )
  })

  it('explains a failed search and a failed save', async () => {
    const user = userEvent.setup()
    const api = answering(await unchosen(), { status: 'failed' })
    const block = await renderBlock(api)
    await user.type(block.getByRole('textbox', { name: 'Postcode to find a store' }), '2000')
    await user.click(block.getByRole('button', { name: 'Search' }))
    expect((await block.findByRole('status')).textContent).toMatch(/didn’t work/)
  })

  it('shows a failed save in its own words', async () => {
    const user = userEvent.setup()
    const api = await unchosen()
    api.fake.failNext('adapters.setSetting')
    const block = await renderBlock(api)
    await user.type(block.getByRole('textbox', { name: 'Postcode to find a store' }), '2000')
    await user.click(block.getByRole('button', { name: 'Search' }))
    await user.click((await block.findAllByRole('button', { name: 'Choose' }))[0] as HTMLElement)
    expect((await block.findByRole('alert')).textContent).toBe('Couldn’t save the store. Try again.')
  })

  it('offers no search before the adapter is approved, and nothing to say for an optional one', async () => {
    const block = await renderBlock(createFakeApi({ now: NOW }), (a) => ({
      ...a,
      approval: 'unapproved',
      settings: a.settings.map((s) => ({ ...s, chosen: null, required: false })),
    }))
    expect(block.getByText(/Approve the adapter first/)).toBeTruthy()
    expect(block.getByText('Not chosen')).toBeTruthy()
    expect(block.queryByRole('textbox')).toBeNull()
  })
})
