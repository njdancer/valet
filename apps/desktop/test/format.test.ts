import { describe, expect, it } from 'vitest'
import {
  formatAgo,
  formatBytes,
  formatCount,
  formatCountdown,
  formatDay,
  formatDuration,
  formatIn,
  formatSeconds,
  formatTime,
  hostOf,
  plural,
  shortHash,
  tinyHash,
} from '../src/renderer/lib/format'

// Sat 7 Nov 2026, 9:48 pm in Sydney (the test project pins TZ).
const NOW = Date.parse('2026-11-07T21:48:00+11:00')

describe('format', () => {
  it('shows today as a time, this week with a weekday, and older as a date', () => {
    expect(formatTime('2026-11-07T21:47:00+11:00', NOW)).toBe('9:47 pm')
    expect(formatTime('2026-11-05T18:20:00+11:00', NOW)).toBe('Thu 6:20 pm')
    expect(formatTime('2026-10-28T09:00:00+11:00', NOW)).toBe('28 Oct')
    expect(formatTime(null, NOW)).toBe('—')
    expect(formatTime('not a date', NOW)).toBe('—')
  })

  it('formats audit times with seconds', () => {
    expect(formatSeconds('2026-11-07T21:47:09+11:00', NOW)).toBe('9:47:09 pm')
    expect(formatSeconds('2026-11-05T18:20:44+11:00', NOW)).toBe('Thu 6:20:44 pm')
    expect(formatSeconds('2026-10-01T18:20:44+10:00', NOW)).toBe('1 Oct 6:20:44 pm')
    expect(formatSeconds('garbage', NOW)).toBe('—')
  })

  it('formats days, durations and counts', () => {
    expect(formatDay('2026-11-02T20:01:00+11:00')).toBe('2 Nov')
    expect(formatDay(null)).toBe('—')
    expect(formatDay('nope')).toBe('—')
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(640)).toBe('640 ms')
    expect(formatDuration(5194)).toBe('5.2 s')
    expect(formatDuration(12_400)).toBe('12 s')
    expect(formatDuration(120_400)).toBe('2 min')
    expect(formatCount(37)).toBe('37')
    expect(formatCount(1900)).toBe('1.9k')
    expect(formatCount(48_130)).toBe('48k')
    expect(formatBytes(412)).toBe('412 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
  })

  it('counts down and never goes negative', () => {
    expect(formatCountdown(new Date(NOW + 112_000).toISOString(), NOW)).toBe('1:52')
    expect(formatCountdown(new Date(NOW - 5000).toISOString(), NOW)).toBe('0:00')
    expect(formatCountdown('bad', NOW)).toBe('0:00')
  })

  it('says how long until and how long ago', () => {
    expect(formatIn(new Date(NOW + 4 * 60_000).toISOString(), NOW)).toBe('in 4 min')
    expect(formatIn(new Date(NOW + 120 * 60_000).toISOString(), NOW)).toBe('in 2 h')
    expect(formatIn(new Date(NOW + 80 * 60_000).toISOString(), NOW)).toBe('in 1 h 20 min')
    expect(formatIn(new Date(NOW - 60_000).toISOString(), NOW)).toBe('now')
    expect(formatIn('bad', NOW)).toBe('now')
    expect(formatAgo(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now')
    expect(formatAgo(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12 min ago')
    expect(formatAgo(new Date(NOW - 6 * 3_600_000).toISOString(), NOW)).toBe('6 h ago')
    expect(formatAgo(new Date(NOW - 5 * 86_400_000).toISOString(), NOW)).toBe('5 days ago')
    expect(formatAgo('bad', NOW)).toBe('—')
  })

  it('shortens hashes so they are never mistaken for the whole', () => {
    const hash = '9f3c1a7e52d4a4c123b1612dd272d1371c17149d439536b3216fdaeec8d9e0f1'
    expect(shortHash(hash)).toBe('9f3c1a7e…e0f1')
    expect(tinyHash(hash)).toBe('9f3c…e0f1')
    expect(shortHash('abc')).toBe('abc')
    expect(tinyHash('abc')).toBe('abc')
  })

  it('takes the host from an origin, and leaves anything else alone', () => {
    expect(hostOf('https://auth.woolworths.com.au')).toBe('auth.woolworths.com.au')
    expect(hostOf('not a url')).toBe('not a url')
    expect(plural(1, 'grant')).toBe('1 grant')
    expect(plural(3, 'grant')).toBe('3 grants')
    expect(plural(2, 'match', 'matches')).toBe('2 matches')
  })
})
