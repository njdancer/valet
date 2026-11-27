// Settings › Mail: turning Mail on walks through the reader, Full Disk Access and the accounts.
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ClientPage } from '../src/renderer/screens/connections/ClientPage'
import { SettingsPage } from '../src/renderer/screens/settings/SettingsPage'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

const ACCOUNT = '0A1B2C3D-0000-4000-8000-000000000001'

describe('settings › Mail', () => {
  it('is a section of its own', async () => {
    renderAt('#/settings/mail', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('switch', { name: 'Let agents read Mail on this Mac' })).toBeTruthy()
  })

  it('walks from off to the accounts on this Mac, and sends the person to each agent’s page for them', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="mail" />)
    const main = await screen.findByRole('switch', { name: 'Let agents read Mail on this Mac' })
    expect(screen.queryByText('Give the reader Full Disk Access')).toBeNull()
    await user.click(main)
    expect(called(api, 'mail.update')).toEqual([[{ enabled: true }]])

    // Turning Mail on starts the reader; it then needs Full Disk Access.
    expect(await screen.findByText('Give the reader Full Disk Access')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show the reader in Finder' }))
    await user.click(screen.getByRole('button', { name: 'Open Full Disk Access' }))
    expect(called(api, 'mail.action')).toEqual([['reveal-reader'], ['full-disk-access']])

    // Once the reader can read, the accounts appear by name with their address; never a raw id.
    const accounts = await screen.findByTestId('mail-accounts')
    expect(within(accounts).getByText('iCloud')).toBeTruthy()
    expect(screen.getByText('someone@icloud.com')).toBeTruthy()
    expect(screen.getByText('Mailboxes kept only on this Mac, not in any email account')).toBeTruthy()
    expect(screen.queryByText(/0A1B2C3D/)).toBeNull()
    // Nothing here gives an agent anything: no pickers, no switches beyond Mail itself.
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('href')).toBe('#/connections')
    expect(screen.queryByText(/send/i, { selector: 'button' })).toBeNull()
  })

  it('offers the reader’s start button when it isn’t running', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = {
      ...fake,
      mail: {
        ...fake.mail,
        status: async () => ({
          state: 'not-running' as const,
          settings: { enabled: true, accounts: [], drafts: false, approveDrafts: false, organize: false },
          accounts: [],
        }),
      },
    }
    renderPage(api, <SettingsPage section="mail" />)
    await user.click(await screen.findByRole('button', { name: 'Start the reader' }))
    expect(called(fake, 'mail.action')).toEqual([['start-reader']])
    expect(await screen.findByRole('button', { name: 'Open Login Items' })).toBeTruthy()
  })
})

describe('a cloud agent’s page with Mail on', () => {
  it('gives the agent a Mail account by its own access, saved with one Touch ID', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    await api.remote.approveConsent('ABCDEFGH', ['woolworths.get_cart'])
    // Mail set up: on, its reader running with Full Disk Access.
    await api.mail.update({ enabled: true })
    await api.mail.action('full-disk-access')
    renderPage(api, <ClientPage clientId="rcdemodemodemodemodemo" />)
    await screen.findByRole('switch', { name: 'Woolworths: Get cart' })
    // Mail's own tools aren't per-tool switches: they follow from its access below.
    expect(screen.queryByRole('switch', { name: 'Mail: Search mail' })).toBeNull()
    const mail = await screen.findByTestId('access-mail')
    const read = () => within(mail).getAllByRole('radio', { name: 'Read' })[0] as HTMLElement
    const off = () => within(mail).getAllByRole('radio', { name: 'Off' })[0] as HTMLElement
    await user.click(read())
    expect(within(mail).getByText(/not saved/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save with Touch ID' }))
    await waitFor(() =>
      expect(called(api, 'agentAccess.save')).toEqual([
        ['remote:rcdemodemodemodemodemo', { mail: { [ACCOUNT]: 'read' } }],
      ]),
    )
    await waitFor(() => expect(within(mail).queryByText(/not saved/)).toBeNull())
    // Taking it away is a plain Save.
    await user.click(off())
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy()
  })
})
