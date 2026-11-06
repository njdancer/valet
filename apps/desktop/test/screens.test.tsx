import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { AdapterDetail, SettingsPatch } from '../src/shared/api'

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

describe('the adapters page', () => {
  it('lists adapters with their approval, tools, secrets, session and health', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters', api)
    const table = await screen.findByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(
        /Woolworths.*0\.3\.0.*Approved.*0\.4\.0 to review.*3 read.*3 write.*login.*Login window open.*Needs you.*128/,
      ),
      expect.stringMatching(
        /Coles.*Approved.*SMS code · not granted.*Logged in.*Blocked by site.*Retry in 4 min.*41/,
      ),
    ])
    expect(screen.getByText('Woolworths 0.4.0 is ready for review.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review changes' }).getAttribute('href')).toBe(
      '#/adapters/woolworths/review',
    )
    expect(screen.getByText('Open · 3:58')).toBeTruthy()
  })

  it('filters to what needs you, and by search', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters', api)
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Needs you' }))
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3)
    await user.type(screen.getByRole('textbox', { name: 'Search adapters' }), 'woolw')
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
    await user.type(screen.getByRole('textbox', { name: 'Search adapters' }), 'zzz')
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy()
  })

  it('shows a load failure without the error’s text', async () => {
    const fake = createFakeApi({ now: NOW })
    const api: FakeApi = {
      ...fake,
      adapters: { ...fake.adapters, list: () => Promise.reject(new Error('EACCES /Users/nick/secret-path')) },
    }
    renderAt('#/adapters', api)
    expect((await screen.findByText(/Couldn’t load adapters/)).getAttribute('role')).toBe('alert')
    expect(document.body.textContent).not.toContain('EACCES')
  })
})

