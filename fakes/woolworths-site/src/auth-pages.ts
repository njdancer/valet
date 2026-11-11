// Auth0 Universal Login pages, as served on the auth origin. Page 1 (the identifier) follows what
// the live probe saw; the password and MFA pages follow Auth0's standard New Universal Login
// markup and are assumed (fixtures/README.md). Only what an auth flow selects on, and the decoys it
// must not pick by mistake (the passkey and Everyday buttons, resend, another method), are modelled.

import type { MfaChannel } from './accounts'
import { BASE_CSS, LOGO_SVG, STORE_NAME } from './brand'
import { escapeHtml } from './pages'

/** An error Auth0 shows under a field, with the machine-readable code it puts on the element. */
export interface FieldError {
  readonly code: string
  readonly message: string
}

export const ERRORS = {
  wrongCredentials: { code: 'wrong-credentials', message: 'Wrong email or password' },
  userBlocked: {
    code: 'user-blocked',
    message: 'Your account has been blocked after multiple consecutive login attempts.',
  },
  invalidCode: { code: 'invalid-code', message: 'The code you entered is invalid' },
  invalidCaptcha: {
    code: 'invalid-captcha',
    message: 'Solve the challenge question to verify you are not a robot.',
  },
  missingUsername: { code: 'invalid-username', message: 'Please enter an email address' },
} as const satisfies Record<string, FieldError>

const AUTH_CSS = `
body{display:flex;justify-content:center;padding:60px 16px}
._widget{width:400px;background:#fff;border:1px solid var(--line);border-radius:18px;padding:32px;box-shadow:0 10px 30px rgba(0,0,0,.06)}
.auth-brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:var(--leaf);margin-bottom:14px}
h1{font-size:24px;margin:6px 0 16px}
label{display:block;font-weight:600;font-size:14px;margin:12px 0 6px}
.input{width:100%;padding:12px 14px;border:1.5px solid var(--line);border-radius:10px;font:inherit}
form{margin:0 0 10px}
button{width:100%;margin-top:12px;padding:12px;border-radius:999px;border:1.5px solid var(--leaf);background:#fff;color:var(--leaf);font:600 15px inherit;font-family:inherit;cursor:pointer}
button[data-action-button-primary]{background:var(--leaf);color:#fff}
.ulp-input-error-message{display:block;color:var(--sale);font-size:13px;margin-top:6px}
.ulp-checkbox{display:flex;gap:8px;align-items:center;margin-top:12px}.ulp-checkbox label{margin:0;font-weight:400}
`

