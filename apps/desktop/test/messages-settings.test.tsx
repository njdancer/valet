// Settings › Messages: turning it on asks for Full Disk Access, then conversations to hide and the
// codes rule.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { SettingsPage } from '../src/renderer/screens/settings/SettingsPage'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

describe('settings › Messages', () => {
  it('is a section of its own', async () => {
    renderAt('#/settings/messages', createFakeApi({ now: NOW }))
    expect(
      await screen.findByRole('switch', { name: 'Let agents read your messages on this Mac' }),
    ).toBeTruthy()
  })

  it('walks from off to hiding a conversation and the codes rule', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="messages" />)
    await user.click(await screen.findByRole('switch', { name: 'Let agents read your messages on this Mac' }))
    expect(called(api, 'messages.update')).toEqual([[{ enabled: true }]])

    await user.click(await screen.findByRole('button', { name: 'Open System Settings' }))
    expect(called(api, 'messages.action')).toEqual([['full-disk-access']])

    // Every conversation is visible to agents until it is ticked here.
    const ada = await screen.findByRole('checkbox', { name: 'Ada Example' })
    expect((ada as HTMLInputElement).getAttribute('aria-checked') ?? 'false').not.toBe('true')
    await user.click(ada)
    await waitFor(() => expect(called(api, 'messages.update').at(-1)).toEqual([{ hidden: ['+61400111222'] }]))

    await user.type(screen.getByRole('textbox', { name: 'Find a conversation' }), 'climb')
    expect(screen.getByRole('checkbox', { name: 'Climbing crew' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Bob Sample' })).toBeNull()

    const codes = screen.getByRole('switch', { name: 'Hide one-time codes' })
    await user.click(codes)
    await waitFor(() => expect(called(api, 'messages.update').at(-1)).toEqual([{ hideCodes: false }]))
  })
})