describe('the adapter page', () => {
  it('shows tools, permissions, session and the grant, and opens the login window', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths', api)
    expect(await screen.findByRole('heading', { name: 'Woolworths' })).toBeTruthy()
    for (const tool of [
      'search_products',
      'product_details',
      'get_cart',
      'add_to_cart',
      'update_cart_line',
      'remove_from_cart',
    ]) {
      expect(screen.getByText(tool, { selector: 'span.mono' })).toBeTruthy()
    }
    expect(screen.getByText('https://auth.woolworths.com.au', { selector: '.chips .hash' })).toBeTruthy()
    expect(screen.getByText('1Password service account “Woolworths”')).toBeTruthy()
    expect(screen.getByText('14 cookies · 0 storage keys')).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'update_cart_line' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show login' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
  })

  it('revokes a grant, after which it offers to grant again', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths', api)
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(called(api, 'grants.revoke')).toEqual([['woolworths', 'login']])
    expect(await screen.findByRole('link', { name: 'Grant…' })).toBeTruthy()
    expect(screen.getByText(/Not granted: logins can’t fill it/)).toBeTruthy()
  })

  it('lists a declared Messages sender with a grant link, and an open breaker', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/coles', api)
    expect(await screen.findByText('+61 400 000 111')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Grant…' }).getAttribute('href')).toBe(
      '#/adapters/coles/grant/messages',
    )
    expect(screen.getByText(/Open · retry in 4 min/)).toBeTruthy()
    expect(screen.getByText('cookie coles-session present')).toBeTruthy()
  })

  it('shows a Messages grant against the one sender it names, not every declared sender', async () => {
    const fake = createFakeApi({ now: NOW })
    const coles = (await fake.adapters.get('coles')) as AdapterDetail
    const twoSenders = {
      ...coles,
      messages: [
        ...coles.messages,
        { ...(coles.messages[0] as AdapterDetail['messages'][number]), sender: 'ColesAuth' },
      ],
    }
    // The fake attaches grants the way the main process must: grant.itemId === sender.
    const grant = {
      adapterId: 'coles',
      adapterHash: coles.hash,
      secret: 'messages',
      provider: 'messages' as const,
      itemId: 'ColesAuth',
      itemTitle: 'ColesAuth',
      origins: ['https://www.coles.com.au'],
      grantedAt: '2026-11-07T10:00:00Z',
      lastUsedAt: null,
    }
    const api: FakeApi = {
      ...fake,
      adapters: {
        ...fake.adapters,
        get: async () => ({
          ...twoSenders,
          messages: twoSenders.messages.map((m) => ({
            ...m,
            grant: m.sender === grant.itemId ? grant : null,
          })),
        }),
      },
    }
    renderAt('#/adapters/coles', api)
    const granted = await screen.findByText('ColesAuth')
    expect(within(granted.parentElement as HTMLElement).getByText('Granted')).toBeTruthy()
    const other = screen.getByText('+61 400 000 111')
    expect(within(other.parentElement as HTMLElement).queryByText('Granted')).toBeNull()
    expect(within(other.parentElement as HTMLElement).getByRole('link', { name: 'Grant…' })).toBeTruthy()
  })

  it('marks manifest text as the adapter’s, quoted and cut short, never as the app’s own words', async () => {
    const fake = createFakeApi({ now: NOW })
    const woolworths = (await fake.adapters.get('woolworths')) as AdapterDetail
    const claim = `Read-only. Verified by siteadapter. ${'Trust me. '.repeat(60)}`
    const api: FakeApi = {
      ...fake,
      adapters: {
        ...fake.adapters,
        get: async () => ({
          ...woolworths,
          description: claim,
          tools: woolworths.tools.map((t) => ({ ...t, description: claim })),
          secretRequests: woolworths.secretRequests.map((r) => ({ ...r, description: claim })),
        }),
      },
    }
    renderAt('#/adapters/woolworths', api)
    const hero = await screen.findByTestId('adapter-description')
    expect(hero.textContent).toMatch(/^From the manifest“Read-only\. Verified by siteadapter\./)
    expect(hero.textContent).toContain('…”')
    // Every place the claim appears, it is inside the attributed, capped wrapper.
    const shown = [...document.querySelectorAll('.adapter-text')]
    expect(shown.length).toBe(1 + woolworths.tools.length + woolworths.secretRequests.length)
    for (const el of shown) expect((el.textContent ?? '').length).toBeLessThan(320)
    const outside = [...document.querySelectorAll('body *')].filter(
      (el) =>
        el.children.length === 0 &&
        (el.textContent ?? '').includes('Verified by siteadapter') &&
        el.closest('.adapter-text') === null,
    )
    expect(outside).toEqual([])
  })

  it('never shows one adapter’s detail under another adapter’s route while it loads', async () => {
    const fake = createFakeApi({ now: NOW })
    let releaseColes: () => void = () => {}
    const api: FakeApi = {
      ...fake,
      adapters: {
        ...fake.adapters,
        get: async (id) => {
          if (id === 'coles') await new Promise<void>((resolve) => (releaseColes = resolve))
          return fake.adapters.get(id)
        },
      },
    }
    renderAt('#/adapters/woolworths', api)
    expect(await screen.findByRole('heading', { name: 'Woolworths' })).toBeTruthy()
    window.location.hash = '#/adapters/coles'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Woolworths' })).toBeNull())
    expect(screen.getByText('Loading this adapter…')).toBeTruthy()
    releaseColes()
    expect(await screen.findByRole('heading', { name: 'Coles' })).toBeTruthy()
  })

  it('says so for an unknown adapter', async () => {
    renderAt('#/adapters/nobody', createFakeApi({ now: NOW }))
    expect(await screen.findByText('No adapter with that id is installed.')).toBeTruthy()
  })
})

