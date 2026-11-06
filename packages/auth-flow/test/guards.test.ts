import type { ElementInfo } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { allowedOrigins, requestedOrigins, suitsField } from '../src/guards'

const PASSWORD_INPUT: ElementInfo = {
  visible: true,
  tagName: 'INPUT',
  inputType: 'password',
  autocomplete: 'current-password',
  inputMode: null,
  frameOrigin: 'https://login.shop.test',
  formActionOrigin: 'https://login.shop.test',
}

describe('suitsField: password', () => {
  it('accepts a password input', () => {
    expect(suitsField(PASSWORD_INPUT, 'password')).toBe(true)
  })

  it('rejects a text input, even one labelled current-password', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'text' }, 'password')).toBe(false)
  })

  it('rejects a search input', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'search' }, 'password')).toBe(false)
  })

  it('rejects an input with no type attribute', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: null }, 'password')).toBe(false)
  })

  it('rejects something that is not an input, whatever its type attribute says', () => {
    expect(suitsField({ ...PASSWORD_INPUT, tagName: 'DIV' }, 'password')).toBe(false)
    expect(suitsField({ ...PASSWORD_INPUT, tagName: 'TEXTAREA' }, 'password')).toBe(false)
  })

  it('compares the type case-insensitively', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'PASSWORD' }, 'password')).toBe(true)
  })
})

describe('suitsField: username', () => {
  it('accepts email, text, tel, and an input with no type', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'email' }, 'username')).toBe(true)
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'text' }, 'username')).toBe(true)
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'tel' }, 'username')).toBe(true)
    expect(suitsField({ ...PASSWORD_INPUT, inputType: null }, 'username')).toBe(true)
  })

  it('rejects a password input', () => {
    expect(suitsField(PASSWORD_INPUT, 'username')).toBe(false)
  })

  it('rejects a search input', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'search' }, 'username')).toBe(false)
  })

  it('rejects hidden and url inputs', () => {
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'hidden' }, 'username')).toBe(false)
    expect(suitsField({ ...PASSWORD_INPUT, inputType: 'url' }, 'username')).toBe(false)
  })

  it('rejects a textarea', () => {
    expect(suitsField({ ...PASSWORD_INPUT, tagName: 'textarea', inputType: null }, 'username')).toBe(false)
  })
})

describe('suitsField: otp', () => {
  const OTP_INPUT: ElementInfo = {
    ...PASSWORD_INPUT,
    inputType: 'text',
    autocomplete: 'one-time-code',
    inputMode: 'numeric',
  }

  it('accepts autocomplete one-time-code on its own', () => {
    expect(suitsField({ ...OTP_INPUT, inputType: 'password', inputMode: null }, 'otp')).toBe(true)
  })

  it('accepts one-time-code among other autocomplete tokens', () => {
    expect(
      suitsField(
        { ...OTP_INPUT, inputType: 'password', autocomplete: 'section-2fa One-Time-Code', inputMode: null },
        'otp',
      ),
    ).toBe(true)
  })

  it('accepts inputmode numeric on its own', () => {
    expect(suitsField({ ...OTP_INPUT, inputType: 'password', autocomplete: null }, 'otp')).toBe(true)
  })

  it('accepts text, tel, number and untyped inputs', () => {
    const plain = { ...OTP_INPUT, autocomplete: null, inputMode: null }
    expect(suitsField({ ...plain, inputType: 'text' }, 'otp')).toBe(true)
    expect(suitsField({ ...plain, inputType: 'tel' }, 'otp')).toBe(true)
    expect(suitsField({ ...plain, inputType: 'number' }, 'otp')).toBe(true)
    expect(suitsField({ ...plain, inputType: null }, 'otp')).toBe(true)
  })

  it('rejects a plain password input with no one-time-code hint', () => {
    expect(
      suitsField({ ...OTP_INPUT, inputType: 'password', autocomplete: null, inputMode: null }, 'otp'),
    ).toBe(false)
  })

  it('rejects a search box that claims to take one-time codes', () => {
    expect(suitsField({ ...OTP_INPUT, inputType: 'search' }, 'otp')).toBe(false)
  })

  it('rejects email, url and hidden inputs whatever they claim', () => {
    expect(suitsField({ ...OTP_INPUT, inputType: 'email' }, 'otp')).toBe(false)
    expect(suitsField({ ...OTP_INPUT, inputType: 'url' }, 'otp')).toBe(false)
    expect(suitsField({ ...OTP_INPUT, inputType: 'hidden' }, 'otp')).toBe(false)
  })

  it('rejects something that is not an input', () => {
    expect(suitsField({ ...OTP_INPUT, tagName: 'div' }, 'otp')).toBe(false)
  })
})

describe('allowedOrigins', () => {
  it('keeps granted origins the manifest also requested', () => {
    expect(
      allowedOrigins(['https://login.shop.test', 'https://www.shop.test'], ['https://login.shop.test']),
    ).toEqual(['https://login.shop.test'])
  })

  it('drops a granted origin the manifest never requested', () => {
    expect(allowedOrigins(['https://evil.test'], ['https://login.shop.test'])).toEqual([])
  })

  it('drops a granted origin that is not a bare https origin', () => {
    expect(allowedOrigins(['http://login.shop.test'], ['https://login.shop.test'])).toEqual([])
    expect(allowedOrigins(['https://login.shop.test/path'], ['https://login.shop.test'])).toEqual([])
  })

  it('drops a granted origin that is not written in normalised form, rather than interpreting it', () => {
    expect(allowedOrigins(['https://LOGIN.shop.test'], ['https://login.shop.test'])).toEqual([])
  })

  it('keeps a granted origin with a trailing slash', () => {
    expect(allowedOrigins(['https://login.shop.test/'], ['https://login.shop.test'])).toEqual([
      'https://login.shop.test/',
    ])
  })
})

describe('requestedOrigins', () => {
  it('collects the origins of every secret request once each', () => {
    expect(
      requestedOrigins({
        secrets: {
          login: { description: 'Login', fields: ['password'], origins: ['https://login.shop.test'] },
          card: {
            description: 'Card',
            fields: ['otp'],
            origins: ['https://pay.shop.test', 'https://login.shop.test'],
          },
        },
      }),
    ).toEqual(['https://login.shop.test', 'https://pay.shop.test'])
  })

  it('is empty for a manifest that requests no secrets, so a code can be typed nowhere', () => {
    expect(requestedOrigins({ secrets: {} })).toEqual([])
  })
})
