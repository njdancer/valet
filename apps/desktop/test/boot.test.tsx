import { screen } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it } from 'vitest'
import { boot, resolveApi } from '../src/renderer/boot'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import type { SiteAdapterApi } from '../src/shared/api'

function windowWith(api: SiteAdapterApi | undefined): Window {
  return { siteadapter: api } as unknown as Window
}

describe('boot', () => {
  it('uses the preload’s API when there is one, even in dev', async () => {
    const preload = createFakeApi()
    expect(await resolveApi(windowWith(preload), true)).toBe(preload)
    expect(await resolveApi(windowWith(preload), false)).toBe(preload)
  })

  it('falls back to the fake only in dev, never in a production bundle', async () => {
    const dev = await resolveApi(windowWith(undefined), true)
    expect(dev).not.toBeNull()
    expect(await resolveApi(windowWith(undefined), false)).toBeNull()
  })

  it('mounts the page, or an error when there is no main process to talk to', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    await act(() => boot(<p>mounted</p>, root, windowWith(createFakeApi()), false))
    expect(await screen.findByText('mounted')).toBeTruthy()

    const bare = document.createElement('div')
    document.body.append(bare)
    await act(() => boot(<p>never</p>, bare, windowWith(undefined), false))
    expect(await screen.findByText(/couldn’t reach its main process/)).toBeTruthy()
    expect(bare.textContent).not.toContain('never')
  })

  it('starts the control panel and tray entries against the dev fake', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    window.location.hash = '#/clients'
    await act(async () => {
      await import('../src/renderer/control')
    })
    expect(await screen.findByText('Clients and settings')).toBeTruthy()

    document.body.innerHTML = '<div id="root"></div>'
    await act(async () => {
      await import('../src/renderer/tray')
    })
    expect(await screen.findByText('Quit siteadapter')).toBeTruthy()
  })
})
