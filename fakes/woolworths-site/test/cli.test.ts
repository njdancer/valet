import { describe, expect, it } from 'vitest'
import { DEFAULT_PORT, DEV_ACCOUNTS, main, parsePort } from '../src/cli'
import type { FakeWoolworths, FakeWoolworthsOptions } from '../src/server'

describe('parsePort', () => {
  it('defaults to a fixed port', () => {
    expect(parsePort([])).toBe(DEFAULT_PORT)
  })

  it('reads --port', () => {
    expect(parsePort(['--port', '0'])).toBe(0)
    expect(parsePort(['--port', '9000'])).toBe(9000)
  })

  it('refuses a bad port', () => {
    expect(() => parsePort(['--port'])).toThrow('--port takes 0-65535')
    expect(() => parsePort(['--port', 'abc'])).toThrow('--port takes 0-65535')
    expect(() => parsePort(['--port', '70000'])).toThrow('--port takes 0-65535')
  })
})

describe('main', () => {
  it('starts the fake with the dev accounts and prints the origin and how to log in', async () => {
    const lines: string[] = []
    let given: FakeWoolworthsOptions | undefined
    const start = async (options: FakeWoolworthsOptions) => {
      given = options
      return { origin: 'http://127.0.0.1:1234' } as FakeWoolworths
    }
    await main(['--port', '1234'], { print: (line) => lines.push(line), start })
    expect(given).toEqual({ accounts: DEV_ACCOUNTS, port: 1234 })
    expect(lines).toEqual([
      'fake Woolworths at http://127.0.0.1:1234',
      '  shopper@example.test / fake-password-1',
      '  twofactor@example.test / fake-password-2, one-time code 246810',
    ])
  })

  it('really starts a server by default', async () => {
    const site = await main(['--port', '0'], { print: () => {} })
    try {
      expect((await fetch(`${site.origin}/`)).status).toBe(200)
    } finally {
      await site.close()
    }
  })
})
