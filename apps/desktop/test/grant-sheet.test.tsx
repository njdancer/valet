import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MESSAGES_SECRET as CORE_MESSAGES_SECRET } from '@valet/core'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { COLES_HASH, createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { MESSAGES_SECRET } from '../src/renderer/screens/sites/GrantSheet'
import type { AdapterDetail, GrantRequest, ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const LOGIN = '#/sites/woolworths/login/login'
const SHEET = 'Give Valet your Woolworths login'

function renderAt(hash: string, api: ValetApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TooltipProvider>
        <ControlPanel />
      </TooltipProvider>
    </ApiProvider>,
  )
}

function makes(api: FakeApi): GrantRequest[] {
  return api.fake.calls.filter((c) => c.method === 'grants.make').map((c) => c.args[0] as GrantRequest)
}

function checked(el: HTMLElement): boolean {
  return el.getAttribute('aria-checked') === 'true'
}

function disabled(button: HTMLElement): boolean {
  return button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled
}

/** The origin checkboxes, by row: the origin, its hint, ticked or not. */
function origins(dialog: HTMLElement): [string | null | undefined, boolean][] {
  return within(dialog)
    .getAllByRole('checkbox')
    .map((b) => [b.closest('[data-origin]')?.textContent, checked(b)])
}

/** The fake, but adapters.get answers with `change` applied to Woolworths: one thing differs. */
function withWoolworths(api: FakeApi, change: (detail: AdapterDetail) => AdapterDetail): FakeApi {
  const get = api.adapters.get
  return {
    ...api,
    adapters: {
      ...api.adapters,
      get: async (id) => {
        const detail = await get(id)
        return detail !== null && id === 'woolworths' ? change(detail) : detail
      },
    },
  }
}

describe('the grant sheet', () => {
  it('matches core’s reserved secret name for Messages', () => {
    expect(MESSAGES_SECRET).toBe(CORE_MESSAGES_SECRET)
  })

  it('offers exactly the origins the manifest requested, and grants for the installed hash', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(LOGIN, api)
    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await within(dialog).findByRole('checkbox')
    expect(origins(dialog)).toEqual([[expect.stringContaining('https://auth.woolworths.com.au'), true]])
    expect(within(dialog).getByRole('checkbox', { name: 'https://auth.woolworths.com.au' })).toBeTruthy()
    expect(dialog.textContent).not.toContain('https://www.woolworths.com.au')

    // The existing grant's item is pre-selected; the person picks another.
    await waitFor(() => expect(checked(within(dialog).getByRole('radio', { name: 'Woolworths' }))).toBe(true))
    await user.click(within(dialog).getByRole('radio', { name: /Woolworths Rewards/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Use this login' }))

    await waitFor(() =>
      expect(makes(api)).toEqual([
        {
          adapterId: 'woolworths',
          adapterHash: WOOLWORTHS_HASH,
          secret: 'login',
          provider: 'onepassword-service-account',
          itemRef: 'op-item-91fe',
          origins: ['https://auth.woolworths.com.au'],
        },
      ]),
    )
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
  })

  it('never offers or submits an origin an earlier grant had but the manifest no longer requests', async () => {
    const user = userEvent.setup()
    const api = withWoolworths(createFakeApi({ now: NOW }), (detail) => ({
      ...detail,
      secretRequests: detail.secretRequests.map((s) => ({
        ...s,
        origins: ['https://auth.woolworths.com.au', 'https://www.woolworths.com.au'],
        grant: {
          adapterId: 'woolworths',
          adapterHash: WOOLWORTHS_HASH,
          secret: 'login',
          provider: 'onepassword-service-account',
          itemId: 'op-item-7c2a',
          itemTitle: 'Woolworths',
          origins: ['https://evil.example', 'https://www.woolworths.com.au'],
          grantedAt: '2026-11-02T09:02:31Z',
          lastUsedAt: null,
        },
      })),
    }))
    renderAt(LOGIN, api)
    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await within(dialog).findAllByRole('checkbox')
    const boxes = within(dialog).getAllByRole('checkbox')
    expect(boxes.map(checked)).toEqual([false, true])
    expect(
      within(dialog)
        .getAllByRole('checkbox')
        .map((b) => b.closest('[data-origin]')?.getAttribute('data-origin')),
    ).toEqual(['https://auth.woolworths.com.au', 'https://www.woolworths.com.au'])
    expect(dialog.textContent).not.toContain('evil.example')

    // The earlier grant's item is re-selected by id once the vault list loads.
    await waitFor(() => expect(checked(within(dialog).getByRole('radio', { name: 'Woolworths' }))).toBe(true))
    await user.click(within(dialog).getByRole('button', { name: 'Use this login' }))
    await waitFor(() => expect(api.fake.calls.some((c) => c.method === 'grants.make')).toBe(true))
    expect(makes(api)[0]?.origins).toEqual(['https://www.woolworths.com.au'])
  })

  it('won’t grant with every origin unticked, and says why', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(LOGIN, api)
    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await user.click(await within(dialog).findByRole('radio', { name: /Woolworths Rewards/ }))
    await user.click(within(dialog).getByRole('checkbox'))
    const grant = within(dialog).getByRole('button', { name: 'Use this login' })
    expect(disabled(grant)).toBe(true)
    expect(grant.getAttribute('aria-description')).toBe('Tick at least one web address')
    await user.click(grant)
    expect(makes(api)).toEqual([])
  })

  it('won’t grant before an item is chosen, and says why', async () => {
    const api = createFakeApi({ now: NOW })
    // No earlier grant to pre-select.
    renderAt(
      LOGIN,
      withWoolworths(api, (d) => ({
        ...d,
        secretRequests: d.secretRequests.map((s) => ({ ...s, grant: null })),
      })),
    )
    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await within(dialog).findByRole('radio', { name: 'Woolworths' })
    const grant = within(dialog).getByRole('button', { name: 'Use this login' })
    expect(disabled(grant)).toBe(true)
    expect(grant.getAttribute('aria-description')).toBe('Choose a 1Password item first')
  })

  it('refuses secret names the manifest doesn’t request, including inherited property names', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'password']) {
      const api = createFakeApi({ now: NOW })
      renderAt(`#/sites/woolworths/login/${name}`, api)
      expect(
        await screen.findByText('This adapter’s manifest doesn’t ask for a secret with that name.'),
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Use this login' })).toBeNull()
      cleanup()
    }
  })

  it('says so for an adapter that isn’t installed, and closes', async () => {
    const user = userEvent.setup()
    renderAt('#/sites/nobody/login/login', createFakeApi({ now: NOW }))
    const dialog = await screen.findByRole('dialog', { name: 'Can’t choose a login here' })
    await waitFor(() => expect(dialog.textContent).toContain('No adapter with that id is installed.'))
    await user.click(within(dialog).getByRole('button', { name: 'Go back' }))
    await waitFor(() => expect(window.location.hash).toBe('#/sites/nobody'))
  })

  it('says so when the site’s logins can’t be loaded', async () => {
    const api = createFakeApi({ now: NOW })
    // The sidebar's Needs you count reads the providers too (for unfinished setup).
    api.fake.failNext('grants.providers', Number.POSITIVE_INFINITY)
    renderAt(LOGIN, api)
    expect(await screen.findByText(/Couldn’t load this site’s logins/)).toBeTruthy()
  })

  it('lists vault items by title only, even if the main process sends more', async () => {
    const fake = createFakeApi({ now: NOW })
    const api: FakeApi = {
      ...fake,
      grants: {
        ...fake.grants,
        vaultItems: async () =>
          [
            {
              id: 'op-1',
              title: 'Woolworths',
              username: 'canary-user@example.com',
              password: 'canary-pass-7731',
            },
          ] as never,
      },
    }
    renderAt(LOGIN, api)
    expect(await screen.findByRole('radio', { name: /Woolworths/ })).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('canary')
  })

  it('switches provider, lists that provider’s items and clears the chosen item', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(LOGIN, api)
    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await waitFor(() => expect(checked(within(dialog).getByRole('radio', { name: 'Woolworths' }))).toBe(true))
    await user.click(within(dialog).getByRole('radio', { name: /1Password app/ }))
    await waitFor(() =>
      expect(api.fake.calls.filter((c) => c.method === 'grants.vaultItems').map((c) => c.args[0])).toContain(
        'onepassword-cli',
      ),
    )
    expect(disabled(within(dialog).getByRole('button', { name: 'Use this login' }))).toBe(true)
    await user.click(await within(dialog).findByRole('radio', { name: 'Woolworths' }))
    await user.click(within(dialog).getByRole('button', { name: 'Use this login' }))
    await waitFor(() => expect(makes(api)[0]?.provider).toBe('onepassword-cli'))
  })

  it('can’t pick a provider that isn’t set up, and links to where it is set up', async () => {
    const fake = createFakeApi({ now: NOW })
    const api: FakeApi = {
      ...fake,
      grants: {
        ...fake.grants,
        providers: async () => [
          { kind: 'onepassword-service-account', available: true, unavailableReason: null, grantCount: 1 },
          { kind: 'onepassword-cli', available: false, unavailableReason: 'not-installed', grantCount: 0 },
        ],
      },
    }
    renderAt(LOGIN, api)
    const cli = (await screen.findByRole('radio', { name: /1Password app/ })) as HTMLButtonElement
    expect(cli.disabled).toBe(true)
    // The CLI here, and the Keychain copy, which this list doesn't report at all.
    expect(screen.getAllByText('Not set up')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Secrets' }).getAttribute('href')).toBe('#/secrets')
  })

  it('says the vault couldn’t be listed when 1Password fails, with the way to fix it', async () => {
    const fake = createFakeApi({ now: NOW })
    fake.fake.failNext('grants.vaultItems')
    renderAt(LOGIN, fake)
    expect(await screen.findByText('Couldn’t list the vault. Is 1Password set up?')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Secrets' }).getAttribute('href')).toBe('#/secrets')
  })

  it('grants a Messages code source for the declared sender only', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/coles/login/messages', api)
    const dialog = await screen.findByRole('dialog', { name: 'Let Coles read one-time codes from Messages' })
    expect(within(dialog).getByRole('radio', { name: /\+61 400 000 111/ })).toBeTruthy()
    expect(within(dialog).getByText(/Messages codes are off in Secrets/)).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Turn on in Secrets' }).getAttribute('href')).toBe(
      '#/secrets',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Allow these codes' }))
    await waitFor(() =>
      expect(makes(api)).toEqual([
        {
          adapterId: 'coles',
          adapterHash: COLES_HASH,
          secret: 'messages',
          provider: 'messages',
          itemRef: '+61 400 000 111',
          origins: ['https://www.coles.com.au'],
        },
      ]),
    )
  })

  it('ticks the sign-in origin for Messages codes, not the first navigation origin', async () => {
    // Woolworths as it is: the shop on www, Auth0 on auth, the login typed on auth only. The e2e
    // suite found the sheet ticking www alone, a grant that failed every login at the code.
    const user = userEvent.setup()
    const api = withWoolworths(createFakeApi({ now: NOW }), (detail) => ({
      ...detail,
      navigation: ['https://www.woolworths.com.au', 'https://auth.woolworths.com.au'],
      messages: [
        {
          sender: 'Woolworths',
          maxAgeSeconds: 300,
          requestedOrigins: ['https://www.woolworths.com.au', 'https://auth.woolworths.com.au'],
          grant: null,
        },
      ],
    }))
    renderAt('#/sites/woolworths/login/messages', api)
    const dialog = await screen.findByRole('dialog', {
      name: 'Let Woolworths read one-time codes from Messages',
    })
    await within(dialog).findAllByRole('checkbox')
    expect(origins(dialog)).toEqual([
      [
        expect.stringMatching(/^https:\/\/www\.woolworths\.com\.au.*Leave off unless codes are typed here/),
        false,
      ],
      [expect.stringMatching(/^https:\/\/auth\.woolworths\.com\.au.*Where the sign-in form is/), true],
    ])
    await user.click(within(dialog).getByRole('button', { name: 'Allow these codes' }))
    await waitFor(() =>
      expect(makes(api).map((r) => r.origins)).toEqual([['https://auth.woolworths.com.au']]),
    )
  })

  it('ticks every navigation origin for Messages codes when no login secret says where sign-in is', async () => {
    const api = withWoolworths(createFakeApi({ now: NOW }), (detail) => ({
      ...detail,
      secretRequests: [],
      messages: [
        {
          sender: 'Woolworths',
          maxAgeSeconds: 300,
          requestedOrigins: ['https://www.woolworths.com.au', 'https://auth.woolworths.com.au'],
          grant: null,
        },
      ],
    }))
    renderAt('#/sites/woolworths/login/messages', api)
    const dialog = await screen.findByRole('dialog', {
      name: 'Let Woolworths read one-time codes from Messages',
    })
    await within(dialog).findAllByRole('checkbox')
    expect(origins(dialog).map(([, on]) => on)).toEqual([true, true])
  })

  it('has no Messages grant to make for an adapter that declares no SMS source', async () => {
    renderAt('#/sites/woolworths/login/messages', createFakeApi({ now: NOW }))
    expect(
      await screen.findByText('This adapter’s manifest doesn’t ask for a secret with that name.'),
    ).toBeTruthy()
  })

  it('shows a failed grant without its error text, and closes on Cancel or Escape', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(LOGIN, api)
    await user.click(await screen.findByRole('radio', { name: /Woolworths \(old\)/ }))
    api.fake.failNext('grants.make')
    await user.click(screen.getByRole('button', { name: 'Use this login' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t save the grant. Try again.')
    expect(document.body.textContent).not.toContain('fake grants.make failed')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))

    window.location.hash = LOGIN
    await screen.findByRole('dialog', { name: SHEET })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
  })

  it('re-selects the earlier grant’s item by id, not by a title two items share', async () => {
    const fake = createFakeApi({ now: NOW })
    const api: FakeApi = {
      ...fake,
      grants: {
        ...fake.grants,
        vaultItems: async () => [
          { id: 'op-item-dupe', title: 'Woolworths' },
          { id: 'op-item-7c2a', title: 'Woolworths' },
        ],
      },
    }
    renderAt(LOGIN, api)
    await waitFor(() => {
      const [first, second] = screen.getAllByRole('radio', { name: 'Woolworths' })
      expect([checked(first as HTMLElement), checked(second as HTMLElement)]).toEqual([false, true])
    })
  })

  it('moves focus into the sheet, hides the window behind, and gives focus back on close', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/sites/woolworths', api)
    const opener = (await screen.findAllByRole('link', { name: /Woolworths/ }))[0] as HTMLAnchorElement
    opener.focus()
    // What the "Choose login…" button does: the route changes and the sheet opens over the page.
    window.location.hash = LOGIN
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    const dialog = await screen.findByRole('dialog', { name: SHEET })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    // The page behind is hidden from assistive tech while the sheet is open.
    expect(screen.queryByRole('link', { name: opener.textContent ?? '' })).toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('moves the item choice with the arrow keys, as a radio group', async () => {
    const user = userEvent.setup()
    renderAt(LOGIN, createFakeApi({ now: NOW }))
    const first = await screen.findByRole('radio', { name: 'Woolworths' })
    await waitFor(() => expect(checked(first)).toBe(true))
    first.focus()
    // Held, as a person presses it: Radix moves focus on the next tick and selects while the key is down.
    await user.keyboard('{ArrowDown>}')
    const next = screen.getByRole('radio', { name: 'Woolworths Rewards' })
    await waitFor(() => expect(checked(next)).toBe(true))
    await user.keyboard('{/ArrowDown}')
    expect(document.activeElement).toBe(next)
    expect(checked(first)).toBe(false)
  })

  it('filters items by the search box', async () => {
    const user = userEvent.setup()
    renderAt(LOGIN, createFakeApi({ now: NOW }))
    await screen.findByRole('radio', { name: /Coles/ })
    expect(screen.getByText('4 items match')).toBeTruthy()
    await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'rewards')
    const items = within(screen.getByRole('radiogroup', { name: '1Password items' }))
    expect(items.getAllByRole('radio')).toHaveLength(1)
    expect(items.getByRole('radio', { name: 'Woolworths Rewards' })).toBeTruthy()
    expect(screen.getByText('1 item matches')).toBeTruthy()
    await user.type(screen.getByRole('searchbox', { name: 'Search items' }), 'zzz')
    expect(screen.getByText('No items match.')).toBeTruthy()
  })

  it('names the version it grants for, and links every use to the audit log', async () => {
    renderAt(LOGIN, createFakeApi({ now: NOW }))
    const dialog = await screen.findByRole('dialog', { name: SHEET })
    expect(within(dialog).getByText(/For Woolworths 0\.3\.0/)).toBeTruthy()
    expect(within(dialog).getByTitle(WOOLWORTHS_HASH)).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'audit log' }).getAttribute('href')).toBe(
      '#/activity/audit?category=secret-use&site=woolworths',
    )
  })
})
