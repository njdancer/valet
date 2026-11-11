// The Sites list and a site's page (IA section 3, wireframes `sites-list` and `site-*`): every
// state with a next step shows that step as a named button beside it, every object is a link, and
// an update waiting can be reviewed from the site's own page, not only from the menu bar.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { updateSummary } from '../src/renderer/screens/sites/SiteOverview'
import type { AdapterDetail, AdapterSummary } from '../src/shared/api'

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

/** The fake with each adapter's summary and detail changed by `change`. */
function withAdapter(
  api: FakeApi,
  change: (a: AdapterDetail) => Partial<AdapterDetail> & Record<string, unknown>,
): FakeApi {
  const patch = <T extends AdapterSummary>(a: T): T => ({ ...a, ...change(a as unknown as AdapterDetail) })
  return {
    ...api,
    adapters: {
      ...api.adapters,
      list: async () => (await api.adapters.list()).map(patch),
      get: async (id) => {
        const d = await api.adapters.get(id)
        return d === null ? null : patch(d)
      },
    },
  }
}

/** The fake with a per-site pause, as newer main processes have it. */
function withPause(api: FakeApi, paused = false): FakeApi & { pauses: [string, boolean][] } {
  const pauses: [string, boolean][] = []
  const base = withAdapter(api, (a) => (a.id === 'woolworths' ? { paused } : {}))
  return {
    ...base,
    pauses,
    adapters: {
      ...base.adapters,
      setPaused: async (id: string, p: boolean) => {
        pauses.push([id, p])
      },
    } as FakeApi['adapters'],
  }
}

const loggedIn = { state: 'logged-in' as const, checkedAt: null, needsUser: null, since: null }

describe('the Sites list', () => {
  it('shows each site with its name as the link, its adapter version, health and calls', async () => {
    renderAt('#/sites', createFakeApi({ now: NOW }))
    const list = await screen.findByRole('list', { name: 'All sites' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(
        /Woolworths.*woolworths 0\.3\.0.*calls? today.*128 in 7 days.*Waiting for you to log in/,
      ),
      expect.stringMatching(
        /Coles.*coles 0\.1\.2.*41 in 7 days.*Coles is limiting requests · calls resume at/,
      ),
    ])
    const woolworths = within(rows[0] as HTMLElement)
    expect(woolworths.getByRole('link', { name: 'Woolworths' }).getAttribute('href')).toBe(
      '#/sites/woolworths',
    )
    expect(woolworths.getByRole('link', { name: /calls? today/ }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths',
    )
    expect(screen.getByText('2 sites')).toBeTruthy()
    expect(screen.getByText(/there’s nothing to add here/)).toBeTruthy()
  })

  it('keeps the update review one click away even when a login check is the more urgent line', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites', api)
    const review = await screen.findByRole('link', { name: 'Review Woolworths update' })
    expect(review.getAttribute('href')).toBe('#/sites/woolworths/versions/review')
    await user.click(screen.getByRole('button', { name: 'Show login window' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
  })

  it('puts the fix for a missing store and a missing login next to the line that asks for it', async () => {
    const fake = createFakeApi({ now: NOW })
    await fake.adapters.clearSetting('woolworths', 'store')
    renderAt(
      '#/sites',
      withAdapter(fake, (a) => (a.id === 'woolworths' ? { session: loggedIn } : {})),
    )
    const choose = await screen.findByRole('link', { name: 'Choose store…' })
    expect(choose.getAttribute('href')).toBe('#/sites/woolworths/store/store')
    expect(screen.getByText(/Choose your Woolworths store · calls wait until you do/)).toBeTruthy()
  })

  it('offers the login a site is missing', async () => {
    const fake = createFakeApi({ now: NOW })
    await fake.grants.revoke('woolworths', 'login')
    renderAt(
      '#/sites',
      withAdapter(fake, (a) => (a.id === 'woolworths' ? { session: loggedIn } : {})),
    )
    const choose = await screen.findByRole('link', { name: 'Choose Woolworths login…' })
    expect(choose.getAttribute('href')).toBe('#/sites/woolworths/login/login')
  })

  it('reviews a site that was never approved from its row', async () => {
    renderAt('#/sites', createFakeApi({ now: NOW, firstRun: true }))
    const review = await screen.findByRole('link', { name: 'Review Woolworths' })
    expect(review.getAttribute('href')).toBe('#/sites/woolworths/versions/review')
    expect(screen.getAllByText(/Not approved yet/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: 'Review Woolworths update' })).toBeNull()
  })

  it('pauses and resumes a site only when the main process can', async () => {
    const user = userEvent.setup()
    const api = withPause(createFakeApi({ now: NOW }))
    renderAt('#/sites', api)
    await user.click(await screen.findByRole('button', { name: 'Pause Woolworths' }))
    expect(api.pauses).toEqual([['woolworths', true]])
  })

  it('offers Resume for a paused site', async () => {
    const user = userEvent.setup()
    const api = withPause(createFakeApi({ now: NOW }), true)
    renderAt('#/sites', api)
    expect(await screen.findByText('Woolworths paused · calls are refused')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Resume Woolworths' }))
    expect(api.pauses).toEqual([['woolworths', false]])
  })

  it('says where sites come from when there are none', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites', { ...api, adapters: { ...api.adapters, list: async () => [] } })
    expect(await screen.findByText('No sites yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continue setup' }).getAttribute('href')).toBe('#/setup')
  })

  it('says so when the sites can’t load', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites', { ...api, adapters: { ...api.adapters, list: () => Promise.reject(new Error('x')) } })
    expect(await screen.findByText(/couldn’t load its sites/)).toBeTruthy()
  })
})

