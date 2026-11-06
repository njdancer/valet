// The fixtures as modules (what a bundle carries) must be the files on disk, and the disk path must
// keep working for a caller that copies the folder somewhere.

import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_NAMES,
  FIXTURES_DIRECTORY,
  type FixtureName,
  fixtureFile,
  readFixtureFile,
} from '../src/fixture-data'

describe('fixture data', () => {
  it('names every JSON file in the fixtures folder', () => {
    const onDisk = readdirSync(FIXTURES_DIRECTORY)
      .filter((name) => name.endsWith('.json'))
      .sort()
    expect([...FIXTURE_NAMES]).toEqual(onDisk)
  })

  it.each([...FIXTURE_NAMES])('carries %s exactly as the file on disk', (name) => {
    expect(fixtureFile(name)).toEqual(readFixtureFile(name))
  })

  it('hands out a fresh copy each time', () => {
    const first = fixtureFile('trolley-empty.json') as { Errors: unknown[] }
    first.Errors.push('changed')
    expect((fixtureFile('trolley-empty.json') as { Errors: unknown[] }).Errors).not.toContain('changed')
  })

  it('reads a copied folder, by path with or without a trailing slash, or by URL', () => {
    const copy = mkdtempSync(join(tmpdir(), 'fake-fixtures-'))
    try {
      cpSync(FIXTURES_DIRECTORY, copy, { recursive: true })
      const expected = fixtureFile('catalogue.json')
      expect(readFixtureFile('catalogue.json', copy)).toEqual(expected)
      expect(readFixtureFile('catalogue.json', `${copy}/`)).toEqual(expected)
      expect(readFixtureFile('catalogue.json', pathToFileURL(`${copy}/`))).toEqual(expected)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('refuses a name it does not know, so no path can be read through it', () => {
    for (const name of ['../package.json', 'README.md', 'constructor'] as unknown as FixtureName[]) {
      expect(() => fixtureFile(name)).toThrow(/no such fixture/)
      expect(() => readFixtureFile(name)).toThrow(/no such fixture/)
    }
  })
})
