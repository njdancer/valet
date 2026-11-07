// Hash routes for the control panel. The main process opens windows at these routes (the
// confirmation panel and the login hand-off banner are chromeless routes of the same page), so they
// are part of the contract too: see README.md.

import { useEffect, useState } from 'react'
import { parseRoute, type Route } from './routes'

export { href, parseRoute, type Route, SETUP_STEPS, type SetupStep } from './routes'

export function navigate(to: string): void {
  window.location.hash = to
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
