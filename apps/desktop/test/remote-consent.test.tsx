import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { codeReady, RemoteConsentPage } from '../src/renderer/screens/RemoteConsent'

const NOW = Date.parse('2026-11-10T21:48:00+11:00')

function renderPage(api: FakeApi, armDelayMs = 0) {
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <RemoteConsentPage armDelayMs={armDelayMs} />
    </ApiProvider>,
  )
}

function calls(api: FakeApi, method: string) {
  return api.fake.calls.filter((c) => c.method === method).map((c) => c.args)
}

describe('remote access setup', () => {
  it('stays off until a public name is added, then shows the connector URL and the loopback URL', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    const card = within(await screen.findByRole('region', { name: 'Remote access' }))
    const turnOn = card.getByRole('button', { name: 'Turn on' }) as HTMLButtonElement
    expect(turnOn.disabled).toBe(true)
    expect(card.getByTestId('remote-state').textContent).toContain('Add the public name')
    await user.type(card.getByLabelText('Public name'), 'Valet.Example.com{Enter}')
    await card.findByText('https://valet.example.com/mcp')
    expect(calls(api, 'remote.setHosts')).toEqual([[['Valet.Example.com']]])
    await waitFor(() => expect(turnOn.disabled).toBe(false))
    await user.click(turnOn)
    await card.findByText('http://127.0.0.1:47823')
    expect(calls(api, 'remote.setEnabled')).toEqual([[true]])
    await user.click(card.getByRole('button', { name: 'Copy URL' }))
    expect(calls(api, 'app.copyText')).toEqual([['https://valet.example.com/mcp']])
    await user.click(card.getByRole('button', { name: 'Pause remote access' }))
    expect(calls(api, 'remote.setEnabled')).toEqual([[true], [false]])
  })

  it('lists every tool off, and a tick turns that one tool on', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    const card = within(await screen.findByRole('region', { name: 'Remote access' }))
    const summary = card.getByRole('checkbox', { name: 'Wikipedia: Get summary' }) as HTMLInputElement
    expect(card.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true)
    await user.click(summary)
    await waitFor(() => expect(summary.checked).toBe(true))
    expect(calls(api, 'remote.setTool')).toEqual([['wikipedia', 'get_summary', true]])
    expect((card.getByRole('checkbox', { name: 'Woolworths: View cart' }) as HTMLInputElement).checked).toBe(
      false,
    )
  })
})

describe('remote sign-in', () => {
  it('lists the request by its claimed host, never a code, and warns before anything else', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    const request = await screen.findByTestId('consent-request')
    expect(within(request).getByText('claude.ai')).toBeTruthy()
    expect(request.textContent).toContain('203.0.113.24')
    expect(request.textContent).toContain('calls itself “Claude”')
    expect(document.body.textContent).not.toContain('ABCD')
    expect(screen.getByRole('note').textContent).toContain('started by someone else. Decline it.')
  })

  it('approves only once a whole code is typed, with read tools ticked and write tools not', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    const approve = (await screen.findByRole('button', { name: 'Approve' })) as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    const requests = within(screen.getByRole('region', { name: 'Sign-in requests' }))
    const read = requests.getByRole('checkbox', { name: /View cart/ }) as HTMLInputElement
    const write = requests.getByRole('checkbox', { name: /Set cart quantity/ }) as HTMLInputElement
    expect(read.checked).toBe(true)
    expect(write.checked).toBe(false)
    await user.type(screen.getByLabelText('Code from your browser'), 'abcd-234')
    expect(approve.disabled).toBe(true)
    await user.type(screen.getByLabelText('Code from your browser'), '5')
    await waitFor(() => expect(approve.disabled).toBe(false))
    await user.click(approve)
    await screen.findByText(/Approved\. Your browser carries on/)
    expect(calls(api, 'remote.approveConsent')).toEqual([['abcd-2345', ['woolworths.view_cart']]])
    // The client now shows in the list, with its tools, and can be revoked.
    await screen.findByText('woolworths.view_cart')
    await user.click(screen.getByRole('button', { name: 'Revoke' }))
    await screen.findByText('No remote clients approved.')
  })

  it('says a wrong code matched nothing, and that three cancel everything', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    const field = await screen.findByLabelText('Code from your browser')
    await user.type(field, 'ZZZZ-ZZZZ{Enter}')
    expect((await screen.findByRole('alert')).textContent).toContain('Three wrong codes cancel every request')
    await user.clear(field)
    await user.type(field, 'ZZZZ-ZZZZ{Enter}')
    await user.clear(field)
    await user.type(field, 'ZZZZ-ZZZZ{Enter}')
    await screen.findByText('No sign-in requests waiting')
  })

  it('declines one request, or all of them', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))
    await screen.findByText('No sign-in requests waiting')
    expect(calls(api, 'remote.declineConsent')).toEqual([['cs_demo']])
  })

  it('asks before revoking every remote client', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api)
    await user.type(await screen.findByLabelText('Code from your browser'), 'ABCD2345{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Revoke all remote clients…' }))
    await user.click(screen.getByRole('button', { name: 'Keep them' }))
    expect(calls(api, 'remote.revokeAllClients')).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Revoke all remote clients…' }))
    await user.click(screen.getByRole('button', { name: 'Revoke all 1' }))
    await screen.findByText('No remote clients approved.')
  })

  it('opens from its route, with the waiting count in the sidebar', async () => {
    const api = createFakeApi({ now: NOW })
    window.location.hash = '#/remote'
    render(
      <ApiProvider api={api} clock={{ now: () => NOW }}>
        <ControlPanel />
      </ApiProvider>,
    )
    await screen.findByText('Type the code your browser shows')
    const nav = screen.getByRole('link', { name: /Remote sign-in/ })
    expect(nav.getAttribute('aria-current')).toBe('page')
    await waitFor(() => expect(nav.textContent).toContain('1'))
  })

  it('reads codes the way the Mac’s check does', () => {
    expect(codeReady('abcd-2345')).toBe(true)
    expect(codeReady('ABCD 2345')).toBe(true)
    expect(codeReady('OIL0-ABCD')).toBe(true)
    expect(codeReady('ABCD-234U')).toBe(false)
    expect(codeReady('ABC')).toBe(false)
  })
})
