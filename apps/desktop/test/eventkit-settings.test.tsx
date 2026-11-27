// Settings › Calendar and Settings › Reminders: turning one on asks macOS, then the picks.
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { SettingsPage } from '../src/renderer/screens/settings/SettingsPage'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

describe('settings › Calendar and Reminders', () => {
  it('are sections of their own', async () => {
    renderAt('#/settings/reminders', createFakeApi({ now: NOW }))
    expect(
      await screen.findByRole('switch', { name: 'Let agents see your reminders on this Mac' }),
    ).toBeTruthy()
  })

  it('walks from off to the calendars on this Mac, chosen per agent on its own page', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <SettingsPage section="calendar" />)
    await user.click(await screen.findByRole('switch', { name: 'Let agents see your calendars on this Mac' }))
    expect(called(api, 'eventKit.update')).toEqual([['calendar', { enabled: true }]])

    // macOS asks once; then the calendars appear.
    await user.click(await screen.findByRole('button', { name: 'Ask macOS' }))
    expect(called(api, 'eventKit.action')).toEqual([['calendar', 'request-access']])
    const items = await screen.findByTestId('calendar-items')
    expect(within(items).getByText('Home')).toBeTruthy()
    expect(screen.getByText('Subscribed · read only')).toBeTruthy()
    expect(screen.queryByText(/CAL-HOME/)).toBeNull()
    expect(screen.queryAllByRole('checkbox')).toEqual([])
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Connections' }).getAttribute('href')).toBe('#/connections')
    expect(screen.queryByText(/delete/i, { selector: 'button' })).toBeNull()
  })

  it('sends the person to System Settings when macOS said no', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = {
      ...fake,
      eventKit: {
        ...fake.eventKit,
        status: async () => ({
          state: 'denied' as const,
          settings: { enabled: true, calendars: [], writes: false },
          calendars: [],
        }),
      },
    }
    renderPage(api, <SettingsPage section="reminders" />)
    expect(await screen.findByText('macOS doesn’t let the reader use Reminders')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(called(fake, 'eventKit.action')).toEqual([['reminders', 'privacy-settings']])
  })
})
