import { screen } from '@testing-library/react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, devFake, resolveApi } from '../src/renderer/boot'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import type { ValetApi } from '../src/shared/api'

function windowWith(api: ValetApi | undefined): Window {
  return { valet: api } as unknown as Window
}

// Every root a test mounts is unmounted before jsdom goes, or React's scheduler can render into a
// window that is no longer there (an unhandled error on a busy runner).
const roots: Root[] = []
afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
})

describe('boot', () => {
  it('uses the preload’s API when there is one, even in dev', async () => {
    const preload = createFakeApi()
    expect(await resolveApi(windowWith(preload), devFake)).toBe(preload)
    expect(await resolveApi(windowWith(preload), null)).toBe(preload)
  })

  it('falls back to the fake only when the build has one', async () => {
    // Vitest runs as a dev build, so the loader is there; test/build.test.ts checks a production
    // build leaves it out.
    expect(devFake).not.toBeNull()
    expect(await resolveApi(windowWith(undefined), devFake)).not.toBeNull()
    expect(await resolveApi(windowWith(undefined), null)).toBeNull()
  })

  it('mounts the page, or an error when there is no main process to talk to', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    await act(async () => {
      roots.push(await boot(<p>mounted</p>, root, windowWith(createFakeApi()), null))
    })
    expect(await screen.findByText('mounted')).toBeTruthy()

    const bare = document.createElement('div')
    document.body.append(bare)
    await act(async () => {
      roots.push(await boot(<p>never</p>, bare, windowWith(undefined), null))
    })
    expect(await screen.findByText(/couldn’t reach its main process/)).toBeTruthy()
    expect(bare.textContent).not.toContain('never')
  })

  it('starts the control panel and tray entries against the dev fake', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    window.location.hash = '#/clients'
    await act(async () => {
      const control = await (await import('../src/renderer/control')).mounted
      if (control) roots.push(control)
    })
    expect(await screen.findByRole('heading', { name: 'Connections', level: 1 })).toBeTruthy()

    document.body.innerHTML = '<div id="root"></div>'
    await act(async () => {
      const tray = await (await import('../src/renderer/tray')).mounted
      if (tray) roots.push(tray)
    })
    expect(await screen.findByText('Quit Valet')).toBeTruthy()
  })
})