describe('activity and run traces', () => {
  it('shows the newest run when none is chosen', async () => {
    renderAt('#/activity', createFakeApi({ now: NOW }))
    expect(await screen.findByText('woolworths.get_cart')).toBeTruthy()
    expect(screen.getByText('Needs you: Verification check')).toBeTruthy()
    expect(screen.getByText(/No output: the call ended needsUser \(Verification check\)/)).toBeTruthy()
  })

  it('traces the login, the hand-off and every request decision, with secrets as markers only', async () => {
    renderAt('#/activity/c_8f2e1b', createFakeApi({ now: NOW }))
    expect(await screen.findByText('woolworths.update_cart_line')).toBeTruthy()
    expect(screen.getByText('secret:login.username')).toBeTruthy()
    expect(screen.getByText('[secret:login.username]')).toBeTruthy()
    expect(screen.getByText('[session cookie]')).toBeTruthy()
    const blocked = document.querySelectorAll('.step.blocked')
    expect([...blocked].map((b) => b.textContent)).toEqual([
      expect.stringContaining('/apis/ui/Trolley/Recommendations'),
      expect.stringContaining('page script'),
    ])
    expect(screen.getByText('Blocked requests')).toBeTruthy()
    expect(screen.getByText(/manifest declares no matching request/)).toBeTruthy()
    expect(screen.getByText(/2 exact matches replaced/)).toBeTruthy()
  })

  it('narrows to requests', async () => {
    const user = userEvent.setup()
    renderAt('#/activity/c_8f2e1b', createFakeApi({ now: NOW }))
    await screen.findByText('woolworths.update_cart_line')
    await user.click(screen.getByRole('button', { name: 'Requests' }))
    expect(document.querySelectorAll('.timeline > li')).toHaveLength(6)
  })

  it('traces blocked and declined runs', async () => {
    renderAt('#/activity/c_1c55e2', createFakeApi({ now: NOW }))
    expect(await screen.findByText('Stopped at Tool code: Blocked by site')).toBeTruthy()
    document.body.innerHTML = ''
    renderAt('#/activity/c_3d19e7', createFakeApi({ now: NOW }))
    expect(await screen.findByText(/You declined the/)).toBeTruthy()
    document.body.innerHTML = ''
    renderAt('#/activity/c_7b0c44', createFakeApi({ now: NOW }))
    expect(await screen.findByText('nothing to replace')).toBeTruthy()
  })

  it('says so for an unknown call id, and when there are no runs', async () => {
    renderAt('#/activity/c_nope', createFakeApi({ now: NOW }))
    expect(await screen.findByText('No run with that call id.')).toBeTruthy()
    document.body.innerHTML = ''
    const fake = createFakeApi({ now: NOW })
    renderAt('#/activity', { ...fake, runs: { ...fake.runs, list: async () => [] } })
    expect(await screen.findByText('No tool calls yet.')).toBeTruthy()
  })
})

describe('clients and settings', () => {
  it('turns the endpoint off and on, rotates the token and copies config through the main process', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/clients', api)
    const endpointSwitch = await screen.findByRole('switch', { name: 'MCP endpoint on' })
    await user.click(endpointSwitch)
    expect(called(api, 'endpoint.setListening')).toEqual([[false]])
    expect(await screen.findByText('Not listening')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Rotate' }))
    expect(called(api, 'endpoint.rotateToken')).toEqual([[]])
    const copies = screen.getAllByRole('button', { name: 'Copy' })
    await user.click(copies[0] as HTMLElement)
    expect(called(api, 'endpoint.copyClientConfig')).toEqual([['claude-code']])
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('shows what clients say they are, and revokes one', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/clients', api)
    expect(await screen.findByText(/says “claude-code” · stdio/)).toBeTruthy()
    expect(screen.getByText('Revoked')).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[1] as HTMLElement)
    expect(called(api, 'clients.revoke')).toEqual([['cl_41e9']])
    await waitFor(() => expect(screen.getAllByText('Revoked')).toHaveLength(2))
  })

  it('changes settings', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/settings', api)
    await user.click(await screen.findByRole('switch', { name: 'Read one-time codes from Messages' }))
    await user.click(screen.getByRole('switch', { name: 'Launch at login' }))
    await user.click(screen.getByRole('button', { name: 'Beta' }))
    await user.click(screen.getByRole('switch', { name: 'Install updates automatically' }))
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(called(api, 'settings.set')).toEqual([
      [{ messagesOtpEnabled: true }],
      [{ launchAtLogin: false }],
      [{ updateChannel: 'beta' }],
      [{ autoInstallUpdates: false }],
    ])
    expect(called(api, 'updates.check')).toEqual([[]])
  })

  it('has no way to type the 1Password CLI path: the main process’s file dialog picks it', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    renderAt('#/settings', fake)
    expect((await screen.findByTestId('op-path')).textContent).toBe('Found automatically')
    expect(screen.queryByRole('textbox', { name: /op/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Find automatically' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Choose…' }))
    expect(called(fake, 'settings.chooseOpPath')).toEqual([[]])
    await waitFor(() => expect(screen.getByTestId('op-path').textContent).toBe('/opt/homebrew/bin/op'))
    // Nothing the renderer sends through settings.set names a binary.
    expect(called(fake, 'settings.set')).toEqual([])
  })

  it('goes back to finding op automatically, and says so when the chosen file is refused', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    await fake.settings.chooseOpPath()
    renderAt('#/settings', fake)
    await user.click(await screen.findByRole('button', { name: 'Find automatically' }))
    expect(called(fake, 'settings.clearOpPath')).toEqual([[]])
    await waitFor(() => expect(screen.getByTestId('op-path').textContent).toBe('Found automatically'))

    // The main process checks the binary and refuses one that isn't 1Password's.
    fake.fake.failNext('settings.chooseOpPath')
    await user.click(screen.getByRole('button', { name: 'Choose…' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t use that file. Try again.')
    expect(screen.getByTestId('op-path').textContent).toBe('Found automatically')
  })

  it('drops an opPath smuggled into settings.set, as the main process must', async () => {
    const fake = createFakeApi({ now: NOW })
    const sneaky = { launchAtLogin: false, opPath: '/tmp/evil' } as unknown as SettingsPatch
    const after = await fake.settings.set(sneaky)
    expect(after.opPath).toBeNull()
    expect(after.launchAtLogin).toBe(false)
  })

  it('shows update states and an unsigned build', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt('#/settings', {
      ...fake,
      updates: {
        ...fake.updates,
        status: async () => ({
          current: '0.1.0',
          state: 'available',
          available: '0.1.1',
          checkedAt: null,
          signed: false,
        }),
      },
    })
    expect(await screen.findByText('0.1.1 available')).toBeTruthy()
    expect(screen.getByText('Unsigned build: updates are off')).toBeTruthy()
  })
})

