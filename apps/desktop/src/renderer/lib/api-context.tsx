// How components reach the API and the clock. Both are injected at the root, so tests render any
// screen against the fake API at a fixed time.

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AppEventType, ValetApi } from '../../shared/api'

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

const ApiContext = createContext<ValetApi | null>(null)
const ClockContext = createContext<Clock>(systemClock)

export function ApiProvider({
  api,
  clock = systemClock,
  children,
}: {
  readonly api: ValetApi
  readonly clock?: Clock
  readonly children: ReactNode
}) {
  return (
    <ApiContext.Provider value={api}>
      <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>
    </ApiContext.Provider>
  )
}

export function useApi(): ValetApi {
  const api = useContext(ApiContext)
  if (api === null) throw new Error('useApi outside ApiProvider')
  return api
}

/** The current time, re-read every `intervalMs` so countdowns tick. */
export function useNow(intervalMs = 1000): number {
  const clock = useContext(ClockContext)
  const [now, setNow] = useState(() => clock.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(clock.now()), intervalMs)
    return () => clearInterval(timer)
  }, [clock, intervalMs])
  return now
}

export type Loaded<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly data: T }

/**
 * Loads `load(api)` and loads it again whenever one of `refreshOn` arrives. Failures show as
 * `error` with no message: the main process's error text never reaches the screen.
 *
 * A refresh keeps showing the current data until the new data arrives. A change of `deps` doesn't:
 * data loaded for other deps (adapter A's detail under adapter B's route) reads as loading.
 */
export function useLoad<T>(
  load: (api: ValetApi) => Promise<T>,
  deps: readonly unknown[],
  refreshOn: readonly AppEventType[],
): Loaded<T> & { readonly reload: () => void } {
  const api = useApi()
  const [state, setState] = useState<{ readonly deps: readonly unknown[]; readonly loaded: Loaded<T> }>(
    () => ({ deps, loaded: { status: 'loading' } }),
  )
  const generation = useRef(0)
  // The caller's deps decide when `load` changes; the lint can't see through that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  const run = useCallback(() => {
    const mine = ++generation.current
    load(api).then(
      (data) => {
        if (mine === generation.current) setState({ deps, loaded: { status: 'ready', data } })
      },
      () => {
        if (mine === generation.current) setState({ deps, loaded: { status: 'error' } })
      },
    )
  }, [api, ...deps])

  // Call sites pass a fresh array literal each render; compare by content.
  const refreshKey = refreshOn.join(' ')
  useEffect(() => {
    run()
    const refresh = new Set(refreshKey.split(' '))
    const unsubscribe = api.onEvent((event) => {
      if (refresh.has(event.type)) run()
    })
    return () => {
      generation.current++
      unsubscribe()
    }
  }, [api, run, refreshKey])

  const current = sameDeps(state.deps, deps) ? state.loaded : { status: 'loading' as const }
  return { ...current, reload: run }
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

/**
 * Runs an action against the API and reports whether it is busy or failed, without the error's
 * text. Returns true when the action succeeded.
 */
export function useAction(): {
  readonly busy: boolean
  readonly failed: boolean
  readonly run: (action: () => Promise<unknown>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setFailed(false)
    try {
      await action()
      return true
    } catch {
      setFailed(true)
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, failed, run }
}
