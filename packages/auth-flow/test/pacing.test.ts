// D55 inside the login: every step that can load a page waits for the site's rate budget first.

import { ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { world } from './fixtures'

describe('paceNavigation', () => {
  it('is awaited before the goto and the click, and before nothing else', async () => {
    const w = world()
    const paced: string[] = []
    w.input.paceNavigation = async () => {
      paced.push(
        `${w.page.visited.length} visited, ${w.page.clicked.length} clicked, ${w.page.typed.length} typed`,
      )
    }
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(paced).toEqual(['0 visited, 0 clicked, 0 typed', '1 visited, 0 clicked, 2 typed'])
  })

  it('ends the flow without navigating when the wait is aborted', async () => {
    const w = world()
    w.input.paceNavigation = async () => {
      throw new ValetError('login', 'aborted')
    }
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'aborted' })
    expect(w.page.visited).toEqual([])
  })

  it('turns anything else the wait throws into navigate: internal', async () => {
    const w = world()
    w.input.paceNavigation = async () => {
      throw new Error('clock gone')
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'internal',
    })
  })

  it('stops at the flow deadline if the wait used it up', async () => {
    const w = world()
    w.input.paceNavigation = async () => {
      w.clock.now += 120_000
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(w.page.visited).toEqual([])
  })
})
