import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'

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
    expect(screen.getByText('cookie coles-session')).toBeTruthy()
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
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(screen.getByRole('textbox', { name: 'Path to op' }), '/opt/homebrew/bin/op')
    await user.click(save)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(called(api, 'settings.set')).toEqual([
      [{ messagesOtpEnabled: true }],
      [{ launchAtLogin: false }],
      [{ updateChannel: 'beta' }],
      [{ autoInstallUpdates: false }],
      [{ opPath: '/opt/homebrew/bin/op' }],
    ])
    expect(called(api, 'updates.check')).toEqual([[]])
  })

  it('clears the op path back to automatic', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    await fake.settings.set({ opPath: '/usr/local/bin/op' })
    renderAt('#/settings', fake)
    await user.clear(await screen.findByRole('textbox', { name: 'Path to op' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(called(fake, 'settings.set').at(-1)).toEqual([{ opPath: null }])
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
      'Auth0 showed a challenge after the password page.',
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
    expect(await screen.findByText('Chain intact.')).toBeTruthy()
  })
})