describe('a site’s Overview', () => {
  it('has the header, the tabs as addresses, and the update’s Review button on the page itself', async () => {
    renderAt('#/sites/woolworths', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Woolworths' })).toBeTruthy()
    expect(screen.getByText('woolworths 0.3.0')).toBeTruthy()
    expect(screen.getByText('0.4.0 waiting for review')).toBeTruthy()
    const tabs = within(screen.getByRole('navigation', { name: 'Woolworths sections' }))
    expect(tabs.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '#/sites/woolworths',
      '#/sites/woolworths/tools',
      '#/sites/woolworths/permissions',
      '#/sites/woolworths/versions',
    ])
    expect(tabs.getByRole('link', { name: /Overview/ }).getAttribute('aria-current')).toBe('page')

    expect(screen.getByText('Woolworths 0.4.0 is waiting for your review.')).toBeTruthy()
    expect(screen.getByText(/It adds 1 web address, 1 tool and 1 kind of request\./)).toBeTruthy()
    const reviews = screen.getAllByRole('link', { name: 'Review Woolworths update' })
    expect(reviews.length).toBe(2)
    for (const r of reviews) expect(r.getAttribute('href')).toBe('#/sites/woolworths/versions/review')
  })

  it('shows the login check with Show login window, the store, the login and today', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', api)
    expect(await screen.findByText('Waiting for your login')).toBeTruthy()
    expect(screen.getByText('Waiting for you to log in (verification check)')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show login window' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])

    const store = within(screen.getByTestId('setting-store'))
    expect(store.getByTestId('setting-chosen').textContent).toContain('Woolworths Town Hall')
    expect(store.getByRole('link', { name: 'Change store…' }).getAttribute('href')).toBe(
      '#/sites/woolworths/store/store',
    )
    expect(screen.getByRole('link', { name: 'Change…' }).getAttribute('href')).toBe(
      '#/sites/woolworths/login/login',
    )
    expect(screen.getAllByRole('link', { name: 'Woolworths' }).map((l) => l.getAttribute('href'))).toContain(
      '#/secrets/woolworths/login',
    )
    expect(screen.getByRole('link', { name: 'Calls that used it' }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths&login=woolworths%2Flogin',
    )
    await waitFor(() => expect(screen.getByText('Called by')).toBeTruthy())
    expect(screen.getByRole('link', { name: 'All calls' }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths',
    )
  })

  it('lists what a call can reach: tools to their calls, hosts as values, logins to their page', async () => {
    renderAt('#/sites/woolworths', createFakeApi({ now: NOW }))
    const reach = within(await screen.findByRole('region', { name: 'Can reach' }))
    expect(reach.getByRole('link', { name: 'Add to cart' }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths&tool=add_to_cart',
    )
    expect(reach.getByText('cdn0.woolworths.media')).toBeTruthy()
    expect(reach.getByRole('link', { name: 'Woolworths' }).getAttribute('href')).toBe(
      '#/secrets/woolworths/login',
    )
  })

  it('opens the trolley in the browser from the header and the card', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', api)
    const buttons = await screen.findAllByRole('button', { name: 'Open my trolley' })
    expect(buttons.length).toBe(2)
    await user.click(buttons[0] as HTMLElement)
    expect(called(api, 'adapters.openCart')).toEqual([['woolworths']])
    api.fake.failNext('adapters.openCart')
    await user.click(buttons[1] as HTMLElement)
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t open your trolley. Try again.')
  })

  it('takes back a login only after asking', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', api)
    await user.click(await screen.findByRole('button', { name: 'Take back login…' }))
    const dialog = within(await screen.findByRole('alertdialog'))
    expect(dialog.getByText(/Your 1Password item stays as it is/)).toBeTruthy()
    expect(called(api, 'grants.revoke')).toEqual([])
    await user.click(dialog.getByRole('button', { name: 'Take back login' }))
    await waitFor(() => expect(called(api, 'grants.revoke')).toEqual([['woolworths', 'login']]))
    expect(await screen.findByRole('link', { name: 'Choose login…' })).toBeTruthy()
  })

  it('has the More actions menu with calls, audit log, review and copy', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', api)
    await user.click(await screen.findByRole('button', { name: 'More actions for Woolworths' }))
    const menu = within(await screen.findByRole('menu'))
    expect(menu.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Show Woolworths calls',
      'Show in Audit log',
      'Review Woolworths update',
      'Copy adapter id',
      'Pause Woolworths',
    ])
    await user.click(menu.getByRole('menuitem', { name: 'Copy adapter id' }))
    expect(called(api, 'app.copyText')).toEqual([['woolworths']])
    await user.click(screen.getByRole('button', { name: 'More actions for Woolworths' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Show in Audit log' }))
    expect(window.location.hash).toBe('#/activity/audit?site=woolworths')
  })

  it('pauses a site from its header and its menu, and resumes it, when the main process can', async () => {
    const user = userEvent.setup()
    const api = withPause(createFakeApi({ now: NOW }))
    renderAt('#/sites/woolworths', api)
    await user.click(await screen.findByRole('button', { name: 'Pause site' }))
    await user.click(screen.getByRole('button', { name: 'More actions for Woolworths' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Pause Woolworths' }))
    expect(api.pauses).toEqual([
      ['woolworths', true],
      ['woolworths', true],
    ])
  })

  it('shows a paused site as Paused with Resume', async () => {
    const user = userEvent.setup()
    const api = withPause(createFakeApi({ now: NOW }), true)
    renderAt('#/sites/woolworths', api)
    expect(await screen.findByText('Paused')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Resume Woolworths' }))
    expect(api.pauses).toEqual([['woolworths', false]])
    expect(screen.queryByRole('button', { name: 'Pause site' })).toBeNull()
  })

  it('says a limited site resumes by itself, with the details a click away', async () => {
    const user = userEvent.setup()
    renderAt('#/sites/coles', createFakeApi({ now: NOW }))
    expect(await screen.findByText(/^Limited until/)).toBeTruthy()
    expect(screen.getByText(/nothing to do: calls start again by themselves/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Details' }))
    expect((await screen.findAllByText('www.coles.com.au')).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'blocked calls' }).getAttribute('href')).toBe(
      '#/activity/calls?site=coles&outcome=blocked',
    )
  })

  it('shows Messages senders, and a site with no trolley has no trolley button', async () => {
    renderAt('#/sites/coles', createFakeApi({ now: NOW }))
    expect(await screen.findByText('+61 400 000 111')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Choose…' }).getAttribute('href')).toBe(
      '#/sites/coles/login/messages',
    )
    expect(screen.queryByRole('button', { name: 'Open my trolley' })).toBeNull()
  })

  it('a site never approved: a Review button, and store and login wait for approval', async () => {
    renderAt('#/sites/woolworths', createFakeApi({ now: NOW, firstRun: true }))
    expect(await screen.findByText('Woolworths isn’t approved yet.')).toBeTruthy()
    expect(screen.getByText('Not approved yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review Woolworths' }).getAttribute('href')).toBe(
      '#/sites/woolworths/versions/review',
    )
    expect(screen.getByText(/It will ask for your Woolworths login and a store next/)).toBeTruthy()
    expect(screen.getByText('You choose a store after approving.')).toBeTruthy()
    expect(screen.getByText(/You choose a login after approving/)).toBeTruthy()
    expect(screen.getByText(/Agents can’t call Woolworths until it is approved/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open my trolley' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Review Woolworths update' })).toBeNull()
  })

  it('a version the person turned down says so, with a Review button', async () => {
    renderAt(
      '#/sites/coles',
      withAdapter(createFakeApi({ now: NOW }), (a) => (a.id === 'coles' ? { approval: 'rejected' } : {})),
    )
    expect(await screen.findByText('You turned down Coles 0.1.2.')).toBeTruthy()
    expect(screen.getByText('Turned down')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review Coles' })).toBeTruthy()
  })

  it('a site that needs no login says so', async () => {
    renderAt(
      '#/sites/coles',
      withAdapter(createFakeApi({ now: NOW }), (a) =>
        a.id === 'coles' ? { secretRequests: [], messages: [], secrets: [], messagesSources: [] } : {},
      ),
    )
    expect(await screen.findByText('Coles needs no login. Valet never signs in here.')).toBeTruthy()
  })

  it('a missing login: the health line and the card both offer it', async () => {
    const fake = createFakeApi({ now: NOW })
    await fake.grants.revoke('woolworths', 'login')
    renderAt(
      '#/sites/woolworths',
      withAdapter(fake, (a) => (a.id === 'woolworths' ? { session: loggedIn } : {})),
    )
    expect(await screen.findByText('Needs a login')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Choose Woolworths login…' }).getAttribute('href')).toBe(
      '#/sites/woolworths/login/login',
    )
    expect(screen.getByRole('link', { name: 'Choose login…' }).getAttribute('href')).toBe(
      '#/sites/woolworths/login/login',
    )
  })

  it('a missing store: the badge, the health line and the card', async () => {
    const fake = createFakeApi({ now: NOW })
    await fake.adapters.clearSetting('woolworths', 'store')
    renderAt(
      '#/sites/woolworths',
      withAdapter(fake, (a) => (a.id === 'woolworths' ? { session: loggedIn } : {})),
    )
    expect(await screen.findByText('Needs a store')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'Choose store…' }).length).toBe(2)
    expect(screen.getByText(/No store chosen, so Woolworths’s tools wait/)).toBeTruthy()
  })

  it('a site with no calls today says so, with the week’s calls as a link', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', { ...api, runs: { ...api.runs, list: async () => [] } })
    expect(await screen.findByText(/No calls yet today/)).toBeTruthy()
    expect(screen.getByRole('link', { name: '128 in the last 7 days' })).toBeTruthy()
  })

  it('says there is no such site, with a way back', async () => {
    renderAt('#/sites/nope', createFakeApi({ now: NOW }))
    expect(await screen.findByText('No site called “nope” is installed')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to Sites' }).getAttribute('href')).toBe('#/sites')
  })

  it('says so when the site can’t load', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', {
      ...api,
      adapters: { ...api.adapters, get: () => Promise.reject(new Error('x')) },
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Couldn’t load this site' })).toBeTruthy()
  })
})

describe('a site’s other tabs', () => {
  it('Tools: each tool’s title links to its calls, with its name, effect and the manifest’s words', async () => {
    renderAt('#/sites/woolworths/tools', createFakeApi({ now: NOW }))
    const table = within(await screen.findByRole('table', { name: 'Woolworths tools' }))
    const rows = table.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(6)
    expect(rows[3]?.textContent).toMatch(/Add to cartadd_to_cart.*“Adds a quantity.*”.*Changes.*14/)
    expect(table.getByRole('link', { name: 'Add to cart' }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths&tool=add_to_cart',
    )
    expect(table.getByRole('link', { name: '14 calls to Add to cart in 7 days' })).toBeTruthy()
    expect(screen.getByText(/Everyday Rewards balance arrives with 0\.4\.0/)).toBeTruthy()
    expect(
      screen.getByText('6 tools your apps can call. Any tool may make any request Woolworths declares;', {
        exact: false,
      }),
    ).toBeTruthy()
  })

  it('Tools: a setting’s own tool is marked as not exposed and left out of the count', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt(
      '#/sites/woolworths/tools',
      withAdapter(api, (a) =>
        a.id === 'woolworths'
          ? {
              tools: [
                ...a.tools,
                {
                  name: 'find_stores',
                  title: 'Find stores',
                  description: 'Lists stores.',
                  sideEffect: 'read' as const,
                  calls7d: 0,
                  internal: true,
                },
              ],
            }
          : {},
      ),
    )
    const row = (await screen.findByText('find_stores')).closest('tr') as HTMLElement
    expect(row.textContent).toContain('Settings only · not exposed')
    expect(within(row).queryByRole('link')).toBeNull()
    expect(screen.getByText(/^6 tools your apps can call/)).toBeTruthy()
  })

  it('Permissions: plain sentences, then every host, path and limit as a value', async () => {
    renderAt('#/sites/woolworths/permissions', createFakeApi({ now: NOW }))
    expect(await screen.findByText('What Woolworths can do')).toBeTruthy()
    expect(
      screen.getByText(/Contact 3 web addresses: www\.woolworths\.com\.au, cdn0\.woolworths\.media/),
    ).toBeTruthy()
    expect(screen.getByText(/Fill the login you give it, only on auth\.woolworths\.com\.au/)).toBeTruthy()
    expect(screen.getByText('Worked out by Valet from the declaration')).toBeTruthy()
    expect(screen.getByText('persist:auth:woolworths')).toBeTruthy()
    expect(screen.getByText(/requestsPerRun 6 · minGap 10 s/)).toBeTruthy()
    expect(screen.getByText('14 cookies · 0 storage keys')).toBeTruthy()
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(crumbs.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '#/sites',
      '#/sites/woolworths',
    ])
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe(
      'SitesWoolworthsPermissions',
    )
  })

  it('Versions: the waiting update with its Review button, then the live version and its hash', async () => {
    renderAt('#/sites/woolworths/versions', createFakeApi({ now: NOW }))
    const table = within(await screen.findByRole('table', { name: 'Woolworths adapter versions' }))
    const rows = table.getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(
        /0\.4\.0Waiting.*Authoring agent \(IDE\).*not yet.*asks on approve.*Review 0\.4\.0/,
      ),
      expect.stringMatching(/0\.3\.0Live.*Installed.*given.*128/),
    ])
    expect(table.getByRole('link', { name: 'Review 0.4.0' }).getAttribute('href')).toBe(
      '#/sites/woolworths/versions/review',
    )
  })

  it('Versions: a first install is one row with its own Review button', async () => {
    renderAt('#/sites/woolworths/versions', createFakeApi({ now: NOW, firstRun: true }))
    const table = within(await screen.findByRole('table', { name: 'Woolworths adapter versions' }))
    expect(
      table
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.textContent),
    ).toEqual([expect.stringMatching(/0\.3\.0Not approved yet.*not yet.*not given.*Review 0\.3\.0/)])
  })
})