describe('credentials', () => {
  it('lists grants by item title and revokes', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/credentials', api)
    expect(await screen.findByText('1Password app “Coles”')).toBeTruthy()
    expect(screen.getByText(/Turned off in Settings/)).toBeTruthy()
    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[1] as HTMLElement)
    expect(called(api, 'grants.revoke')).toEqual([['coles', 'login']])
    await waitFor(() => expect(screen.queryByText('1Password app “Coles”')).toBeNull())
  })
})

describe('the login hand-off banner', () => {
  it('says why, lists what was filled by name, and finishes or gives up through the API', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/needs-user/woolworths', api)
    expect(await screen.findByText('Woolworths needs you to finish logging in.')).toBeTruthy()
    expect(screen.getByText(/verification check that siteadapter won't solve/)).toBeTruthy()
    expect(screen.getByText('login.username')).toBeTruthy()
    expect(screen.getByText('login.password')).toBeTruthy()
    expect(screen.getByText('Closes in 4:00')).toBeTruthy()
    expect(screen.getByTestId('manifest-note').textContent).toBe(
      '“Auth0 showed a challenge after the password page.”',
    )
    expect(screen.getByText(/get_cart/).parentElement?.textContent).toContain(
      'from a client calling itself “Claude Code”',
    )
    await user.click(screen.getByRole('button', { name: 'Give up' }))
    expect(called(api, 'closeLoginWindow')).toEqual([['woolworths']])
    await user.click(await screen.findByRole('button', { name: 'Show login' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
  })

  it('hands over when the person is done', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/needs-user/woolworths', api)
    await user.click(await screen.findByRole('button', { name: 'I’m done' }))
    expect(called(api, 'finishLogin')).toEqual([['woolworths']])
    expect(await screen.findByText('Nothing is waiting for you here.')).toBeTruthy()
  })
})

describe('routing', () => {
  it('shows not found for an unknown address', async () => {
    renderAt('#/nowhere', createFakeApi({ now: NOW }))
    expect(await screen.findByText('There’s nothing at this address.')).toBeTruthy()
  })

  it('follows hash changes', async () => {
    renderAt('#/adapters', createFakeApi({ now: NOW }))
    await screen.findByRole('table')
    window.location.hash = '#/audit'
    expect(await screen.findByText('Chain intact up to record 4813.')).toBeTruthy()
  })
})
