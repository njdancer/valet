import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { LoginPage } from '../src/renderer/screens/secrets/LoginPage'
import { SecretsPage } from '../src/renderer/screens/secrets/SecretsPage'
import type { GrantInfo, SettingsPatch } from '../src/shared/api'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

/** The fake with its grants replaced by `edit(grants)`. */
async function withGrants(fake: FakeApi, edit: (grants: GrantInfo[]) => GrantInfo[]) {
  const list = [...(await fake.grants.list())]
  return { ...fake, grants: { ...fake.grants, list: async () => edit(list) } }
}

describe('secrets', () => {
  it('lists each login by site and item title, where it can be typed, and links it to its page', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SecretsPage />)
    const table = within(await screen.findByRole('table', { name: 'Logins Valet may use' }))
    expect(table.getByText('1Password app “Coles”')).toBeTruthy()
    expect(table.getByText('auth.woolworths.com.au')).toBeTruthy()
    expect(table.getByRole('link', { name: 'Woolworths login' }).getAttribute('href')).toBe(
      '#/secrets/woolworths/login',
    )
    expect(table.getAllByRole('link', { name: 'Woolworths' })[0]?.getAttribute('href')).toBe(
      '#/sites/woolworths',
    )
    expect(table.queryByRole('link', { name: 'woolworths' })).toBeNull()
    // No Keychain copy, so no re-sync and no empty actions column.
    expect(table.queryByRole('button', { name: 'Re-sync from 1Password' })).toBeNull()
  })

  it('shows where passwords and codes come from, and turns Messages codes on', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SecretsPage />)
    const sources = within(await screen.findByRole('list', { name: 'Where passwords come from' }))
    expect(sources.getByText('Copy in your Keychain')).toBeTruthy()
    expect(sources.getByText(/Not set up yet · 0 logins/)).toBeTruthy()
    await user.click(await screen.findByRole('switch', { name: 'Read one-time codes from Messages' }))
    expect(called(api, 'settings.set')).toEqual([[{ messagesOtpEnabled: true }]])
  })

  it('shows SMS logins as texts from the approved sender', async () => {
    const fake = createFakeApi({ now: NOW })
    const api = await withGrants(fake, (list) => [
      ...list,
      {
        ...(list[1] as GrantInfo),
        secret: 'messages',
        provider: 'messages',
        itemId: '+61 400 000 111',
        itemTitle: '+61 400 000 111',
      },
    ])
    renderPage(api, <SecretsPage />)
    expect(await screen.findByText('Texts from +61 400 000 111')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Coles one-time codes' })).toBeTruthy()
  })

  it('offers a re-sync from 1Password for a Keychain copy, and only for one', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = await withGrants(fake, (list) => [
      { ...(list[0] as GrantInfo), provider: 'keychain-copy' },
      ...list.slice(1),
    ])
    renderPage(api, <SecretsPage />)
    const resync = await screen.findByRole('button', { name: 'Re-sync from 1Password' })
    expect(screen.getAllByRole('button', { name: 'Re-sync from 1Password' })).toHaveLength(1)
    await user.click(resync)
    expect(called(fake, 'grants.resync')).toEqual([['woolworths', 'login']])
    fake.fake.failNext('grants.resync')
    await user.click(screen.getByRole('button', { name: 'Re-sync from 1Password' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t re-sync from 1Password. Try again.')
  })

  it('says so when there are no logins yet', async () => {
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderPage(api, <SecretsPage />)
    expect(await screen.findByText('No logins yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Sites' }).getAttribute('href')).toBe('#/sites')
  })

  it('saves the 1Password account the Keychain copies come from', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SecretsPage />)
    const field = await screen.findByRole('textbox', { name: '1Password account' })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.getAttribute('aria-disabled')).toBe('true')
    await user.click(save)
    expect(called(api, 'settings.set')).toEqual([])
    await user.type(field, '  my.1password.com ')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(called(api, 'settings.set')).toEqual([[{ onePasswordAccount: 'my.1password.com' }]])
    await user.clear(field)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(called(api, 'settings.set')).toEqual([
      [{ onePasswordAccount: 'my.1password.com' }],
      [{ onePasswordAccount: null }],
    ])
  })

  it('has no way to type the 1Password CLI path: the main process’s file dialog picks it', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    renderPage(fake, <SecretsPage />)
    expect((await screen.findByTestId('op-path')).textContent).toBe('Found automatically')
    expect(screen.queryByRole('textbox', { name: /op|CLI/i })).toBeNull()
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
    renderPage(fake, <SecretsPage />)
    await user.click(await screen.findByRole('button', { name: 'Find automatically' }))
    expect(called(fake, 'settings.clearOpPath')).toEqual([[]])
    await waitFor(() => expect(screen.getByTestId('op-path').textContent).toBe('Found automatically'))
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
})

describe('a login’s page', () => {
  it('shows the site, where it can be typed, what can cause it, and links to the calls that used it', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api, <LoginPage adapterId="woolworths" secret="login" />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Woolworths login' })).toBeTruthy()
    expect(screen.getByText('1Password service account “Woolworths”')).toBeTruthy()
    expect(screen.getByText('https://auth.woolworths.com.au')).toBeTruthy()
    expect(screen.getByText('username, password')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Calls that used it' }).getAttribute('href')).toBe(
      '#/activity/calls?login=woolworths%2Flogin',
    )
    expect(await screen.findByRole('link', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Cursor' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Change…' }).getAttribute('href')).toBe(
      '#/sites/woolworths/login/login',
    )
  })

  it('asks before revoking, naming what isn’t touched', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <LoginPage adapterId="coles" secret="login" />)
    await user.click(await screen.findByRole('button', { name: 'Revoke…' }))
    const dialog = within(screen.getByRole('alertdialog', { name: 'Revoke the Coles login?' }))
    expect(dialog.getByText(/Your 1Password item isn’t touched/)).toBeTruthy()
    await user.click(dialog.getByRole('button', { name: 'Revoke login' }))
    expect(called(api, 'grants.revoke')).toEqual([['coles', 'login']])
    expect(await screen.findByText('Not given')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Choose login…' })).toBeTruthy()
  })

  it('offers to give the installed version a login it only had for an older one', async () => {
    const fake = createFakeApi({ now: NOW })
    const api = await withGrants(fake, (list) =>
      list.map((g) => (g.adapterId === 'woolworths' ? { ...g, adapterHash: 'f'.repeat(64) } : g)),
    )
    renderPage(api, <LoginPage adapterId="woolworths" secret="login" />)
    expect(await screen.findByText('Not given to the installed version')).toBeTruthy()
    expect(screen.getByText('An older version')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Give it to 0.3.0…' }).getAttribute('href')).toBe(
      '#/sites/woolworths/login/login',
    )
    expect(WOOLWORTHS_HASH).not.toBe('f'.repeat(64))
  })

  it('says so for a login no site asks for, from its route', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/secrets/woolworths/nothing', api)
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to Secrets' }).getAttribute('href')).toBe('#/secrets')
  })
})
