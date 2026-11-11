import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_NEXT_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import {
  resumeStep,
  type SetupFacts,
  setupClient,
  stepsDone,
} from '../src/renderer/screens/setup/setup-logic'
import type { ClientInfo, GrantRequest, ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const WOW_AUTH = 'https://auth.woolworths.com.au'

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

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

async function heading(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name })
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Setup steps' })
}

/** How many steps the step list marks done. */
function doneSteps(): number {
  return (rail().textContent ?? '').split('(done)').length - 1
}

/** Off with a reason: aria-disabled rather than disabled. */
function isOff(button: HTMLElement): boolean {
  return button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled
}

describe('first-run setup', () => {
  it('walks a first launch through 1Password, approval, the login grant and both clients', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup', api)

    // Nothing is done, so setup opens at the welcome.
    await heading('Let Claude shop at Woolworths for you')
    const railText = rail().textContent ?? ''
    for (const step of [
      'Welcome',
      '1Password',
      'Approve Woolworths',
      'Your login',
      'Your store',
      'Connect Claude',
      'Done',
    ])
      expect(railText).toContain(step)
    expect(doneSteps()).toBe(0)
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Get started' }))

    // 1Password: nothing reachable yet. Setting it up shows it ready, and the step done.
    await heading('Where your Woolworths password comes from')
    expect(screen.getByText(/Valet can’t reach 1Password yet/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Skip for now' }).className).not.toContain('bg-accent')
    expect(isOff(screen.getByRole('button', { name: 'Continue' }))).toBe(true)
    api.fake.setProviderAvailable('onepassword-cli', true)
    await screen.findByText(/1Password app is ready/)
    expect(screen.getByRole('link', { name: 'Continue' })).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Continue' }))

    // Approve: the manifest's permissions, then the app's own review screen.
    await heading('Approve Woolworths')
    const summary = screen.getByTestId('setup-perms').textContent ?? ''
    expect(summary).toContain('www.woolworths.com.au')
    expect(summary).toContain('auth.woolworths.com.au')
    expect(summary).toMatch(/3 read.*3 write.*0 irreversible/)
    expect(summary).toMatch(/login.*username, password, typed only on.*auth\.woolworths\.com\.au/)
    await user.click(screen.getByRole('link', { name: 'Review Woolworths 0.3.0…' }))
    await screen.findByRole('button', { name: 'Approve Woolworths' })
    expect(window.location.hash).toBe('#/setup/approve/review')
    // Setup's next step is the grant, so the review doesn't offer its own "grant next".
    expect(screen.queryByText(/opens the grant sheet/)).toBeNull()
    // A first install opens on a summary, with no tick box to tick first (D-review).
    expect(screen.getByTestId('first-install-summary')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve Woolworths' })).toHaveProperty('disabled', false)
    await user.click(screen.getByRole('button', { name: 'Approve Woolworths' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/grant'))
    expect(called(api, 'approvals.approve')).toEqual([['woolworths', WOOLWORTHS_NEXT_HASH]])

    // Grant: the app's grant sheet, offering only the sign-in origin, and back to setup.
    await heading('Your Woolworths login')
    expect(screen.getByText(/Not given yet\. Typed only on/)).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Choose an item…' }))
    const sheet = await screen.findByRole('dialog', { name: 'Give Valet your Woolworths login' })
    expect(window.location.hash).toBe('#/setup/grant/login')
    const origins = await within(sheet).findAllByRole('checkbox')
    expect(origins).toHaveLength(1)
    expect(sheet.textContent).toContain(new URL(WOW_AUTH).host)
    expect(sheet.textContent).not.toContain('https://www.woolworths.com.au')
    await user.click(await within(sheet).findByRole('radio', { name: 'Woolworths' }))
    await user.click(within(sheet).getByRole('button', { name: 'Use this login' }))
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

    // The store has its own step (D-setup); this account already has one chosen.
    await heading('Your Woolworths store')
    expect(screen.getByTestId('setup-settings')).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Continue' }))

    // Clients: each is added with its own token, and its setup copied by the main process.
    await heading('Connect Claude')
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:47821\/mcp/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Finish without an app' })).toBeTruthy()
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
    expect(doneSteps()).toBe(4)
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy()
    api.fake.clientSeen(added[0]?.id ?? '')
    await screen.findByText('Connected')

    // Every step is done (the current one is marked current), and finishing shows the done page.
    expect(doneSteps()).toBe(4)
    expect(rail().textContent).toContain('Claude Code')
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    await heading('You’re set up')
    expect(called(api, 'setup.finish')).toEqual([[]])
    expect(screen.queryByRole('link', { name: 'Do it now' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Open Valet' }).getAttribute('href')).toBe('#/sites')
    expect((await api.setup.status()).completedAt).toBe(new Date(NOW).toISOString())
  })

  it('takes the 1Password account for the Keychain copy, which makes the step done (D6)', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/onepassword', api)
    await heading('Where your Woolworths password comes from')
    // Only the Keychain copy is offered: providers this launch can't use aren't listed as steps.
    expect(screen.getByText('Copy in your Keychain')).toBeTruthy()
    expect(screen.queryByText('1Password service account')).toBeNull()
    expect(screen.getByText('Not set up')).toBeTruthy()
    expect(screen.getByText(/Valet can’t reach 1Password yet/)).toBeTruthy()
    await user.type(screen.getByRole('textbox', { name: '1Password account' }), '  my.1password.com ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Copy in your Keychain is ready.')
    expect(screen.getByText(/approve the copy in 1Password\./)).toBeTruthy()
    expect(called(api, 'settings.set')).toEqual([[{ onePasswordAccount: 'my.1password.com' }]])
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Continue' })).toBeTruthy()
  })

  it('says so when saving the account fails', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/onepassword', api)
    await heading('Where your Woolworths password comes from')
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
    await heading(/^Let Claude shop at/)
    expect(screen.queryByRole('link', { name: 'Back' })).toBeNull()
    cleanup()

    await api.approvals.approve('woolworths', WOOLWORTHS_NEXT_HASH)
    renderAt('#/setup', api)
    await heading('Your Woolworths login')
    await user.click(screen.getByRole('link', { name: 'Back' }))
    await heading('Approve Woolworths')
    await screen.findByText(/is approved\. Its tools are on MCP\./)
    await user.click(screen.getByRole('link', { name: 'Back' }))
    await heading('Where your Woolworths password comes from')
  })

  it('asks for the approval before the grant, and the review’s Close goes back to setup', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/grant', api)
    await heading('Your Woolworths login')
    expect(screen.getByText(/Approve Woolworths first/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Choose an item…' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'Go to approval' }))
    await heading('Approve Woolworths')
    await user.click(screen.getByRole('link', { name: /^Review Woolworths/ }))
    await screen.findByRole('button', { name: 'Approve Woolworths' })
    await user.click(screen.getByRole('link', { name: 'Close' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/approve'))
  })

  it('rejecting the adapter goes back to setup, which says its tools stay off', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/approve/review', api)
    await user.click(await screen.findByRole('button', { name: 'Don’t install' }))
    await waitFor(() => expect(window.location.hash).toBe('#/setup/approve'))
    await screen.findByText('Nothing is waiting for review.')
  })

  it('a grant sheet opened from setup closes back to setup', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/grant/login', api)
    await screen.findByRole('dialog', { name: 'Give Valet your Woolworths login' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.location.hash).toBe('#/setup/grant'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('finishing later records setup as finished, so later launches don’t open it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/onepassword', api)
    await heading('Where your Woolworths password comes from')
    await user.click(screen.getByRole('button', { name: 'Finish later' }))
    await waitFor(() => expect(window.location.hash).toBe('#/sites'))
    expect(called(api, 'setup.finish')).toEqual([[]])
  })

  it('finishing with steps left shows what was skipped, each with a way back to it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/clients', api)
    await heading('Connect Claude')
    await user.click(screen.getByRole('button', { name: 'Finish without an app' }))
    await heading('Almost set up')
    const links = screen.getAllByRole('link', { name: 'Do it now' }).map((l) => l.getAttribute('href'))
    expect(links).toContain('#/setup/approve')
    expect(links).toContain('#/setup/clients')
    expect(called(api, 'setup.finish')).toEqual([[]])
  })

  it('says so when finishing fails, and stays on setup', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/clients', api)
    await heading('Connect Claude')
    api.fake.failNext('setup.finish')
    await user.click(screen.getByRole('button', { name: 'Finish without an app' }))
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
    // Every other step is done; this one is the current one.
    expect(doneSteps()).toBe(4)
    expect(rail().querySelector('[aria-current="step"]')?.textContent).toContain('Connect Claude')
  })

  it('shows the approved adapter and an update waiting for review', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/approve', api)
    await heading('Approve Woolworths')
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
    await heading('No site to set up')
    window.location.hash = '#/setup/grant'
    await heading('No site to set up')
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

describe('setup’s store step', () => {
  it('changes the chosen store: searches only on submit, lists what the site found, and saves the pick', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/store', api)
    await heading('Your Woolworths store')
    const settings = screen.getByTestId('setup-settings')
    expect(within(settings).getByTestId('setting-chosen')).toBeTruthy()
    expect(within(settings).getByText('Chosen')).toBeTruthy()
    await user.click(within(settings).getByRole('button', { name: /^Change store/ }))
    const search = within(settings).getByRole('button', { name: 'Search' })
    expect(search.getAttribute('aria-disabled')).toBe('true')
    await user.type(within(settings).getByRole('textbox'), '2000')
    expect(called(api, 'adapters.settingChoices')).toEqual([])
    await user.click(within(settings).getByRole('button', { name: 'Search' }))
    expect(await within(settings).findByText(/^Found by .+, through its adapter$/)).toBeTruthy()
    expect(called(api, 'adapters.settingChoices')).toEqual([['woolworths', 'store', '2000']])
    await user.click(within(settings).getByRole('button', { name: 'Choose Woolworths Metro Wynyard' }))
    await waitFor(() =>
      expect(called(api, 'adapters.setSetting')).toEqual([['woolworths', 'store', '9001245']]),
    )
    expect(await within(settings).findByText('Woolworths Metro Wynyard')).toBeTruthy()
    expect(within(settings).queryByRole('button', { name: 'Search' })).toBeNull()
  })

  it('Cancel leaves the store as it was', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/store', api)
    await heading('Your Woolworths store')
    await user.click(screen.getByRole('button', { name: /^Change store/ }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
    expect(called(api, 'adapters.setSetting')).toEqual([])
  })

  it.each([
    [
      { status: 'blocked', retryAt: new Date(NOW + 240_000).toISOString() },
      /The site is refusing or slowing Valet/,
    ],
    [{ status: 'not-approved' }, /isn’t approved, so it can’t search/],
    [{ status: 'site-changed' }, /The adapter may need an update/],
    [{ status: 'failed' }, /The search didn’t work/],
    [{ status: 'ok', choices: [] }, /Nothing found for “9999”/],
  ])('words a search that came back %j in the app’s own words', async (reply, wording) => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = {
      ...fake,
      adapters: { ...fake.adapters, settingChoices: async () => reply as never },
    } as FakeApi
    renderAt('#/setup/store', api)
    await heading('Your Woolworths store')
    await user.click(screen.getByRole('button', { name: /^Change store/ }))
    await user.type(screen.getByRole('textbox'), '9999{Enter}')
    expect(await screen.findByText(wording)).toBeTruthy()
  })

  it('says so when a search or a save fails, without the error’s text', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/setup/store', api)
    await heading('Your Woolworths store')
    await user.click(screen.getByRole('button', { name: /^Change store/ }))
    api.fake.failNext('adapters.settingChoices')
    await user.type(screen.getByRole('textbox'), '2000{Enter}')
    expect(await screen.findByText('Couldn’t search for a store. Try again.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const wynyard = await screen.findByRole('button', { name: 'Choose Woolworths Metro Wynyard' })
    api.fake.failNext('adapters.setSetting')
    await user.click(wynyard)
    expect(await screen.findByText('Couldn’t save the store. Try again.')).toBeTruthy()
  })

  it('asks for the approval first when the adapter isn’t approved', async () => {
    renderAt('#/setup/store', createFakeApi({ now: NOW, firstRun: true }))
    await heading('Your Woolworths store')
    expect(await screen.findByText(/Approve Woolworths first/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Search' })).toBeNull()
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
    expect(done).toEqual({
      welcome: false,
      onepassword: false,
      approve: false,
      grant: false,
      store: false,
      clients: false,
    })
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

  it('an adapter with a required store has its store step undone until one is chosen', async () => {
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
    // The login is granted either way: the store is a step of its own (D-setup).
    expect(stepsDone({ ...f, adapter: { ...adapter, settings: [store] } })).toMatchObject({
      grant: true,
      store: false,
    })
    expect(
      stepsDone({ ...f, adapter: { ...adapter, settings: [{ ...store, required: false }] } }).store,
    ).toBe(true)
    const chosen = {
      ...store,
      chosen: { id: '1', label: 'x', detail: null, chosenAt: new Date(NOW).toISOString() },
    }
    expect(stepsDone({ ...f, adapter: { ...adapter, settings: [chosen] } }).store).toBe(true)
    expect(
      stepsDone({ ...f, adapter: { ...adapter, approval: 'unapproved', settings: [chosen] } }).store,
    ).toBe(false)
  })

  it('resumes at the last step when everything is done', () => {
    expect(
      resumeStep({
        welcome: true,
        onepassword: true,
        approve: true,
        grant: true,
        store: true,
        clients: true,
      }),
    ).toBe('clients')
    expect(
      resumeStep({
        welcome: true,
        onepassword: true,
        approve: true,
        grant: true,
        store: false,
        clients: true,
      }),
    ).toBe('store')
  })
})
