import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_NEXT_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { resumeStep, type SetupFacts, setupClient, stepsDone } from '../src/renderer/screens/Setup'
import type { ClientInfo, GrantRequest, ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const WOW_AUTH = 'https://auth.woolworths.com.au'

function renderAt(hash: string, api: ValetApi) {
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

async function heading(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name })
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Setup steps' })
}

describe('first-run setup', () => {
  it('walks a first launch through 1Password, approval, the login grant and both clients', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup', api)

    // Nothing is done, so setup opens at the welcome.
    await heading('Let your AI tools use websites, not your passwords')
    expect(
      within(rail())
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual([
      '1WelcomeWhat Valet does',
      '21PasswordWhere logins come from',
      '3Approve the adapterWhat it may do',
      '4Grant its loginWhich item it may use',
      '5Connect ClaudeClaude Code, Claude Desktop',
    ])
    await user.click(screen.getByRole('link', { name: 'Continue' }))

    // 1Password: nothing reachable yet. Setting it up shows it ready, and the step done.
    await heading('Where logins come from')
    expect(screen.getByText(/Valet can’t reach 1Password yet/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Skip for now' }).className).not.toContain('primary')
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
    api.fake.setProviderAvailable('onepassword-cli', true)
    await screen.findByText(/1Password app is ready/)
    expect(screen.getByRole('link', { name: 'Continue' })).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Continue' }))

    // Approve: the manifest's permissions, then the app's own review screen.
    await heading('Approve the Woolworths adapter')
    const summary = document.querySelector('.setup-perms')?.textContent ?? ''
    expect(summary).toContain('www.woolworths.com.au')
    expect(summary).toContain('auth.woolworths.com.au')
    expect(summary).toMatch(/3 read.*3 write.*0 irreversible/)
    expect(summary).toMatch(/login.*username, password, typed only on.*auth\.woolworths\.com\.au/)
    await user.click(screen.getByRole('link', { name: 'Review Woolworths 0.3.0…' }))
    await screen.findByRole('button', { name: 'Approve 0.3.0' })
    expect(window.location.hash).toBe('#/setup/approve/review')
    // Setup's next step is the grant, so the review doesn't offer its own "grant next".
    expect(screen.queryByText(/opens the grant sheet/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve 0.3.0' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('checkbox', { name: 'I’ve read the highlighted additions' }))
    await user.click(screen.getByRole('button', { name: 'Approve 0.3.0' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/grant'))
    expect(called(api, 'approvals.approve')).toEqual([['woolworths', WOOLWORTHS_NEXT_HASH]])

    // Grant: the app's grant sheet, offering only the sign-in origin, and back to setup.
    await heading('Let Woolworths use your login')
    expect(screen.getByText(/Not granted\. Typed only on/)).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Choose an item…' }))
    const sheet = await screen.findByRole('dialog', { name: 'Grant a secret' })
    expect(window.location.hash).toBe('#/setup/grant/login')
    const origins = await within(sheet).findAllByRole('checkbox')
    expect(origins.map((o) => o.closest('label')?.textContent)).toEqual([expect.stringContaining(WOW_AUTH)])
    expect(sheet.textContent).not.toContain('https://www.woolworths.com.au')
    await user.click(await within(sheet).findByRole('radio', { name: 'Woolworths' }))
    await user.click(within(sheet).getByRole('button', { name: 'Grant' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/grant'))
    const grants = called(api, 'grants.make').map((c) => c[0] as GrantRequest)
    expect(grants).toEqual([
      {
        adapterId: 'woolworths',
        adapterHash: WOOLWORTHS_NEXT_HASH,
        secret: 'login',
        provider: 'onepassword-cli',
        itemRef: 'op-item-7c2a',
        origins: [WOW_AUTH],
      },
    ])
    await screen.findByText(/Uses “Woolworths” from 1Password app, typed only on/)
    expect(screen.getByRole('link', { name: 'Change…' })).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Continue' }))

    // Clients: each is added with its own token, and its setup copied by the main process.
    await heading('Connect Claude')
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:47821\/mcp/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish without a client' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Add Claude Code' }))
    const code = await screen.findByText(/^claude mcp add valet/)
    expect(code.tagName).toBe('PRE')
    await user.click(screen.getByRole('button', { name: 'Add Claude Desktop' }))
    await screen.findByText(/"mcpServers"/)
    const added = (await api.clients.list()) as ClientInfo[]
    expect(added.map((c) => c.name)).toEqual(['Claude Code', 'Claude Desktop'])
    const [copyCode, copyDesktop] = screen.getAllByRole('button', { name: 'Copy' })
    await user.click(copyCode as HTMLElement)
    await user.click(copyDesktop as HTMLElement)
    expect(called(api, 'clients.copyConfig')).toEqual([
      [added[0]?.id, 'claude-code'],
      [added[1]?.id, 'claude-desktop'],
    ])
    expect(screen.getAllByRole('button', { name: 'Copied' })).toHaveLength(2)
    // Or Valet writes Claude Desktop's config itself, keeping a copy of the old one.
    await user.click(screen.getByRole('button', { name: 'Add to Claude Desktop' }))
    expect(called(api, 'clients.addToClaudeDesktop')).toEqual([[added[1]?.id]])
    expect(await screen.findByText(/Quit and reopen Claude Desktop to load Valet/)).toBeTruthy()
    expect(screen.getByText('claude_desktop_config.json.valet-backup-20261107T214800Z')).toBeTruthy()
    expect(screen.getAllByText('Not connected yet')).toHaveLength(2)
    // Added and copied isn't connected: the step isn't done until a client calls in.
    expect(within(rail()).getAllByText('Done')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy()
    api.fake.clientSeen(added[0]?.id ?? '')
    await screen.findByText('Connected')

    // Every step reads as done, and finishing records it and opens the adapters page.
    expect(within(rail()).getAllByText('Done')).toHaveLength(4)
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(window.location.hash).toBe('#/adapters'))
    expect(called(api, 'setup.finish')).toEqual([[]])
    expect((await api.setup.status()).completedAt).toBe(new Date(NOW).toISOString())
  })

  it('takes the 1Password account for the Keychain copy, which makes the step done (D6)', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/onepassword', api)
    await heading('Where logins come from')
    // Only the Keychain copy is offered: providers this launch can't use aren't listed as steps.
    expect(screen.getByText('Copy in your Keychain')).toBeTruthy()
    expect(screen.queryByText('1Password service account')).toBeNull()
    expect(screen.getByText('Not set up')).toBeTruthy()
    expect(screen.getByText(/Valet can’t reach 1Password yet/)).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: '1Password account' }), '  my.1password.com ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/Copy in your Keychain is ready\. .*approve the copy in 1Password\./)
    expect(called(api, 'settings.set')).toEqual([[{ onePasswordAccount: 'my.1password.com' }]])
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continue' })).toBeTruthy()
  })

  it('says so when saving the account fails', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/onepassword', api)
    await heading('Where logins come from')
    api.fake.failNext('settings.set')
    await user.type(screen.getByRole('textbox', { name: '1Password account' }), 'my.1password.com')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Couldn’t save the account. Try again.')
  })

  it('resumes at the first step not done, and goes back a step', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    // A provider that was ready before setup started doesn't skip the welcome.
    api.fake.setProviderAvailable('onepassword-cli', true)
    renderAt('#/setup', api)
    await heading(/^Let your AI tools/)
    expect(screen.queryByRole('link', { name: 'Back' })).toBeNull()
    cleanup()

    await api.approvals.approve('woolworths', WOOLWORTHS_NEXT_HASH)
    renderAt('#/setup', api)
    await heading('Let Woolworths use your login')
    await user.click(screen.getByRole('link', { name: 'Back' }))
    await heading('Approve the Woolworths adapter')
    await screen.findByText(/is approved\. Its tools are on MCP\./)
    await user.click(screen.getByRole('link', { name: 'Back' }))
    await heading('Where logins come from')
  })

  it('asks for the approval before the grant, and the review’s Close goes back to setup', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/grant', api)
    await heading('Let Woolworths use your login')
    expect(screen.getByText(/Approve Woolworths first/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Choose an item…' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Go to approval' }))
    await heading('Approve the Woolworths adapter')
    await user.click(screen.getByRole('link', { name: /^Review Woolworths/ }))
    await screen.findByRole('button', { name: 'Approve 0.3.0' })
    await user.click(screen.getByRole('link', { name: 'Close' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/approve'))
  })

  it('rejecting the adapter goes back to setup, which says its tools stay off', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/approve/review', api)
    await user.click(await screen.findByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/approve'))
    await screen.findByText('Nothing is waiting for review.')
  })

  it('a grant sheet opened from setup closes back to setup', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/grant/login', api)
    await screen.findByRole('dialog', { name: 'Grant a secret' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.location.hash).toBe('#/setup/grant'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('skipping records setup as finished, so later launches don’t open it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/onepassword', api)
    await heading('Where logins come from')
    await user.click(screen.getByRole('button', { name: 'Skip setup' }))
    await waitFor(() => expect(window.location.hash).toBe('#/adapters'))
    expect(called(api, 'setup.finish')).toEqual([[]])
  })

  it('says so when finishing fails, and stays on setup', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/clients', api)
    await heading('Connect Claude')
    api.fake.failNext('setup.finish')
    await user.click(screen.getByRole('button', { name: 'Finish without a client' }))
    await screen.findByText('Couldn’t finish setup. Try again.')
    expect(window.location.hash).toBe('#/setup/clients')
    api.fake.failNext('clients.add')
    await user.click(screen.getByRole('button', { name: 'Add Claude Code' }))
    await screen.findByText('Couldn’t add Claude Code. Try again.')
  })

  it('on an app already in use, every step reads as done and setup resumes at the last', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup', api)
    await heading('Connect Claude')
    // Its clients exist already: their setup is shown, not an Add button.
    await screen.findByText(/^claude mcp add valet/)
    expect(screen.queryByRole('button', { name: /^Add Claude/ })).toBeNull()
    expect(screen.getAllByText('Connected')).toHaveLength(2)
    expect(within(rail()).getAllByText('Done')).toHaveLength(4)
  })

  it('shows the approved adapter and an update waiting for review', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/approve', api)
    await heading('Approve the Woolworths adapter')
    expect(screen.getByRole('link', { name: 'Review Woolworths 0.4.0…' })).toBeTruthy()
    expect(screen.getByText('0.3.0 stays approved until you decide on 0.4.0.')).toBeTruthy()
  })

  it('shows a load failure without the error’s text', async () => {
    const fake = createFakeApi({ now: NOW, firstRun: true })
    const api: ValetApi = {
      ...fake,
      clients: { ...fake.clients, list: () => Promise.reject(new Error('secret path /Users/x')) },
    }
    renderAt('#/setup', api)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Couldn’t load setup. Valet will try again when something changes.')
  })

  it('without a bundled adapter, says there is nothing to approve or grant', async () => {
    const fake = createFakeApi({ now: NOW, firstRun: true })
    const api: ValetApi = { ...fake, adapters: { ...fake.adapters, get: async () => null } }
    renderAt('#/setup/approve', api)
    await heading('No adapter to set up')
    window.location.hash = '#/setup/grant'
    await heading('No adapter to set up')
  })

  it('without a bridge, a client’s card says it can’t be set up from here', async () => {
    const fake = createFakeApi({ now: NOW })
    const api: ValetApi = { ...fake, clients: { ...fake.clients, snippets: async () => [] } }
    renderAt('#/setup/clients', api)
    expect(
      await screen.findAllByText(/This build has no bridge to set Claude (Code|Desktop) up with\./),
    ).toHaveLength(2)
  })

  it('says when the endpoint is off', async () => {
    const api = createFakeApi({ now: NOW, firstRun: true })
    await api.endpoint.setListening(false)
    renderAt('#/setup/clients', api)
    await screen.findByText(/The MCP endpoint is off/)
  })
})

describe('setup’s step logic', () => {
  const facts = async (api: FakeApi): Promise<SetupFacts> => ({
    providers: await api.grants.providers(),
    adapter: await api.adapters.get('woolworths'),
    review: (await api.approvals.pending())[0] ?? null,
    clients: await api.clients.list(),
    endpoint: await api.endpoint.status(),
    settings: await api.settings.get(),
  })

  it('a first launch has nothing done and starts at the welcome', async () => {
    const done = stepsDone(await facts(createFakeApi({ now: NOW, firstRun: true })))
    expect(done).toEqual({ welcome: false, onepassword: false, approve: false, grant: false, clients: false })
    expect(resumeStep(done)).toBe('welcome')
  })

  it('a grant for another hash, or a revoked client, doesn’t count', async () => {
    const api = createFakeApi({ now: NOW, firstRun: true })
    const added = await api.clients.add('Claude Code')
    await api.clients.revoke(added.id)
    const f = await facts(api)
    expect(setupClient(f.clients, 'claude-code')).toBeNull()
    expect(stepsDone(f).clients).toBe(false)
    const approvedNoGrant = { ...f, adapter: f.adapter && { ...f.adapter, approval: 'approved' as const } }
    expect(stepsDone(approvedNoGrant).grant).toBe(false)
    expect(stepsDone({ ...f, adapter: null }).approve).toBe(false)
  })

  it('an approved adapter that asks for no secrets has nothing left to grant', async () => {
    const f = await facts(createFakeApi({ now: NOW }))
    const noSecrets = { ...f, adapter: f.adapter && { ...f.adapter, secretRequests: [] } }
    expect(stepsDone(noSecrets).grant).toBe(true)
  })

  it('an adapter that reads SMS codes is not granted until the codes are too', async () => {
    const f = await facts(createFakeApi({ now: NOW }))
    if (f.adapter === null) throw new Error('no adapter')
    const login = f.adapter.secretRequests.map((r) => ({
      ...r,
      grant: { provider: 'fake', itemId: 'x', itemTitle: 'x', origins: r.origins, grantedAt: NOW } as never,
    }))
    const code = { sender: 'Woolworths', maxAgeSeconds: 300, requestedOrigins: [], grant: null }
    const adapter = { ...f.adapter, approval: 'approved' as const, secretRequests: login }
    expect(stepsDone({ ...f, adapter: { ...adapter, messages: [code] } }).grant).toBe(false)
    const granted = {
      ...code,
      grant: { provider: 'messages', itemId: 'Woolworths', itemTitle: 'Woolworths' } as never,
    }
    expect(stepsDone({ ...f, adapter: { ...adapter, messages: [granted] } }).grant).toBe(true)
    expect(stepsDone({ ...f, adapter: { ...adapter, messages: [] } }).grant).toBe(true)
  })

  it('an adapter with a required store is not granted until one is chosen', async () => {
    const f = await facts(createFakeApi({ now: NOW }))
    if (f.adapter === null) throw new Error('no adapter')
    const login = f.adapter.secretRequests.map((r) => ({
      ...r,
      grant: { provider: 'fake', itemId: 'x', itemTitle: 'x', origins: r.origins, grantedAt: NOW } as never,
    }))
    const store = {
      name: 'store',
      title: 'Store',
      description: 'd',
      required: true,
      queryLabel: 'Postcode',
      chosen: null,
    }
    const adapter = { ...f.adapter, approval: 'approved' as const, secretRequests: login, messages: [] }
    expect(stepsDone({ ...f, adapter: { ...adapter, settings: [store] } }).grant).toBe(false)
    expect(
      stepsDone({ ...f, adapter: { ...adapter, settings: [{ ...store, required: false }] } }).grant,
    ).toBe(true)
    const chosen = {
      ...store,
      chosen: { id: '1', label: 'x', detail: null, chosenAt: new Date(NOW).toISOString() },
    }
    expect(stepsDone({ ...f, adapter: { ...adapter, settings: [chosen] } }).grant).toBe(true)
  })

  it('resumes at the last step when everything is done', () => {
    expect(resumeStep({ welcome: true, onepassword: true, approve: true, grant: true, clients: true })).toBe(
      'clients',
    )
  })
})
