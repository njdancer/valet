import { MESSAGES_SECRET as CORE_MESSAGES_SECRET } from '@siteadapter/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { COLES_HASH, createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { MESSAGES_SECRET } from '../src/renderer/screens/GrantSheet'
import type { AdapterDetail, GrantRequest, SiteAdapterApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: SiteAdapterApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ControlPanel />
    </ApiProvider>,
  )
}

function makes(api: FakeApi): GrantRequest[] {
  return api.fake.calls.filter((c) => c.method === 'grants.make').map((c) => c.args[0] as GrantRequest)
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
    renderAt('#/adapters/woolworths/grant/login', api)
    const dialog = await screen.findByRole('dialog', { name: 'Grant a secret' })
    const origins = await screen.findAllByRole('checkbox')
    expect(origins.map((o) => o.closest('label')?.textContent)).toEqual([
      expect.stringContaining('https://auth.woolworths.com.au'),
    ])
    expect(dialog.textContent).not.toContain('https://www.woolworths.com.au')

    // The existing grant's item is pre-selected; the person picks another.
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Woolworths' }) as HTMLInputElement).checked).toBe(true),
    )
    await user.click(screen.getByRole('radio', { name: /Woolworths Rewards/ }))
    await user.click(screen.getByRole('button', { name: 'Grant' }))

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
    await waitFor(() => expect(window.location.hash).toBe('#/adapters/woolworths'))
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
    renderAt('#/adapters/woolworths/grant/login', api)
    const boxes = (await screen.findAllByRole('checkbox')) as HTMLInputElement[]
    expect(boxes.map((b) => [b.closest('label')?.querySelector('.mono')?.textContent, b.checked])).toEqual([
      ['https://auth.woolworths.com.au', false],
      ['https://www.woolworths.com.au', true],
    ])
    expect(screen.getByRole('dialog', { name: 'Grant a secret' }).textContent).not.toContain('evil.example')

    // The earlier grant's item is re-selected by id once the vault list loads.
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Woolworths' }) as HTMLInputElement).checked).toBe(true),
    )
    await user.click(screen.getByRole('button', { name: 'Grant' }))
    await waitFor(() => expect(api.fake.calls.some((c) => c.method === 'grants.make')).toBe(true))
    const request = api.fake.calls.find((c) => c.method === 'grants.make')?.args[0] as GrantRequest
    expect(request.origins).toEqual(['https://www.woolworths.com.au'])
  })

  it('won’t grant with every origin unticked', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/grant/login', api)
    await user.click(await screen.findByRole('radio', { name: /Woolworths Rewards/ }))
    await user.click(screen.getByRole('checkbox'))
    const grant = screen.getByRole('button', { name: 'Grant' }) as HTMLButtonElement
    expect(grant.disabled).toBe(true)
    await user.click(grant)
    expect(makes(api)).toEqual([])
  })

  it('refuses secret names the manifest doesn’t request, including inherited property names', async () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'password']) {
      const api = createFakeApi({ now: NOW })
      renderAt(`#/adapters/woolworths/grant/${name}`, api)
      expect(
        await screen.findByText('This adapter’s manifest doesn’t ask for a secret with that name.'),
      ).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Grant' })).toBeNull()
      document.body.innerHTML = ''
    }
  })

  it('says so for an adapter that isn’t installed', async () => {
    renderAt('#/adapters/nobody/grant/login', createFakeApi({ now: NOW }))
    const dialog = await screen.findByRole('dialog', { name: 'Grant a secret' })
    await waitFor(() => expect(dialog.textContent).toContain('No adapter with that id is installed.'))
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
    renderAt('#/adapters/woolworths/grant/login', api)
    expect(await screen.findByRole('radio', { name: /Woolworths/ })).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('canary')
  })

  it('switches provider, lists that provider’s items and clears the chosen item', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/grant/login', api)
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Woolworths' }) as HTMLInputElement).checked).toBe(true),
    )
    await user.click(screen.getByRole('radio', { name: /1Password app/ }))
    await waitFor(() =>
      expect(api.fake.calls.filter((c) => c.method === 'grants.vaultItems').map((c) => c.args[0])).toContain(
        'onepassword-cli',
      ),
    )
    expect((screen.getByRole('button', { name: 'Grant' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(await screen.findByRole('radio', { name: 'Woolworths' }))
    await user.click(screen.getByRole('button', { name: 'Grant' }))
    await waitFor(() => expect(makes(api)[0]?.provider).toBe('onepassword-cli'))
  })

  it('can’t pick a provider that isn’t set up', async () => {
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
    renderAt('#/adapters/woolworths/grant/login', api)
    const cli = (await screen.findByRole('radio', { name: /1Password app/ })) as HTMLInputElement
    expect(cli.disabled).toBe(true)
    expect(screen.getByText('Not set up')).toBeTruthy()
  })

  it('says the vault couldn’t be listed when 1Password fails', async () => {
    const fake = createFakeApi({ now: NOW })
    fake.fake.failNext('grants.vaultItems')
    renderAt('#/adapters/woolworths/grant/login', fake)
    expect(await screen.findByText('Couldn’t list the vault. Is 1Password set up?')).toBeTruthy()
  })

  it('grants a Messages code source for the declared sender only', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/coles/grant/messages', api)
    expect(await screen.findByText('Let Coles read one-time codes from Messages')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /\+61 400 000 111/ })).toBeTruthy()
    expect(screen.getByText(/Messages codes are off in Settings/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Grant' }))
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

  it('has no Messages grant to make for an adapter that declares no SMS source', async () => {
    renderAt('#/adapters/woolworths/grant/messages', createFakeApi({ now: NOW }))
    expect(
      await screen.findByText('This adapter’s manifest doesn’t ask for a secret with that name.'),
    ).toBeTruthy()
  })

  it('shows a failed grant without its error text, and closes on Cancel or Escape', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/grant/login', api)
    await user.click(await screen.findByRole('radio', { name: /Woolworths \(old\)/ }))
    api.fake.failNext('grants.make')
    await user.click(screen.getByRole('button', { name: 'Grant' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t save the grant. Try again.')
    expect(document.body.textContent).not.toContain('fake grants.make failed')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(window.location.hash).toBe('#/adapters/woolworths'))

    window.location.hash = '#/adapters/woolworths/grant/login'
    await screen.findByRole('dialog', { name: 'Grant a secret' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.location.hash).toBe('#/adapters/woolworths'))
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
    renderAt('#/adapters/woolworths/grant/login', api)
    await waitFor(() => {
      const [first, second] = screen.getAllByRole('radio', { name: 'Woolworths' }) as HTMLInputElement[]
      expect([first?.checked, second?.checked]).toEqual([false, true])
    })
  })

  it('moves focus into the sheet, keeps the window behind inert, and gives focus back on close', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/coles', api)
    const opener = (await screen.findAllByRole('link', { name: 'Grant…' }))[0] as HTMLAnchorElement
    opener.focus()
    // What a click on the link does: the route changes and the sheet opens over the page.
    window.location.hash = opener.getAttribute('href') as string
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    const dialog = await screen.findByRole('dialog', { name: 'Grant a secret' })
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    const behind = document.querySelector('.window > .body') as HTMLElement
    expect(behind.hasAttribute('inert')).toBe(true)
    expect(behind.contains(opener)).toBe(true)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(behind.hasAttribute('inert')).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('moves the item choice with the arrow keys, as a radio group', async () => {
    const user = userEvent.setup()
    renderAt('#/adapters/woolworths/grant/login', createFakeApi({ now: NOW }))
    const first = (await screen.findByRole('radio', { name: 'Woolworths' })) as HTMLInputElement
    await waitFor(() => expect(first.checked).toBe(true))
    first.focus()
    await user.keyboard('{ArrowDown}')
    const next = screen.getByRole('radio', { name: 'Woolworths Rewards' }) as HTMLInputElement
    expect(next.checked).toBe(true)
    expect(document.activeElement).toBe(next)
    expect(first.checked).toBe(false)
  })

  it('filters items by the search box', async () => {
    const user = userEvent.setup()
    renderAt('#/adapters/woolworths/grant/login', createFakeApi({ now: NOW }))
    await screen.findByRole('radio', { name: /Coles/ })
    await user.type(screen.getByRole('textbox', { name: 'Search items' }), 'rewards')
    const items = within(screen.getByRole('radiogroup', { name: '1Password items' }))
    expect(items.getAllByRole('radio').map((o) => o.closest('label')?.textContent)).toEqual([
      'WWoolworths Rewards',
    ])
    await user.type(screen.getByRole('textbox', { name: 'Search items' }), 'zzz')
    expect(screen.getByText('No items match.')).toBeTruthy()
  })
})