// As test/no-secrets.test.tsx does for every screen: a main process that sends more than the
// contract names (a secret-shaped field on every object) must not get any of it onto these pages.
describe('no secret reaches a Sites page', () => {
  const CANARY = 'canary-7f3a91-SECRET'
  const LEAKY_KEYS = ['itemRef', 'token', 'password', 'value', 'cookieValue', 'plaintext', 'otp']
  const leak = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(leak)
    if (value === null || typeof value !== 'object') return value
    const copy: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) copy[key] = leak(inner)
    for (const key of LEAKY_KEYS) if (!Object.hasOwn(copy, key)) copy[key] = CANARY
    return copy
  }
  const leaky = (api: FakeApi): FakeApi => {
    const wrap = <T extends object>(group: T): T =>
      Object.fromEntries(
        Object.entries(group).map(([k, fn]) => [
          k,
          typeof fn === 'function'
            ? async (...args: unknown[]) => leak(await (fn as (...a: unknown[]) => Promise<unknown>)(...args))
            : fn,
        ]),
      ) as T
    return {
      ...api,
      adapters: wrap(api.adapters),
      approvals: wrap(api.approvals),
      grants: wrap(api.grants),
      runs: wrap(api.runs),
      clients: wrap(api.clients),
      health: wrap(api.health),
    }
  }
  for (const [hash, landmark] of [
    ['#/sites', 'Woolworths'],
    ['#/sites/woolworths', 'Called by'],
    ['#/sites/coles', '+61 400 000 111'],
    ['#/sites/woolworths/tools', 'add_to_cart'],
    ['#/sites/woolworths/permissions', 'persist:auth:woolworths'],
    ['#/sites/woolworths/versions', 'Live'],
    ['#/sites/woolworths/store/store', 'Choose your Woolworths store'],
  ] as const) {
    it(`renders ${hash} without fields it doesn't name`, async () => {
      renderAt(hash, leaky(createFakeApi({ now: NOW })))
      expect((await screen.findAllByText(landmark)).length).toBeGreaterThan(0)
      await waitFor(() => expect(document.body.textContent).not.toContain('Loading'))
      expect(document.documentElement.innerHTML).not.toContain(CANARY)
    })
  }
})

describe('the update banner’s summary', () => {
  it('says a tool changed when only a tool’s side effect did, never "nothing new"', async () => {
    const api = createFakeApi({ now: NOW })
    const review = (await api.approvals.pending()).find((r) => r.from !== null)
    if (review === undefined) throw new Error('no update in the fake')
    const before = {
      name: 'remove_from_cart',
      title: 'Remove from cart',
      destructive: true,
      idempotent: true,
    }
    const empty = { added: [], removed: [], unchanged: [] }
    const diff = {
      ...review.diff,
      ...Object.fromEntries(
        (
          [
            'navigation',
            'frameOrigins',
            'egress',
            'cookieDomains',
            'storage',
            'requests',
            'secrets',
            'secretFills',
            'authSteps',
            'messagesSources',
            'settings',
          ] as const
        ).map((k) => [k, empty]),
      ),
      tools: {
        added: [{ ...before, sideEffect: 'irreversible' as const }],
        removed: [{ ...before, sideEffect: 'write' as const }],
        unchanged: [],
      },
    }
    expect(updateSummary({ ...review, diff })).toBe('It changes 1 tool.')
    expect(updateSummary({ ...review, diff: { ...diff, tools: empty } })).toBe('It asks for nothing new.')
  })
})
