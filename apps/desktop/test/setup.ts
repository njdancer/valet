import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  // test/build.test.ts runs in plain Node, with no DOM to clean.
  if (typeof window === 'undefined') return
  cleanup()
  window.location.hash = ''
})
