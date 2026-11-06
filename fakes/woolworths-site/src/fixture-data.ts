// The committed fixtures as modules. A bundler (the desktop's electron-vite build) inlines them, so a
// bundle that imports the fake needs no fixtures folder beside it. readFixtureFile reads the same
// files from disk, for a caller that wants them there; tests check the two agree.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import catalogue from '../fixtures/catalogue.json' with { type: 'json' }
import productDetail from '../fixtures/product-detail.json' with { type: 'json' }
import productRegular from '../fixtures/product-regular.json' with { type: 'json' }
import productSpecial from '../fixtures/product-special.json' with { type: 'json' }
import searchResponse from '../fixtures/search-response.json' with { type: 'json' }
import trolleyEmpty from '../fixtures/trolley-empty.json' with { type: 'json' }

const BUNDLED = {
  'catalogue.json': catalogue,
  'product-detail.json': productDetail,
  'product-regular.json': productRegular,
  'product-special.json': productSpecial,
  'search-response.json': searchResponse,
  'trolley-empty.json': trolleyEmpty,
} as const satisfies Record<string, unknown>

export type FixtureName = keyof typeof BUNDLED

/** Every fixture file the fake uses. */
export const FIXTURE_NAMES = Object.freeze(Object.keys(BUNDLED).sort() as FixtureName[])

/** The fixtures folder in this package's source tree, where readFixtureFile looks by default. */
export const FIXTURES_DIRECTORY: URL = new URL('../fixtures/', import.meta.url)

function known(name: string): name is FixtureName {
  return Object.hasOwn(BUNDLED, name)
}

/** One fixture, parsed, as a fresh deep copy. Never touches the disk. */
export function fixtureFile(name: FixtureName): unknown {
  if (!known(name)) throw new Error('no such fixture')
  return structuredClone(BUNDLED[name])
}

/**
 * One fixture read from `directory` (a folder URL or path ending in a separator; by default this
 * package's own fixtures folder), parsed. For callers that keep the files on disk.
 */
export function readFixtureFile(name: FixtureName, directory: URL | string = FIXTURES_DIRECTORY): unknown {
  if (!known(name)) throw new Error('no such fixture')
  const base =
    typeof directory === 'string'
      ? pathToFileURL(directory.endsWith('/') ? directory : `${directory}/`)
      : directory
  return JSON.parse(readFileSync(new URL(name, base), 'utf8'))
}
