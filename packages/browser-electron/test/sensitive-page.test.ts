import { describe, expect, it } from 'vitest'
import { sensitivePage } from '../src/sensitive-page'

const field = (over: Partial<{ type: string; autocomplete: string; name: string }>) => ({
  type: 'text',
  autocomplete: '',
  name: '',
  ...over,
})

describe('sensitivePage', () => {
  it.each([
    ['https://shop.test/checkout', 'a payment page'],
    ['https://shop.test/account/payment-methods', 'a payment page'],
    ['https://bank.test/payees/new', 'a bank details page'],
    ['https://site.test/settings/security', 'a password or security page'],
    ['https://site.test/account/change-password', 'a password or security page'],
    ['https://site.test/#/settings/2fa', 'a password or security page'],
    ['https://site.test/account/delete-account', 'an account settings page'],
  ])('closes %s', (url, what) => {
    expect(sensitivePage(url, [])).toBe(what)
  })

  it('closes pages by their fields', () => {
    expect(sensitivePage('https://s.test/a', [field({ autocomplete: 'cc-exp' })])).toBe('a payment page')
    expect(sensitivePage('https://s.test/a', [field({ name: 'card_cvc' })])).toBe('a payment page')
    expect(sensitivePage('https://s.test/a', [field({ name: 'bsb' })])).toBe('a bank details page')
    expect(sensitivePage('https://s.test/a', [field({ type: 'PASSWORD' })])).toBe(
      'a password or security page',
    )
    expect(sensitivePage('https://s.test/a', [field({ autocomplete: 'one-time-code' })])).toBe(
      'a password or security page',
    )
  })

  it('leaves ordinary pages open', () => {
    expect(sensitivePage('https://shop.test/account/orders/1234', [field({ name: 'q' })])).toBeNull()
    expect(sensitivePage('https://shop.test/products/paper-towels', [])).toBeNull()
    expect(sensitivePage('https://shop.test/specials?category=payday', [])).toBeNull()
    expect(sensitivePage('not a url', [])).toBeNull()
  })
})
