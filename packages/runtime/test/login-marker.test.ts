import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoginAttemptMarker } from '../src/login-marker'

let dir: string
const clock = { now: () => Date.UTC(2026, 10, 7, 9, 0, 0) }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-markers-'))
})

afterEach(async () => {
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

describe('LoginAttemptMarker', () => {
  it('starts unset', async () => {
    expect(await new LoginAttemptMarker(dir, clock).isSet('woolworths')).toBe(false)
  })

  it('is set by writing a file and cleared by removing it', async () => {
    const markers = new LoginAttemptMarker(dir, clock)
    await markers.set('woolworths', 'call-1')

    expect(await markers.isSet('woolworths')).toBe(true)
    expect(await readdir(dir)).toEqual(['woolworths.login-attempt'])
    expect(await markers.startedAt('woolworths')).toBe('2026-11-07T09:00:00.000Z')

    await markers.clear('woolworths')
    expect(await markers.isSet('woolworths')).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('survives a restart, as a crash mid-login would leave it', async () => {
    await new LoginAttemptMarker(dir, clock).set('woolworths', null)
    expect(await new LoginAttemptMarker(dir, clock).isSet('woolworths')).toBe(true)
  })

  it('keeps adapters apart', async () => {
    const markers = new LoginAttemptMarker(dir, clock)
    await markers.set('woolworths', null)
    expect(await markers.isSet('coles')).toBe(false)
  })

  it('treats a marker it cannot read as set', async () => {
    const markers = new LoginAttemptMarker(dir, clock)
    await chmod(dir, 0o000)
    expect(await markers.isSet('woolworths')).toBe(true)
  })

  it('treats a marker with garbage contents as set, since existence is the state', async () => {
    await writeFile(join(dir, 'woolworths.login-attempt'), 'not json')
    const markers = new LoginAttemptMarker(dir, clock)

    expect(await markers.isSet('woolworths')).toBe(true)
    expect(await markers.startedAt('woolworths')).toBeNull()
  })

  it('reports no start time for an unset marker or one without a time', async () => {
    const markers = new LoginAttemptMarker(dir, clock)
    expect(await markers.startedAt('woolworths')).toBeNull()

    await writeFile(join(dir, 'woolworths.login-attempt'), '{"callId":null}')
    expect(await markers.startedAt('woolworths')).toBeNull()
  })

  it('clears a marker that is already clear', async () => {
    await expect(new LoginAttemptMarker(dir, clock).clear('woolworths')).resolves.toBeUndefined()
  })

  it('rethrows when the marker cannot be removed', async () => {
    await mkdir(join(dir, 'woolworths.login-attempt', 'child'), { recursive: true })
    await expect(new LoginAttemptMarker(dir, clock).clear('woolworths')).rejects.toThrow()
  })

  it('refuses adapter ids that would walk out of the directory', async () => {
    const markers = new LoginAttemptMarker(join(dir, 'markers'), clock)
    await mkdir(join(dir, 'markers'))

    await expect(markers.set('../escaped', null)).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(markers.clear('../escaped')).rejects.toMatchObject({ errorClass: 'invalid' })
    expect(await readdir(dir)).toEqual(['markers'])
    // An id we refuse to map to a file can't be shown to be clear.
    expect(await markers.isSet('../escaped')).toBe(true)
  })
})
