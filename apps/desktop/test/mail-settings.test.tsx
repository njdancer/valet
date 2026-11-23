// Settings › Mail: turning Mail on walks through the reader, Full Disk Access and the accounts.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ClientPage } from '../src/renderer/screens/connections/ClientPage'
import { SettingsPage } from '../src/renderer/screens/settings/SettingsPage'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

describe('settings › Mail', () => {
  it('is a section of its own', async () => {
    renderAt('#/settings/mail', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('switch', { name: 'Let agents read Mail on this Mac' })).toBeTruthy()
  })

  it('walks from off to reading the accounts picked, then drafts', async () => {
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

    // Once the reader can read, the accounts appear, none picked.
    const icloud = await screen.findByRole('checkbox', { name: 'iCloud' })
    // Accounts by name with their address; On My Mac says what it is. Never a raw id.
    expect(screen.getByText('someone@icloud.com')).toBeTruthy()
    expect(screen.getByText('Mailboxes kept only on this Mac, not in any email account')).toBeTruthy()
    expect(screen.queryByText(/0A1B2C3D/)).toBeNull()
    expect(screen.getByText('Agents see no Mail tools until you pick at least one account.')).toBeTruthy()
    await user.click(icloud)
    await waitFor(() =>
      expect(called(api, 'mail.update').at(-1)).toEqual([
        { accounts: ['0A1B2C3D-0000-4000-8000-000000000001'] },
      ]),
    )
    await user.click(screen.getByRole('switch', { name: 'Let agents save drafts' }))
    await waitFor(() => expect(called(api, 'mail.update').at(-1)).toEqual([{ drafts: true }]))
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

describe('letting cloud agents read Mail', () => {
  async function ready() {
    const api = createFakeApi({ now: NOW })
    await api.mail.update({ enabled: true })
    await api.mail.action('full-disk-access')
    await api.mail.update({ accounts: ['0A1B2C3D-0000-4000-8000-000000000001'] })
    return api
  }

  it('gives an approved agent search and read from the Mail page, and takes all Mail away', async () => {
    const user = userEvent.setup()
    const api = await ready()
    await api.remote.approveConsent('ABCDEFGH', ['woolworths.get_cart'])
    renderPage(api, <SettingsPage section="mail" />)
    const agent = await screen.findByRole('switch', { name: 'Let Claude (claude.ai) search and read Mail' })
    expect(agent.getAttribute('aria-checked')).toBe('false')
    await user.click(agent)
    await waitFor(() =>
      expect(
        screen
          .getByRole('switch', { name: 'Let Claude (claude.ai) search and read Mail' })
          .getAttribute('aria-checked'),
      ).toBe('true'),
    )
    expect(called(api, 'remote.setClientTool')).toEqual([
      ['rcdemodemodemodemodemo', 'mail', 'search', true],
      ['rcdemodemodemodemodemo', 'mail', 'read', true],
    ])
    await user.click(screen.getByRole('switch', { name: 'Let Claude (claude.ai) search and read Mail' }))
    await waitFor(() =>
      expect(called(api, 'remote.setClientTool').slice(2)).toEqual([
        ['rcdemodemodemodemodemo', 'mail', 'search', false],
        ['rcdemodemodemodemodemo', 'mail', 'read', false],
      ]),
    )
    expect((await api.remote.clients())[0]?.grant?.tools).toEqual(['woolworths.get_cart'])
  })

  it('lets agents organise mail with its own switch, and gives an agent move and mark', async () => {
    const user = userEvent.setup()
    const api = await ready()
    await api.remote.approveConsent('ABCDEFGH', ['mail.search', 'mail.read'])
    renderPage(api, <SettingsPage section="mail" />)
    const organise = await screen.findByRole('switch', { name: 'Let agents archive, trash and mark mail' })
    // Off: no per-agent switch to give.
    expect(screen.queryByRole('switch', { name: /archive, trash and mark mail$/, hidden: false })).toBe(
      organise,
    )
    await user.click(organise)
    await waitFor(() => expect(called(api, 'mail.update').at(-1)).toEqual([{ organize: true }]))
    const give = await screen.findByRole('switch', {
      name: 'Let Claude (claude.ai) archive, trash and mark mail',
    })
    await user.click(give)
    await waitFor(() =>
      expect(called(api, 'remote.setClientTool')).toEqual([
        ['rcdemodemodemodemodemo', 'mail', 'move', true],
        ['rcdemodemodemodemodemo', 'mail', 'mark', true],
      ]),
    )
    // Reading off takes every Mail tool away, organising ones too.
    await user.click(screen.getByRole('switch', { name: 'Let Claude (claude.ai) search and read Mail' }))
    await waitFor(() => expect((called(api, 'remote.setClientTool').at(-1) ?? [])[3]).toBe(false))
    expect((await api.remote.clients())[0]?.grant?.tools).toEqual([])
  })

  it('says when no cloud agent is connected yet', async () => {
    renderPage(await ready(), <SettingsPage section="mail" />)
    expect(await screen.findByText(/No cloud agent is connected yet/)).toBeTruthy()
  })
})

describe('a cloud agent’s page with Mail on', () => {
  it('lists a Mail group whose switches give the agent Mail tools', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    await api.remote.approveConsent('ABCDEFGH', ['woolworths.get_cart'])
    renderPage(api, <ClientPage clientId="rcdemodemodemodemodemo" />)
    await screen.findByRole('switch', { name: 'Woolworths: Get cart' })
    // Mail off: no Mail group.
    expect(screen.queryByRole('switch', { name: 'Mail: Search mail' })).toBeNull()
    await api.mail.update({ enabled: true, accounts: ['0A1B2C3D-0000-4000-8000-000000000001'] })
    const search = await screen.findByRole('switch', { name: 'Mail: Search mail' })
    await user.click(search)
    await waitFor(() =>
      expect(called(api, 'remote.setClientTool')).toEqual([
        ['rcdemodemodemodemodemo', 'mail', 'search', true],
      ]),
    )
  })
})