function document(title: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>${BASE_CSS}${AUTH_CSS}</style>
</head>
<body class="_widget-auto-layout">
  <main class="_widget">
    <div class="auth-brand">${LOGO_SVG}<span>${STORE_NAME}</span></div>
${main}
  </main>
</body>
</html>
`
}

function stateInput(state: string): string {
  return `<input type="hidden" name="state" value="${escapeHtml(state)}">`
}

function fieldError(field: string, error: FieldError | null): string {
  if (error === null) return ''
  return `\n        <span id="error-element-${field}" class="ulp-input-error-message" data-error-code="${escapeHtml(error.code)}">${escapeHtml(error.message)}</span>`
}

/**
 * Auth0's bot detection: a challenge the person has to solve, rendered in a third-party iframe as
 * Turnstile, reCAPTCHA, hCaptcha and Arkose all are. The fake never accepts an answer.
 */
function captchaBlock(frameSrc: string | undefined): string {
  const frame =
    frameSrc === undefined
      ? ''
      : `<iframe class="ulp-captcha-frame" title="Challenge" src="${escapeHtml(frameSrc)}"></iframe>`
  return `
        <div class="ulp-captcha-container" data-captcha-provider="auth0">${frame}<input type="hidden" name="captcha" value=""></div>`
}

const PRIMARY_BUTTON = `<button type="submit" name="action" value="default" data-action-button-primary="true">Continue</button>`

export interface IdentifierPageOptions {
  readonly state: string
  readonly error: FieldError | null
  readonly captcha: boolean
  /** Where the CAPTCHA's iframe loads from, when there is one. */
  readonly captchaFrameSrc?: string
}

export function identifierPage({ state, error, captcha, captchaFrameSrc }: IdentifierPageOptions): string {
  const action = `/u/login/identifier?state=${encodeURIComponent(state)}`
  return document(
    `Log in | ${STORE_NAME}`,
    `    <h1>Log in</h1>
    <form method="POST" class="_form-login-id" data-form-primary="true" action="${escapeHtml(action)}">
        ${stateInput(state)}
        <label for="username">Email address*</label>
        <input class="input" inputmode="email" name="username" id="username" type="email" value="" required autocomplete="email webauthn" autocapitalize="none" spellcheck="false">${captcha ? captchaBlock(captchaFrameSrc) : ''}${fieldError('username', error)}
        ${PRIMARY_BUTTON}
    </form>
    <form method="POST" class="_form-login-passkey" action="${escapeHtml(action)}">
        ${stateInput(state)}
        <button type="submit" name="action" value="passkey" data-testid="social-provider-button-passkey">Log in with a passkey</button>
    </form>
    <form method="POST" data-provider="everyday" action="${escapeHtml(action)}">
        ${stateInput(state)}
        <input type="hidden" name="connection" value="everyday">
        <button type="submit" data-testid="social-provider-button-everyday">Log in / Sign up with Everyday</button>
    </form>`,
  )
}

export interface PasswordPageOptions {
  readonly state: string
  readonly error: FieldError | null
  readonly captcha: boolean
  /** Where the CAPTCHA's iframe loads from, when there is one. */
  readonly captchaFrameSrc?: string
  /** Where the form posts. Differs from the default only for the hostile variant. */
  readonly action?: string
  /** The password input's `type`. Differs from `password` only for the hostile variant. */
  readonly passwordType?: string
}

export function passwordPage({
  state,
  error,
  captcha,
  captchaFrameSrc,
  action = `/u/login/password?state=${encodeURIComponent(state)}`,
  passwordType = 'password',
}: PasswordPageOptions): string {
  return document(
    `Enter your password | ${STORE_NAME}`,
    `    <h1>Enter your password</h1>
    <form method="POST" class="_form-login-password" data-form-primary="true" action="${escapeHtml(action)}">
        ${stateInput(state)}
        <label for="password">Password*</label>
        <input class="input" name="password" id="password" type="${escapeHtml(passwordType)}" required autocomplete="current-password" autocapitalize="none" spellcheck="false">${captcha ? captchaBlock(captchaFrameSrc) : ''}${fieldError('password', error)}
        ${PRIMARY_BUTTON}
    </form>
    <a class="ulp-forgot-password" href="/u/reset-password/request/Username-Password-Authentication?state=${escapeHtml(encodeURIComponent(state))}">Forgot password?</a>`,
  )
}

const MFA_PROMPTS: Readonly<Record<MfaChannel, string>> = {
  sms: 'We’ve sent a text message to your phone.',
  email: 'We’ve sent an email with your code.',
  otp: 'Enter the code from your authenticator app.',
}

export interface MfaPageOptions {
  readonly channel: MfaChannel
  readonly state: string
  readonly error: FieldError | null
  /** The code input's `type`. Differs from `text` only for the hostile variant. */
  readonly codeType?: string
}

export function mfaPage({ channel, state, error, codeType = 'text' }: MfaPageOptions): string {
  const action = escapeHtml(`/u/mfa-${channel}-challenge?state=${encodeURIComponent(state)}`)
  const resend =
    channel === 'otp'
      ? ''
      : `
    <form method="POST" action="${action}">
        ${stateInput(state)}
        <button type="submit" name="action" value="resend-code">Resend code</button>
    </form>`
  return document(
    `Verify your identity | ${STORE_NAME}`,
    `    <h1>Verify your identity</h1>
    <p>${MFA_PROMPTS[channel]}</p>
    <form method="POST" class="_form-mfa-${channel}-challenge" data-form-primary="true" action="${action}">
        ${stateInput(state)}
        <label for="code">Enter the 6-digit code*</label>
        <input class="input" name="code" id="code" type="${escapeHtml(codeType)}" inputmode="numeric" autocomplete="one-time-code" pattern="^[0-9]{6}$" required>${fieldError('code', error)}
        <div class="ulp-checkbox"><input type="checkbox" name="rememberBrowser" id="remember-browser" value="true"><label for="remember-browser">Remember this device for 30 days</label></div>
        ${PRIMARY_BUTTON}
    </form>${resend}
    <form method="POST" action="${action}">
        ${stateInput(state)}
        <button type="submit" name="action" value="pick-authenticator">Try another method</button>
    </form>`,
  )
}

/** The hostile variant's page: nothing but an iframe holding the real form, from another origin. */
export function framedPage(title: string, frameSrc: string): string {
  return document(title, `    <iframe id="loginFrame" title="Log in" src="${escapeHtml(frameSrc)}"></iframe>`)
}

/** The challenge inside the CAPTCHA's iframe, served from the provider's origin. */
export function captchaFramePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Challenge</title>
</head>
<body>
  <div id="challenge-stage"><input type="checkbox" id="challenge-checkbox" name="challenge"><label for="challenge-checkbox">Verify you are human</label></div>
</body>
</html>
`
}

/** Auth0's generic error page, for a bad state, a callback URL it doesn't know, and the like. */
export function errorPage(code: string, message: string): string {
  return document(
    `Error | ${STORE_NAME}`,
    `    <h1>Something went wrong</h1>
    <p id="error-description" data-error-code="${escapeHtml(code)}">${escapeHtml(message)}</p>`,
  )
}
