import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ClientPage } from '../src/renderer/screens/connections/ClientPage'
import { ConnectionsPage } from '../src/renderer/screens/connections/ConnectionsPage'
import { initials, reportedAs, toolSummary } from '../src/renderer/screens/connections/shared'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

const CLAUDE_CODE = 'c_c7d2a1b2c3d4e5f6'
const CLAUDE_DESKTOP = 'c_41e9a1b2c3d4e5f6'
const CURSOR = 'c_0b5aa1b2c3d4e5f6'

describe('connections', () => {
  it('turns the endpoint off at once, with Undo, and copies its address through the main process', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ConnectionsPage />)
    const endpoint = await screen.findByRole('switch', { name: 'Endpoint on' })
    await user.click(screen.getByRole('button', { name: 'Copy address' }))
    expect(called(api, 'endpoint.copyUrl')).toEqual([[]])
    await user.click(endpoint)
    expect(called(api, 'endpoint.setListening')).toEqual([[false]])
    expect(await screen.findByText('Not listening')).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(called(api, 'endpoint.setListening')).toEqual([[false], [true]]))
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull()
  })

  it('lists apps by the person’s name, with what they claim to be, and links each to its page and calls', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ConnectionsPage />)
    const table = within(await screen.findByRole('table', { name: 'Apps on this Mac' }))
    expect(table.getByRole('link', { name: 'Claude Code' }).getAttribute('href')).toBe(
      `#/connections/${CLAUDE_CODE}`,
    )
    expect(table.getByText(/calls itself “claude-code” · added/)).toBeTruthy()
    expect(table.getByRole('link', { name: '141 calls' }).getAttribute('href')).toBe(
      `#/activity/calls?client=${CLAUDE_CODE}`,
    )
    await waitFor(() => expect(table.getAllByText(/All \d+ tools on 2 sites/)).toHaveLength(2))
    // Revoked Cursor is history only, behind Show revoked.
    expect(table.queryByText('Cursor')).toBeNull()
    expect(screen.getByText(/1 revoked app \(Cursor\)/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show revoked' }))
    expect(table.getByRole('link', { name: 'Cursor' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide revoked' }).getAttribute('aria-expanded')).toBe('true')
    // Remote access is summarised, with the way to set it up.
    expect(screen.getByRole('link', { name: 'Set up remote access' }).getAttribute('href')).toBe(
      '#/connections/remote',
    )
    // The cloud agent asking to connect, with Approve… going to the code sheet.
    expect(screen.getByText('1 asking to connect')).toBeTruthy()
    expect(screen.getByText('None approved yet.')).toBeTruthy()
  })

  it('adds an app under the person’s name, shows its setup, copies through the main process, and ticks at its first call', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ConnectionsPage />)
    await user.click(await screen.findByRole('button', { name: 'Add an app…' }))
    const sheet = within(await screen.findByRole('dialog', { name: 'Add an app' }))
    const field = sheet.getByRole('textbox', { name: 'Name for the app' })
    await user.clear(field)
    expect(sheet.getByRole('button', { name: 'Add app' }).getAttribute('aria-disabled')).toBe('true')
    await user.type(field, 'Claude Code on the laptop{Enter}')
    expect(called(api, 'clients.add')).toEqual([['Claude Code on the laptop']])
    const setup = within(await screen.findByRole('dialog', { name: 'Set up Claude Code on the laptop' }))
    expect(await setup.findByText(/claude mcp add valet/)).toBeTruthy()
    const [id] = called(api, 'clients.snippets').at(-1) as [string]
    await user.click(setup.getByRole('button', { name: 'Copy command' }))
    expect(called(api, 'clients.copyConfig')).toEqual([[id, 'claude-code']])
    expect(await setup.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(setup.getByText('Waiting for Claude Code on the laptop’s first call…')).toBeTruthy()
    act(() => api.fake.clientSeen(id))
    expect(
      await setup.findByText('Claude Code on the laptop made its first call. It’s connected.'),
    ).toBeTruthy()
    expect(
      setup.getByRole('link', { name: 'Open Claude Code on the laptop’s page' }).getAttribute('href'),
    ).toBe(`#/connections/${id}`)
    await user.click(setup.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('says so when an app can’t be added', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.failNext('clients.add')
    renderPage(api, <ConnectionsPage />)
    await user.click(await screen.findByRole('button', { name: 'Add an app…' }))
    await user.click(screen.getByRole('button', { name: 'Add app' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t add the app. Try again.')
  })

  it('writes Claude Desktop’s config for an app, and says so plainly when it can’t', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    renderPage(fake, <ConnectionsPage />)
    await user.click(await screen.findByRole('button', { name: 'Add an app…' }))
    await user.click(screen.getByRole('button', { name: 'Add app' }))
    await user.click(await screen.findByRole('button', { name: 'Add to Claude Desktop' }))
    expect(await screen.findByText('Quit and reopen Claude Desktop to load Valet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Added to Claude Desktop' })).toBeTruthy()
  })

  it('leaves Claude Desktop’s config as it was when it can’t be read', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = {
      ...fake,
      clients: {
        ...fake.clients,
        addToClaudeDesktop: async () => {
          throw new Error('invalid')
        },
      },
    }
    renderPage(api, <ConnectionsPage />)
    await user.click(await screen.findByRole('button', { name: 'Add an app…' }))
    await user.click(screen.getByRole('button', { name: 'Add app' }))
    await user.click(await screen.findByRole('button', { name: 'Add to Claude Desktop' }))
    expect(
      await screen.findByText(/couldn’t update Claude Desktop’s config, and left it as it was/),
    ).toBeTruthy()
  })

  it('shows an empty state with the way to add the first app', async () => {
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderPage(api, <ConnectionsPage />)
    expect(await screen.findByText('No apps yet')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Add an app…' })).toHaveLength(2)
  })

  it('lists approved cloud agents, each linking to its page', async () => {
    const api = createFakeApi({ now: NOW })
    await api.remote.setHosts(['valet.example.com'])
    await api.remote.setEnabled(true)
    await api.remote.approveConsent('ABCD2345', ['woolworths.view_cart'])
    renderPage(api, <ConnectionsPage />)
    const agents = within(await screen.findByRole('table', { name: 'Cloud agents' }))
    expect(agents.getByRole('link', { name: 'claude.ai' }).getAttribute('href')).toBe(
      '#/connections/rcdemodemodemodemodemo',
    )
    expect(agents.getByText(/calls itself “Claude” · not verified/)).toBeTruthy()
    expect(screen.getByText('https://valet.example.com/mcp')).toBeTruthy()
    expect(screen.getByText('1 cloud agent approved')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Remote access settings' })).toBeTruthy()
  })
})

describe('an app’s page', () => {
  it('shows what it can reach, what it claims to be (not verified) and its calls', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ClientPage clientId={CLAUDE_CODE} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    const reach = within(await screen.findByRole('region', { name: 'Can reach' }))
    expect((await reach.findAllByRole('link', { name: /Woolworths/ }))[0]?.getAttribute('href')).toBe(
      '#/sites/woolworths/tools',
    )
    expect(reach.getByRole('link', { name: 'Woolworths login' }).getAttribute('href')).toBe(
      '#/secrets/woolworths/login',
    )
    expect(reach.getByText('auth.woolworths.com.au')).toBeTruthy()
    expect(screen.getByText('“claude-code”')).toBeTruthy()
    expect(screen.getByText('not verified')).toBeTruthy()
    expect(screen.getByText('Through the Valet bridge (stdio)')).toBeTruthy()
    expect(screen.getByRole('link', { name: '141 calls' }).getAttribute('href')).toBe(
      `#/activity/calls?client=${CLAUDE_CODE}`,
    )
  })

  it('asks before resetting access, with no Undo, and says the app has a new token', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ClientPage clientId={CLAUDE_CODE} />)
    await user.click(await screen.findByRole('button', { name: 'Reset access…' }))
    const dialog = within(screen.getByRole('alertdialog', { name: 'Reset Claude Code’s access?' }))
    expect(dialog.getByText(/can’t be undone/)).toBeTruthy()
    // Focus starts on the safe choice.
    expect(document.activeElement).toBe(dialog.getByRole('button', { name: 'Cancel' }))
    await user.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(called(api, 'clients.resetAccess')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Reset access…' }))
    await user.click(screen.getByRole('button', { name: 'Reset access' }))
    expect(called(api, 'clients.resetAccess')).toEqual([[CLAUDE_CODE]])
    expect((await screen.findAllByText(/Claude Code has a new token/)).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('asks before revoking, then shows it revoked with no way to reset', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ClientPage clientId={CLAUDE_DESKTOP} />)
    await user.click(await screen.findByRole('button', { name: 'Revoke…' }))
    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    expect(called(api, 'clients.revoke')).toEqual([[CLAUDE_DESKTOP]])
    expect(await screen.findByText('Revoked')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reset access…' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Can reach' })).toBeNull()
  })

  it('says so when the reset fails', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.failNext('clients.resetAccess')
    renderPage(api, <ClientPage clientId={CLAUDE_CODE} />)
    await user.click(await screen.findByRole('button', { name: 'Reset access…' }))
    await user.click(screen.getByRole('button', { name: 'Reset access' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t change Claude Code’s access. Try again.',
    )
  })

  it('opens its setup snippets', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ClientPage clientId={CLAUDE_CODE} />)
    await user.click(await screen.findByText('Show setup command'))
    expect(await screen.findByText(/claude mcp add valet/)).toBeTruthy()
    expect(called(api, 'clients.snippets')).toEqual([[CLAUDE_CODE]])
    await user.click(screen.getByRole('button', { name: 'Copy entry' }))
    expect(called(api, 'clients.copyConfig')).toEqual([[CLAUDE_CODE, 'claude-desktop']])
  })

  it('shows a revoked app as history, from its route', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt(`#/connections/${CURSOR}`, api)
    expect(await screen.findByRole('heading', { level: 1, name: 'Cursor' })).toBeTruthy()
    expect(screen.getByText(/It can’t call Valet/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke…' })).toBeNull()
  })

  it('says so for an id nobody has', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ClientPage clientId="c_nope" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to Connections' }).getAttribute('href')).toBe(
      '#/connections',
    )
  })
})

