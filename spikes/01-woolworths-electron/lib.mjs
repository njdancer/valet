// Spike 1's pure parts: settings, what to record about pages, cookies and requests, and the scrub
// check. main.mjs does the Electron work; scrub.mjs runs the check. Nothing here records a value:
// cookie values, field values, query strings and response bodies stay out of every result.

export const LIVE_ORIGIN = 'https://www.woolworths.com.au'
export const MODES = ['login', 'silent', 'probe', 'record']

/** The gap between the spike's own scripted requests (D28's 10 s). Nick's clicks are not paced. */
export const GAP_MS = 10_000

/** Settings from the environment. Chrome's UA string is the default (Electron's is flagged, run 4). */
export function settingsFrom(env) {
  const mode = env.SPIKE_MODE ?? 'login'
  if (!MODES.includes(mode)) throw new Error(`SPIKE_MODE takes ${MODES.join(', ')}; got ${mode}`)
  if (env.SPIKE_UA !== undefined && env.SPIKE_UA !== 'electron' && env.SPIKE_UA !== 'chrome') {
    throw new Error(`SPIKE_UA takes chrome (the default) or electron; got ${env.SPIKE_UA}`)
  }
  const origin = new URL(env.SPIKE_ORIGIN ?? LIVE_ORIGIN).origin
  return {
    mode,
    uaMode: env.SPIKE_UA === 'electron' ? 'electron' : 'chrome',
    origin,
    siteDomain: siteDomainOf(origin),
  }
}

/** The domain the site's cookies live under: woolworths.com.au live, the bare host for a fake. */
export function siteDomainOf(origin) {
  const host = new URL(origin).hostname
  return host.endsWith('woolworths.com.au') ? 'woolworths.com.au' : host
}

export function chromeUserAgent(chromeVersion) {
  const major = chromeVersion.split('.')[0]
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** Cookie names, flags and domains. Never values. */
export function describeCookies(cookies) {
  return cookies
    .map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, session: c.session }))
    .sort((a, b) => a.name.localeCompare(b.name) || String(a.domain).localeCompare(String(b.domain)))
}

/** The www cookies silent mode clears: on the www host or the parent domain, not the auth host's. */
export function isWwwCookie(cookie, origin) {
  const domain = String(cookie.domain ?? '').replace(/^\./, '')
  return domain === new URL(origin).hostname || domain === siteDomainOf(origin)
}

/** A block page, by its title or a refusing status on the main frame. Seeing one stops the run. */
export function isBlockPage({ title = '', status = 200 } = {}) {
  return status === 403 || status === 429 || /access denied|blocked|pardon our interruption/i.test(title)
}

/** Host and path only: query strings and fragments carry state, codes and tokens. */
export function where(url) {
  const parsed = new URL(url)
  return { host: parsed.host, path: parsed.pathname }
}

// Runs in an auth page. Records the page's shape, never what is typed or prefilled. Labels have any
// email address replaced, since Auth0's password page shows the identifier next to an Edit link.
export const AUTH_SHAPE_SCRIPT = `(() => {
  const email = /[^\\s@]+@[^\\s@]+\\.[^\\s@]+/g
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(email, '<email>').slice(0, 80)
  const originOf = (action) => { try { return new URL(action, location.href).origin } catch { return null } }
  const forms = [...document.forms].map((form) => ({
    actionOrigin: originOf(form.getAttribute('action') || location.href),
    sameOrigin: originOf(form.getAttribute('action') || location.href) === location.origin,
    method: (form.getAttribute('method') || 'get').toLowerCase(),
    fields: [...form.elements].filter((el) => el.tagName !== 'BUTTON' && el.type !== 'submit').map((el) => ({
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute('name'),
      id: el.id || null,
      type: el.getAttribute('type'),
      autocomplete: el.getAttribute('autocomplete'),
      inputmode: el.getAttribute('inputmode'),
      checked: el.type === 'checkbox' ? el.checked : undefined,
    })),
    buttons: [...form.querySelectorAll('button, input[type=submit]')].map((el) => ({
      label: label(el),
      name: el.getAttribute('name'),
      type: el.getAttribute('type'),
    })),
  }))
  const text = document.body ? document.body.innerText : ''
  return {
    host: location.host,
    path: location.pathname,
    title: document.title.replace(email, '<email>'),
    forms,
    iframeHosts: [...document.querySelectorAll('iframe[src]')].map((f) => { try { return new URL(f.src).host } catch { return null } }),
    rememberDevice: /remember (this )?(device|browser)/i.test(text),
  }
})()`

