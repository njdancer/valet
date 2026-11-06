import { describe, expect, it } from 'vitest'
import type { CookieRecord } from '../src/platform'
import { SessionValues } from '../src/session-values'

const sid: CookieRecord = {
  name: 'sid',
  value: 'first',
  domain: 'www.example.com',
  path: '/',
  hostOnly: true,
  sameSite: 'lax',
}

describe('SessionValues cookies', () => {
  it('keeps every value a cookie has held, once each', () => {
    const values = new SessionValues()
    values.cookie(sid)
    values.cookie({ ...sid, value: 'second' })
    values.cookie(sid)
    expect(values.cookieValues(['www.example.com']).sort()).toEqual(['first', 'second'])
  })

  it('keeps the 16 most recent values of one cookie', () => {
    const values = new SessionValues()
    for (let i = 0; i < 17; i++) values.cookie({ ...sid, value: `v${i}` })
    const held = values.cookieValues(['www.example.com'])
    expect(held).toHaveLength(16)
    expect(held).not.toContain('v0')
    expect(held).toContain('v16')
  })

  it('keeps a value that is seen again as the newest', () => {
    const values = new SessionValues()
    values.cookie(sid)
    for (let i = 0; i < 15; i++) values.cookie({ ...sid, value: `v${i}` })
    values.cookie(sid)
    values.cookie({ ...sid, value: 'v15' })
    expect(values.cookieValues(['www.example.com'])).toContain('first')
  })

  it('drops the oldest cookie name past 2000 names', () => {
    const values = new SessionValues()
    for (let i = 0; i <= 2000; i++) values.cookie({ ...sid, name: `n${i}`, value: `v${i}` })
    const held = values.cookieValues(['www.example.com'])
    expect(held).toHaveLength(2000)
    expect(held).not.toContain('v0')
  })

  it('ignores empty values and cookies with no domain', () => {
    const values = new SessionValues()
    values.cookie({ ...sid, value: '' })
    values.cookie({ ...sid, domain: undefined as never })
    values.cookie({ ...sid, domain: '.' })
    expect(values.cookieValues(['www.example.com', '*.example.com'])).toEqual([])
  })

  it('matches domains as hostAllowed does, with or without the leading dot', () => {
    const values = new SessionValues()
    values.cookie({ ...sid, domain: '.example.com', value: 'parent' })
    values.cookie({ ...sid, domain: 'ads.test', value: 'tracker' })
    expect(values.cookieValues(['example.com'])).toEqual(['parent'])
  })
})

describe('SessionValues storage', () => {
  it('records page writes only to watched keys on the watched origin', () => {
    const values = new SessionValues()
    values.watch('https://www.example.com', ['token'])
    values.storageValue({ origin: 'https://www.example.com', key: 'token', value: 'a' })
    values.storageValue({ origin: 'https://www.example.com', key: 'theme', value: 'dark' })
    values.storageValue({ origin: 'https://evil.test', key: 'token', value: 'b' })
    expect(values.storageValues('https://www.example.com', ['token', 'theme'])).toEqual(['a'])
    expect(values.storageValues('https://evil.test', ['token'])).toEqual([])
  })

  it('records the handoff’s own values whether or not the key was watched, and watches it after', () => {
    const values = new SessionValues()
    values.rememberStorage('https://www.example.com', 'token', 'handed')
    values.storageValue({ origin: 'https://www.example.com', key: 'token', value: 'rotated' })
    expect(values.storageValues('https://www.example.com', ['token'])).toEqual(['handed', 'rotated'])
    expect(values.watchedKeys('https://www.example.com')).toEqual(['token'])
  })

  it('ignores empty values and lists watched keys per origin', () => {
    const values = new SessionValues()
    values.watch('https://www.example.com', ['a', 'b'])
    values.watch('https://www.example.com.evil.test', ['c'])
    values.rememberStorage('https://www.example.com', 'a', '')
    expect(values.storageValues('https://www.example.com', ['a'])).toEqual([])
    expect(values.watchedKeys('https://www.example.com')).toEqual(['a', 'b'])
  })
})
