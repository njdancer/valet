// Fails the test during which a promise rejection went unhandled. In the bridge process that
// rejection would be fatal (Node's default is --unhandled-rejections=throw), so a test that lets one
// through has found a crash, even if every assertion passed.

import { afterAll, afterEach, beforeAll, expect } from 'vitest'

const unhandled: unknown[] = []
const trap = (reason: unknown): void => {
  unhandled.push(reason)
}

beforeAll(() => {
  process.on('unhandledRejection', trap)
})

afterEach(async () => {
  // Node reports an unhandled rejection after the microtask queue drains.
  await new Promise((resolve) => setImmediate(resolve))
  expect(unhandled.splice(0), 'unhandled promise rejections').toEqual([])
})

afterAll(() => {
  process.off('unhandledRejection', trap)
})