/** The key shape of a JSON value: its keys and each value's type, to a depth. Never a value. */
export function keyShape(value, depth = 3) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return value.length === 0 ? ['empty'] : [depth > 0 ? keyShape(value[0], depth - 1) : 'array']
  }
  if (typeof value === 'object') {
    if (depth === 0) return 'object'
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .slice(0, 80)
        .map((key) => [key, keyShape(value[key], depth - 1)]),
    )
  }
  return typeof value
}

/** Segments that mark the checkout's dangerous end, flagged on every request record mode logs. */
export const DENY_SEGMENTS = ['checkout', 'payment', 'payments', 'order', 'orders', 'place', 'placeorder']
const CANCEL_SEGMENTS = /^(order|orders|payment|payments|place|placeorder)$/i
const PAYMENT_HOST =
  /(^|\.)(paypal|braintreegateway|braintree-api|adyen|adyenpayments|stripe|cybersource|afterpay|zip|applepay|pay\.google)\.|payment|pay\./i

export function segmentsOf(path) {
  return path
    .toLowerCase()
    .split(/[/._-]+/)
    .filter(Boolean)
}

export function touchesDeny(path) {
  return segmentsOf(path).some((segment) => DENY_SEGMENTS.includes(segment))
}

export function isPaymentHost(host) {
  return PAYMENT_HOST.test(host)
}

/** Who started a request: the main frame, a subframe, or no frame (a worker or the browser). */
export function initiatorOf({ resourceType, hasFrame, frameHasParent }) {
  if (resourceType === 'mainFrame') return 'main-frame'
  if (resourceType === 'subFrame') return 'subframe-load'
  if (!hasFrame) return 'worker-or-browser'
  return frameHasParent ? 'subframe' : 'main-frame'
}

/**
 * Record mode's decision on one request. The guard is belt and braces: Nick drives the window and
 * never presses Place order, but on a checkout path a non-GET that looks like an order or payment
 * call, or anything to a payment host, is cancelled anyway.
 */
export function judgeRequest({ method, url, resourceType, initiator }, { onCheckout }) {
  const { host, path } = where(url)
  const entry = { method, host, path, resourceType, initiator, deny: touchesDeny(path) }
  let cancel = null
  if (isPaymentHost(host)) cancel = 'payment-host'
  else if (
    onCheckout &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    segmentsOf(path).some((s) => CANCEL_SEGMENTS.test(s))
  ) {
    cancel = 'order-or-payment-call'
  }
  return { entry, cancel }
}

export function isCheckoutPath(url) {
  return /\/checkout/i.test(new URL(url).pathname)
}

/** Silent mode's verdict from the hosts and paths the window went through. */
export function silentVerdict(steps, origin) {
  const site = new URL(origin).host
  const loginPage = steps.find((s) => /^\/u\/(login|mfa)/.test(s.path))
  if (loginPage) return { outcome: 'login-page-shown', page: loginPage.path }
  const callback = steps.findIndex((s) => s.host === site && s.path === '/auth/callback')
  if (callback !== -1) return { outcome: 'silent', landedOn: steps.at(-1)?.path ?? null }
  return { outcome: 'undecided' }
}

/** Counts of record mode's log by page view, for D58. */
export function summariseTraffic(pageViews) {
  return pageViews.map((view) => {
    const byHost = {}
    const byType = {}
    for (const r of view.requests) {
      byHost[r.host] = (byHost[r.host] ?? 0) + 1
      byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1
    }
    return {
      path: view.path,
      requests: view.requests.length,
      pageInitiated: view.requests.filter((r) => r.resourceType !== 'mainFrame').length,
      deny: view.requests.filter((r) => r.deny).length,
      cancelled: view.requests.filter((r) => r.cancelled).length,
      byHost,
      byType,
    }
  })
}

// The scrub check: anything shaped like a secret fails it. A false alarm costs a look at the file;
// a miss puts a session or an address in the repo.
const LEAKS = [
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['state or code parameter', /[?&#;](state|code|token|access_token|id_token|ticket)=/i],
  ['state or code field', /"(state|code|otp|token|access_token|id_token|refresh_token)"\s*:\s*"[^"]+/i],
  ['cookie value', /"(value|cookie|set-cookie)"\s*:/i],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['long opaque token', /[A-Za-z0-9_+=-]{40,}/],
  ['card-like number', /\b(?:\d[ -]?){13,19}\b/],
]

/** Every line of `text` that looks like it holds a secret, with what it looks like. */
export function findLeaks(text) {
  const found = []
  text.split('\n').forEach((line, index) => {
    for (const [kind, pattern] of LEAKS) {
      if (pattern.test(line)) found.push({ line: index + 1, kind })
    }
  })
  return found
}
