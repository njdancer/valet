import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { retentionChoices, SettingsPage } from '../src/renderer/screens/settings/SettingsPage'
import type { UpdateStatus } from '../src/shared/api'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

function withUpdates(status: Partial<UpdateStatus>) {
  const fake = createFakeApi({ now: NOW })
  const base: UpdateStatus = {
    current: '0.1.0',
    state: 'up-to-date',
    available: null,
    checkedAt: null,
    signed: true,
    disabledReason: null,
  }
  return {
    fake,
    api: { ...fake, updates: { ...fake.updates, status: async () => ({ ...base, ...status }) } },
  }
}

describe('settings', () => {
  it('has a tab per section, each a link with the current one marked', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/settings/updates', api)
    const nav = within(await screen.findByRole('navigation', { name: 'Settings sections' }))
    expect(nav.getByRole('link', { name: 'Updates' }).getAttribute('aria-current')).toBe('page')
    expect(nav.getByRole('link', { name: 'General' }).getAttribute('href')).toBe('#/settings')
    expect(nav.getByRole('link', { name: 'Data and privacy' }).getAttribute('href')).toBe('#/settings/data')
  })

  it('opens at login, and sends 1Password to Secrets', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="general" />)
    await user.click(await screen.findByRole('switch', { name: 'Open Valet when you log in' }))
    expect(called(api, 'settings.set')).toEqual([[{ launchAtLogin: false }]])
    expect(screen.getByRole('link', { name: 'Open Secrets' }).getAttribute('href')).toBe('#/secrets')
  })

  it('sets the relay by host name, and refuses what isn’t one', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="devices" />)
    const field = await screen.findByRole('textbox', { name: 'Relay host name' })
    await user.clear(field)
    await user.type(field, 'not a host')
    expect(screen.getByText('Enter a host name, like relay.example.com')).toBeTruthy()
    await user.clear(field)
    await user.type(field, 'https://Relay.Valet.Example/')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(called(api, 'settings.set')).toEqual([[{ relayHost: 'relay.valet.example' }]])
  })

  it('turns notifications off', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="notifications" />)
    await user.click(await screen.findByRole('switch', { name: 'Tell me when Valet needs me' }))
    expect(called(api, 'settings.set')).toEqual([[{ notifications: false }]])
  })

  it('says so when a setting can’t be saved', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.failNext('settings.set')
    renderPage(api, <SettingsPage section="notifications" />)
    await user.click(await screen.findByRole('switch', { name: 'Tell me when Valet needs me' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t save the setting. Try again.')
  })

  it('keeps traces for the chosen days, and exports the audit log', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="data" />)
    const retention = await screen.findByRole('combobox', { name: 'Keep call traces and screenshots for' })
    expect(retention.textContent).toBe('14 days')
    await user.click(retention)
    await user.click(await screen.findByRole('option', { name: '30 days' }))
    expect(called(api, 'settings.set')).toEqual([[{ traceRetentionDays: 30 }]])
    await user.click(screen.getByRole('button', { name: 'Export…' }))
    expect(called(api, 'audit.exportJsonl')).toEqual([[]])
    expect(screen.getByRole('link', { name: 'Open the audit log' }).getAttribute('href')).toBe(
      '#/activity/audit',
    )
    expect(retentionChoices(14)).toEqual([1, 7, 14, 30, 90, 365])
    expect(retentionChoices(3)).toEqual([1, 3, 7, 14, 30, 90, 365])
  })

  it('changes the channel and automatic installs, and checks now', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="updates" />)
    expect(await screen.findByText(/Valet 0\.1\.0 is up to date · checked/)).toBeTruthy()
    expect(screen.getByText('Signed with a Developer ID')).toBeTruthy()
    await user.click(screen.getByRole('radio', { name: 'Beta' }))
    await user.click(screen.getByRole('switch', { name: 'Install updates automatically' }))
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(called(api, 'settings.set')).toEqual([
      [{ updateChannel: 'beta' }],
      [{ autoInstallUpdates: false }],
    ])
    expect(called(api, 'updates.check')).toEqual([[]])
  })

  it('shows update states and an unsigned build', async () => {
    const { api } = withUpdates({ state: 'available', available: '0.1.1', signed: false })
    renderPage(api, <SettingsPage section="updates" />)
    expect(await screen.findByText('0.1.1 available')).toBeTruthy()
    expect(screen.getByText('Not signed with a Developer ID')).toBeTruthy()
  })

  it.each([
    ['not-configured', 'Off: this build has no update feed'],
    ['development', 'Off in a development or demo build'],
    ['unsigned', 'Off: Squirrel.Mac only installs updates for a Developer ID build'],
  ] as const)(
    'says updates are off in a %s build, and the check explains why it can’t run',
    async (reason, words) => {
      const user = userEvent.setup()
      const { api, fake } = withUpdates({ state: 'disabled', disabledReason: reason })
      renderPage(api, <SettingsPage section="updates" />)
      expect(await screen.findByText(`Valet 0.1.0 · ${words}`)).toBeTruthy()
      const check = screen.getByRole('button', { name: 'Check now' })
      expect(check.getAttribute('aria-disabled')).toBe('true')
      expect(check.getAttribute('aria-description')).toBe(words)
      await user.click(check)
      expect(called(fake, 'updates.check')).toEqual([])
    },
  )

  it.each([
    [{ state: 'not-checked' }, 'Valet 0.1.0 · not checked yet'],
    [{ state: 'checking' }, 'Valet 0.1.0 · checking…'],
    [{ state: 'downloading', available: '0.1.1' }, 'Downloading 0.1.1'],
    [{ state: 'error' }, 'Couldn’t check for updates'],
  ] as const)('words the %o state', async (status, words) => {
    const { api } = withUpdates(status as Partial<UpdateStatus>)
    renderPage(api, <SettingsPage section="updates" />)
    expect(await screen.findByText(words)).toBeTruthy()
  })

  it('says a downloaded update installs on quit, only when automatic installs are on', async () => {
    const { api, fake } = withUpdates({ state: 'ready', available: '0.1.1' })
    renderPage(api, <SettingsPage section="updates" />)
    expect(await screen.findByText('0.1.1 downloaded')).toBeTruthy()
    expect(await screen.findByText('It installs when Valet quits.')).toBeTruthy()
    await fake.settings.set({ autoInstallUpdates: false })
    expect(await screen.findByText('Turn on automatic installs below to apply it.')).toBeTruthy()
  })

  it('asks here before a reset or an uninstall, and then only asks the main process for its own dialog', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="reset" />)
    expect(screen.getByRole('link', { name: 'Run setup' }).getAttribute('href')).toBe('#/setup')
    await user.click(screen.getByRole('button', { name: 'Reset Valet…' }))
    const reset = within(screen.getByRole('alertdialog', { name: 'Reset Valet?' }))
    expect(document.activeElement).toBe(reset.getByRole('button', { name: 'Cancel' }))
    await user.click(reset.getByRole('button', { name: 'Cancel' }))
    expect(called(api, 'app.erase')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Reset Valet…' }))
    await user.click(screen.getByRole('button', { name: 'Reset Valet' }))
    await user.click(screen.getByRole('button', { name: 'Uninstall Valet…' }))
    await user.click(screen.getByRole('button', { name: 'Uninstall Valet' }))
    await waitFor(() => expect(called(api, 'app.erase')).toEqual([['reset'], ['uninstall']]))
  })
})
