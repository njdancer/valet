import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ApproveConnectionSheet } from '../src/renderer/screens/connections/ApproveConnectionSheet'
import { codeReady, connectorUrl, tunnelTarget } from '../src/renderer/screens/connections/consent'
import { RemotePage } from '../src/renderer/screens/connections/RemotePage'
import { called, NOW, renderAt, renderPage } from './connections-helpers'

describe('remote access', () => {
  it('stays off until a public name is added, then shows the connector URL and where the tunnel points', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <RemotePage />)
    const toggle = await screen.findByRole('switch', { name: 'Remote access on' })
    expect(toggle.hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('remote-state').textContent).toContain('Add the public name')
    const names = within(screen.getByRole('region', { name: 'Public names' }))
    await user.type(names.getByRole('textbox', { name: 'Add a public name' }), 'Valet.Example.com{Enter}')
    await names.findByText('https://valet.example.com/mcp')
    expect(called(api, 'remote.setHosts')).toEqual([[['Valet.Example.com']]])
    await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
    await user.click(toggle)
    await screen.findByText('http://127.0.0.1:47823')
    expect(called(api, 'remote.setEnabled')).toEqual([[true]])
    await user.click(names.getByRole('button', { name: 'Copy the URL for valet.example.com' }))
    expect(called(api, 'app.copyText')).toEqual([['https://valet.example.com/mcp']])

    // Off acts at once, with Undo.
    await user.click(screen.getByRole('switch', { name: 'Remote access on' }))
    expect(called(api, 'remote.setEnabled')).toEqual([[true], [false]])
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(called(api, 'remote.setEnabled')).toEqual([[true], [false], [true]]))

    await user.click(names.getByRole('button', { name: 'Remove valet.example.com' }))
    await names.findByText('None yet.')
  })

  it('says so when a public name is refused', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.failNext('remote.setHosts')
    renderPage(api, <RemotePage />)
    const field = await screen.findByRole('textbox', { name: 'Add a public name' })
    await user.type(field, 'not a name')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t save the public names')
  })

  it('lists every tool off, and a switch turns that one tool on, or off with Undo', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <RemotePage />)
    const card = within(await screen.findByRole('region', { name: 'Tools cloud agents may use' }))
    const summary = card.getByRole('switch', { name: 'Wikipedia: Get summary' })
    expect(card.getAllByRole('switch').every((s) => s.getAttribute('aria-checked') === 'false')).toBe(true)
    await user.click(summary)
    await waitFor(() => expect(summary.getAttribute('aria-checked')).toBe('true'))
    expect(called(api, 'remote.setTool')).toEqual([['wikipedia', 'get_summary', true]])
    expect(card.getByRole('switch', { name: 'Woolworths: View cart' }).getAttribute('aria-checked')).toBe(
      'false',
    )
    await user.click(summary)
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() =>
      expect(called(api, 'remote.setTool')).toEqual([
        ['wikipedia', 'get_summary', true],
        ['wikipedia', 'get_summary', false],
        ['wikipedia', 'get_summary', true],
      ]),
    )
  })

  it('shows who is asking, and declines from the banner', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <RemotePage />)
    expect(await screen.findByText('1 asking to connect')).toBeTruthy()
    expect(screen.getByText('203.0.113.24')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Approve…' }).getAttribute('href')).toBe('#/connections/approve')
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    expect(called(api, 'remote.declineConsent')).toEqual([['cs_demo']])
    await waitFor(() => expect(screen.queryByText('1 asking to connect')).toBeNull())
  })

  it('asks before revoking every cloud agent', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    await api.remote.approveConsent('ABCDEFGH', ['woolworths.view_cart'])
    renderPage(api, <RemotePage />)
    const row = await screen.findByRole('link', { name: 'claude.ai' })
    expect(row.getAttribute('href')).toBe('#/connections/rcdemodemodemodemodemo')
    await user.click(screen.getByRole('button', { name: 'Revoke every cloud agent…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(called(api, 'remote.revokeAllClients')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Revoke every cloud agent…' }))
    await user.click(screen.getByRole('button', { name: 'Revoke all 1' }))
    await screen.findByText('No cloud agents approved.')
  })
})

