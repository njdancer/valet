import { describe, expect, it } from 'vitest'
import {
  captchaFramePage,
  ERRORS,
  errorPage,
  framedPage,
  identifierPage,
  mfaPage,
  passwordPage,
} from '../src/auth-pages'

describe('identifierPage', () => {
  const html = identifierPage({ state: 'T1', error: null, captcha: false })

  it('has the username field the live probe saw, in a form posting back to the identifier page', () => {
    expect(html).toContain(
      '<form method="POST" class="_form-login-id" data-form-primary="true" action="/u/login/identifier?state=T1">',
    )
    expect(html).toMatch(
      /<input class="input" inputmode="email" name="username" id="username" type="email" [^>]*autocomplete="email webauthn"/,
    )
    expect(html).toContain('<input type="hidden" name="state" value="T1">')
  })

  it('has one primary Continue button, and passkey and Everyday buttons in other forms', () => {
    expect(html.match(/name="action" value="default"/g)).toHaveLength(1)
    expect(html).toContain('data-testid="social-provider-button-passkey"')
    expect(html).toContain('data-testid="social-provider-button-everyday"')
    expect(html.match(/<form /g)).toHaveLength(3)
  })

  it('has no password field, CAPTCHA or error unless asked', () => {
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('ulp-captcha-container')
    expect(html).not.toContain('error-element')
  })

  it('shows a CAPTCHA and an error under the field', () => {
    const shown = identifierPage({ state: 'T1', error: ERRORS.invalidCaptcha, captcha: true })
    expect(shown).toContain('<div class="ulp-captcha-container"')
    expect(shown).toContain(
      '<span id="error-element-username" class="ulp-input-error-message" data-error-code="invalid-captcha">',
    )
  })

  it('puts the CAPTCHA in a third-party iframe when given its source, escaped', () => {
    const shown = identifierPage({
      state: 'T1',
      error: null,
      captcha: true,
      captchaFrameSrc: 'https://challenges.captcha.test:1/captcha/frame?a="b"',
    })
    expect(shown).toContain(
      '<iframe class="ulp-captcha-frame" title="Challenge" src="https://challenges.captcha.test:1/captcha/frame?a=&quot;b&quot;"></iframe>',
    )
    const password = passwordPage({
      state: 'T1',
      error: null,
      captcha: true,
      captchaFrameSrc: 'https://challenges.captcha.test:1/captcha/frame',
    })
    expect(password).toContain('<div class="ulp-captcha-container" data-captcha-provider="auth0"><iframe ')
    expect(passwordPage({ state: 'T1', error: null, captcha: true })).not.toContain('<iframe')
  })

  it('serves the challenge itself as a page of its own, with nothing to type a secret into', () => {
    const frame = captchaFramePage()
    expect(frame).toContain('id="challenge-checkbox"')
    expect(frame).not.toMatch(/type="(text|email|password)"/)
  })

  it('escapes the state everywhere it appears', () => {
    const hostile = identifierPage({ state: '"><script>x</script>', error: null, captcha: false })
    expect(hostile).not.toContain('<script>x')
    expect(hostile).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"')
    expect(hostile).toContain('state=%22%3E%3Cscript%3Ex%3C%2Fscript%3E')
  })
})

describe('passwordPage', () => {
  it('has the standard Auth0 password field and primary button', () => {
    const html = passwordPage({ state: 'T2', error: null, captcha: false })
    expect(html).toContain('action="/u/login/password?state=T2"')
    expect(html).toMatch(
      /<input class="input" name="password" id="password" type="password" required autocomplete="current-password"/,
    )
    expect(html).toContain('<button type="submit" name="action" value="default"')
  })

  it('shows a wrong-password error with its code', () => {
    const html = passwordPage({ state: 'T2', error: ERRORS.wrongCredentials, captcha: false })
    expect(html).toContain(
      'id="error-element-password" class="ulp-input-error-message" data-error-code="wrong-credentials"',
    )
  })

  it('takes a hostile action and field type, escaped', () => {
    const html = passwordPage({
      state: 'T2',
      error: null,
      captcha: false,
      action: 'https://evil.test/"x',
      passwordType: 'text',
    })
    expect(html).toContain('action="https://evil.test/&quot;x"')
    expect(html).toContain('id="password" type="text"')
  })
})

describe('mfaPage', () => {
  it('has the code field, the remember-device box and the primary button', () => {
    const html = mfaPage({ channel: 'sms', state: 'T3', error: null })
    expect(html).toContain('action="/u/mfa-sms-challenge?state=T3"')
    expect(html).toMatch(
      /<input class="input" name="code" id="code" type="text" inputmode="numeric" autocomplete="one-time-code"/,
    )
    expect(html).toContain(
      '<input type="checkbox" name="rememberBrowser" id="remember-browser" value="true">',
    )
    expect(html.match(/name="action" value="default"/g)).toHaveLength(1)
    expect(html).toContain('value="resend-code"')
    expect(html).toContain('value="pick-authenticator"')
  })

  it('offers no resend for an authenticator app', () => {
    const html = mfaPage({ channel: 'otp', state: 'T3', error: null })
    expect(html).toContain('action="/u/mfa-otp-challenge?state=T3"')
    expect(html).not.toContain('resend-code')
  })

  it('shows a wrong-code error and a hostile code type', () => {
    const html = mfaPage({ channel: 'email', state: 'T3', error: ERRORS.invalidCode, codeType: 'search' })
    expect(html).toContain('data-error-code="invalid-code"')
    expect(html).toContain('id="code" type="search"')
  })
})

describe('framedPage and errorPage', () => {
  it('holds only an iframe, src escaped', () => {
    const html = framedPage('Log in', 'https://login.evil.test:1/u/login/password/frame?state="x')
    expect(html).toContain(
      '<iframe id="loginFrame" title="Log in" src="https://login.evil.test:1/u/login/password/frame?state=&quot;x"></iframe>',
    )
    expect(html).not.toContain('<form')
  })

  it('carries a machine-readable error code', () => {
    expect(errorPage('invalid-state', 'Expired')).toContain(
      '<p id="error-description" data-error-code="invalid-state">Expired</p>',
    )
  })
})
