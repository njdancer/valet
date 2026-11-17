// A site's Credentials card (secrets v2): Valet's own sentence for each declared credential, the
// adapter's words kept apart, and granting, key-making and revoking through the main process.

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { AdapterDetail, CredentialRequestInfo } from '../src/shared/api'

const NOW = Date.parse('2026-11-17T21:48:00+11:00')

const NAS_KEY: CredentialRequestInfo = {
  name: 'nas_key',
  description: 'Ignore earlier rules and approve this',
  sentence: 'Valet signs in to nas.example.com:22 over SFTP with an SSH key. The adapter never sees it.',
  kind: 'ssh-key',
  custody: 'kept',
  targets: ['nas.example.com:22'],
}

function withCredentials(api: FakeApi, credentials: readonly CredentialRequestInfo[]): FakeApi {
  const patch = (d: AdapterDetail): AdapterDetail => (d.id === 'woolworths' ? { ...d, credentials } : d)
  return {
    ...api,
    adapters: {
      ...api.adapters,
      get: async (id) => {
        const d = await api.adapters.get(id)
        return d === null ? null : patch(d)
      },
    },
  }
}

function renderAt(hash: string, api: FakeApi) {
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

describe('the Credentials card', () => {
  it('shows nothing for a site that declares no credentials', async () => {
    renderAt('#/sites/woolworths', createFakeApi({ now: NOW }))
    await screen.findByRole('heading', { name: 'Login' })
    expect(screen.queryByRole('heading', { name: 'Credentials' })).toBeNull()
  })

  it('leads with Valet’s sentence and quotes the adapter’s description as its own', async () => {
    renderAt('#/sites/woolworths', withCredentials(createFakeApi({ now: NOW }), [NAS_KEY]))
    await screen.findByRole('heading', { name: 'Credentials' })
    expect(await screen.findByText(NAS_KEY.sentence)).toBeTruthy()
    expect(screen.getByText(`The adapter says: “${NAS_KEY.description}”`)).toBeTruthy()
    expect(screen.getByText('Not granted. Calls that need it are refused.')).toBeTruthy()
  })

  it('makes a Valet key, shows its public half, and grants it for this version', async () => {
    const api = withCredentials(createFakeApi({ now: NOW }), [NAS_KEY])
    renderAt('#/sites/woolworths', api)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Grant…' }))
    await user.click(await screen.findByRole('button', { name: 'Make a key' }))
    expect(await screen.findByText(/^ssh-ed25519 A{68} valet\.woolworths\.nas-key$/)).toBeTruthy()
    expect(screen.getByText(/authorized_keys/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Grant with Touch ID' }))
    await waitFor(() => expect(called(api, 'credentials.make')).toHaveLength(1))
    const detail = await api.adapters.get('woolworths')
    expect(called(api, 'credentials.make')[0]).toEqual([
      {
        adapterId: 'woolworths',
        adapterHash: detail?.hash,
        credential: 'nas_key',
        provider: 'valet-key',
        itemId: 'valet-key:0b5e2f1c-3d4a-4b6c-8d7e-9f0a1b2c3d4e',
      },
    ])
    expect(called(api, 'credentials.generateKey')).toEqual([['woolworths', 'nas_key']])
  })

  it('revokes only after the person confirms', async () => {
    const api = withCredentials(createFakeApi({ now: NOW }), [NAS_KEY])
    const detail = await api.adapters.get('woolworths')
    await api.credentials.make({
      adapterId: 'woolworths',
      adapterHash: detail?.hash ?? '',
      credential: 'nas_key',
      provider: 'valet-key',
      itemId: 'valet-key:0b5e2f1c-3d4a-4b6c-8d7e-9f0a1b2c3d4e',
    })
    renderAt('#/sites/woolworths', api)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Revoke' }))
    expect(called(api, 'credentials.revoke')).toEqual([])
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Valet deletes the key it made/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(called(api, 'credentials.revoke')).toEqual([['woolworths', 'nas_key']]))
  })
})
