import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom lacks a few browser APIs the design system's primitives use (cmdk, Radix).
if (typeof window !== 'undefined') {
  if (!('ResizeObserver' in window)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.assign(window, { ResizeObserver: ResizeObserverStub })
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.releasePointerCapture = () => undefined
  }
}

afterEach(() => {
  // test/build.test.ts runs in plain Node, with no DOM to clean.
  if (typeof window === 'undefined') return
  cleanup()
  window.location.hash = ''
})