describe('a cloud agent’s page', () => {
  it('headlines its claimed host, scopes Can reach to its tools, and revokes after asking', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    await api.remote.setHosts(['valet.example.com'])
    await api.remote.approveConsent('ABCD2345', ['woolworths.get_cart', 'gone.old_tool'])
    renderPage(api, <ClientPage clientId="rcdemodemodemodemodemo" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'claude.ai' })).toBeTruthy()
    expect(screen.getByText(/Calls itself “Claude” \(not verified\)/)).toBeTruthy()
    expect(await screen.findByText('Woolworths: Get cart')).toBeTruthy()
    expect(screen.queryByText(/Woolworths: Add to cart/)).toBeNull()
    expect(screen.getByText('gone.old_tool')).toBeTruthy()
    expect(screen.getByText('valet.example.com')).toBeTruthy()
    const reach = within(screen.getByRole('region', { name: 'Can reach' }))
    expect(reach.getByText('1 tool · read only')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Revoke…' }))
    await user.click(screen.getByRole('button', { name: 'Revoke claude.ai' }))
    expect(called(api, 'remote.revokeClient')).toEqual([['rcdemodemodemodemodemo']])
    await waitFor(() => expect(window.location.hash).toBe('#/connections'))
  })
})

describe('connection helpers', () => {
  it('words what a call can reach and what an app calls itself', () => {
    expect(initials('Claude Code')).toBe('CC')
    expect(initials('')).toBe('?')
    expect(reportedAs('claude-code')).toBe('claude-code')
    expect(reportedAs('Evil‮name')).toBe('Evilname')
    expect(
      toolSummary([
        { name: 'a', title: 'A', sideEffect: 'read' },
        { name: 'b', title: 'B', sideEffect: 'write' },
        { name: 'c', title: 'C', sideEffect: 'irreversible' },
      ]),
    ).toBe('3 tools · 2 change things · 1 asks you first')
  })
})