describe('approve a connection', () => {
  it('lists the request by its claimed host, never a code, and warns before anything else', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    const request = await screen.findByTestId('consent-request')
    expect(within(request).getByText('claude.ai')).toBeTruthy()
    expect(request.textContent).toContain('203.0.113.24')
    expect(request.textContent).toContain('“Claude”')
    expect(within(request).getByText('not verified')).toBeTruthy()
    expect(document.body.textContent).not.toContain('ABCD')
    const note = screen.getByRole('note')
    expect(note.textContent).toContain('started by someone else. Decline it.')
    // The warning comes before the code field.
    const field = screen.getByRole('textbox', { name: 'Code from your browser' })
    expect(note.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('approves only once a whole code is typed, with only the tools the person ticked', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(approve.getAttribute('aria-disabled')).toBe('true')
    expect(approve.getAttribute('aria-description')).toBe('Type the code first')
    const read = screen.getByRole('checkbox', { name: /View cart/ })
    const write = screen.getByRole('checkbox', { name: /Set cart quantity/ })
    expect(read.getAttribute('aria-checked')).toBe('false')
    expect(write.getAttribute('aria-checked')).toBe('false')
    await user.click(read)
    const field = screen.getByRole('textbox', { name: 'Code from your browser' })
    await user.type(field, 'abcd-efg')
    await user.click(approve)
    expect(called(api, 'remote.approveConsent')).toEqual([])
    await user.type(field, 'h')
    // Once it can be pressed it is a plain button again, with no reason to give.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBeNull(),
    )
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText(/Approved\. Your browser carries on/)
    expect(called(api, 'remote.approveConsent')).toEqual([['abcd-efgh', ['woolworths.view_cart']]])
    expect(screen.getByRole('link', { name: 'Open claude.ai’s page' }).getAttribute('href')).toBe(
      '#/connections/rcdemodemodemodemodemo',
    )
  })

  it('keeps Approve disarmed for a moment after it opens, so a click on its way can’t land', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ApproveConnectionSheet armDelayMs={60_000} />)
    const field = await screen.findByRole('textbox', { name: 'Code from your browser' })
    await user.type(field, 'ABCDEFGH{Enter}')
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve.getAttribute('aria-disabled')).toBe('true')
    expect(approve.getAttribute('aria-description')).toBe('Just a moment')
    await user.click(approve)
    expect(called(api, 'remote.approveConsent')).toEqual([])
  })

  it('says a wrong code matched nothing, and that three cancel everything', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    const field = await screen.findByRole('textbox', { name: 'Code from your browser' })
    await user.type(field, 'ZZZZ-ZZZZ{Enter}')
    expect((await screen.findByRole('alert')).textContent).toContain('Three wrong codes cancel every request')
    await user.clear(field)
    await user.type(field, 'ZZZZ-ZZZZ{Enter}')
    await user.clear(field)
    await user.type(field, 'ZZZZ-ZZZZ{Enter}')
    await screen.findByText('No connection is waiting')
  })

  it('declines one request, and with several, each or all of them', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))
    await screen.findByText('No connection is waiting')
    expect(called(api, 'remote.declineConsent')).toEqual([['cs_demo']])
  })

  it('offers Decline all and one Decline per request when several are waiting', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const state = await fake.remote.consents()
    const second = {
      ...state.requests[0],
      id: 'cs_two',
      clientHost: 'evil.example',
    } as (typeof state.requests)[number]
    const api = {
      ...fake,
      remote: { ...fake.remote, consents: async () => ({ ...state, requests: [...state.requests, second] }) },
    }
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    expect(await screen.findByText(/2 cloud agents are asking/)).toBeTruthy()
    expect(screen.getAllByTestId('consent-request')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Decline evil.example' }))
    expect(called(fake, 'remote.declineConsent')).toEqual([['cs_two']])
    await user.click(screen.getByRole('button', { name: 'Decline all' }))
    expect(called(fake, 'remote.declineAllConsents')).toEqual([[]])
  })

  it('says when no tool is on for cloud agents', async () => {
    const fake = createFakeApi({ now: NOW })
    const state = await fake.remote.consents()
    const api = { ...fake, remote: { ...fake.remote, consents: async () => ({ ...state, tools: [] }) } }
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    expect(await screen.findByText(/Approving now grants nothing/)).toBeTruthy()
  })

  it('opens over Needs you from its route, and closing returns there', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/connections/approve', api)
    const sheet = await screen.findByRole('dialog', { name: 'Approve a connection' })
    expect(await within(sheet).findByRole('textbox', { name: 'Code from your browser' })).toBeTruthy()
    await user.click(within(sheet).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(window.location.hash).toBe('#/needs-you'))
  })

  it('says it couldn’t load the requests', async () => {
    const fake = createFakeApi({ now: NOW })
    const api = {
      ...fake,
      remote: {
        ...fake.remote,
        consents: async () => {
          throw new Error('down')
        },
      },
    }
    renderPage(api, <ApproveConnectionSheet armDelayMs={0} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t load the requests. Try again.')
    await act(async () => undefined)
  })

  it('reads codes the way the Mac’s check does', () => {
    expect(codeReady('abcd-efgh')).toBe(true)
    expect(codeReady('ABCD EFGH')).toBe(true)
    expect(codeReady('ABCD-EFGO')).toBe(false)
    expect(codeReady('ABCD-2345')).toBe(false)
    expect(codeReady('ABC')).toBe(false)
    expect(tunnelTarget('http://127.0.0.1:47823/mcp')).toBe('http://127.0.0.1:47823')
    expect(connectorUrl('valet.example.com')).toBe('https://valet.example.com/mcp')
  })
})
