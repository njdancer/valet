import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  evaluateScript,
  extractScript,
  fetchScript,
  focusScript,
  frameOffsetScript,
  inspectScript,
  jsonLiteral,
  pointScript,
  readStorageScript,
  textPresentScript,
  writeStorageScript,
} from '../src/scripts'
import { FakeForm, FakeWindow } from './fake-dom'

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

// Strings that would break out of a script built by concatenation, in every quoting style.
const BREAKOUTS = [
  "'); alert(1); ('",
  '"); alert(1); ("',
  '`); alert(1); (`',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a template placeholder is the breakout under test
  '${alert(1)}',
  "\\'); alert(1); //",
  '\\"); alert(1); //',
  '</script><script>alert(1)</script>',
  `${LINE_SEPARATOR}alert(1)${PARAGRAPH_SEPARATOR}`,
  '\n}); alert(1); ((x) => {',
  '*/ alert(1) /*',
]

describe('jsonLiteral', () => {
  it('is a JavaScript literal that evaluates back to the same value', () => {
    for (const value of [...BREAKOUTS, 0, true, null, ['a', 'b'], { nested: { deep: "it's" } }]) {
      expect(vm.runInNewContext(`(${jsonLiteral(value)})`)).toEqual(value)
    }
  })

  it('escapes the line and paragraph separators', () => {
    expect(jsonLiteral(`${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`)).toBe('"\\u2028\\u2029"')
  })

  it('refuses values JSON cannot carry', () => {
    expect(() => jsonLiteral(undefined)).toThrow(TypeError)
    expect(() => jsonLiteral(() => 1)).toThrow(TypeError)
    expect(() => jsonLiteral(10n)).toThrow()
  })
})

describe('selectors are data, never code', () => {
  const builders: [string, (selector: string) => string][] = [
    ['inspect', inspectScript],
    ['point', pointScript],
    ['focus', focusScript],
    ['extract', (s) => extractScript(s, null, false)],
  ]

  for (const [name, build] of builders) {
    it(`${name}: a breakout selector reaches querySelector intact and runs nothing`, () => {
      for (const selector of BREAKOUTS) {
        const window = new FakeWindow()
        window.run(build(selector))
        expect(window.document.queried).toEqual([selector])
        expect(window.calls).toEqual([])
      }
    })
  }

  it('text for textPresent is data too', () => {
    for (const text of BREAKOUTS) {
      const window = new FakeWindow()
      window.document.body = { innerText: `before ${text} after` }
      expect(window.run(textPresentScript(text))).toBe(true)
      expect(window.calls).toEqual([])
    }
  })

  it('storage keys and values are data too', () => {
    const window = new FakeWindow()
    window.run(writeStorageScript(BREAKOUTS.map((key) => [key, key])))
    expect(window.calls).toEqual([])
    expect(window.run(readStorageScript(BREAKOUTS))).toEqual(Object.fromEntries(BREAKOUTS.map((k) => [k, k])))
  })
})

describe('inspectScript', () => {
  it('describes a password input in a form', () => {
    const window = new FakeWindow()
    const input = window.document.add(
      '#password',
      window.document.element('INPUT', {
        type: 'password',
        attributes: { autocomplete: 'Current-Password' },
      }),
    )
    input.form = new FakeForm('https://www.example.com/login')
    expect(window.run(inspectScript('#password'))).toEqual({
      visible: true,
      tagName: 'input',
      inputType: 'password',
      autocomplete: 'current-password',
      inputMode: null,
      formAction: 'https://www.example.com/login',
    })
  })

  it('reports inputmode lower-cased and no form', () => {
    const window = new FakeWindow()
    window.document.add(
      '#code',
      window.document.element('INPUT', { type: 'text', attributes: { inputmode: 'Numeric' } }),
    )
    expect(window.run(inspectScript('#code'))).toMatchObject({ inputMode: 'numeric', formAction: null })
  })

  it('gives null for the input type of anything that is not an input', () => {
    const window = new FakeWindow()
    window.document.add('#go', window.document.element('BUTTON'))
    expect(window.run(inspectScript('#go'))).toMatchObject({ tagName: 'button', inputType: null })
  })

  it('reads the form action through the prototype, so a control named "action" cannot spoof it', () => {
    const window = new FakeWindow()
    const input = window.document.add('#password', window.document.element('INPUT', { type: 'password' }))
    const form = new FakeForm('https://evil.test/steal')
    // In a browser, <input name="action"> makes form.action return that input.
    Object.defineProperty(form, 'action', { value: 'https://www.example.com/login' })
    input.form = form
    expect(window.run(inspectScript('#password'))).toMatchObject({ formAction: 'https://evil.test/steal' })
  })

  it('ignores a form property that is not a real form', () => {
    const window = new FakeWindow()
    const input = window.document.add('#password', window.document.element('INPUT', { type: 'password' }))
    ;(input as { form: unknown }).form = { action: 'https://www.example.com/' }
    expect(window.run(inspectScript('#password'))).toMatchObject({ formAction: null })
  })

  it('is not visible when hidden by style or with no size', () => {
    const window = new FakeWindow()
    const hidden = window.document.add('#hidden', window.document.element('INPUT', { type: 'text' }))
    hidden.shown = false
    window.document.add(
      '#empty',
      window.document.element('INPUT', { type: 'text', rect: { left: 0, top: 0, width: 0, height: 0 } }),
    )
    expect(window.run(inspectScript('#hidden'))).toMatchObject({ visible: false })
    expect(window.run(inspectScript('#empty'))).toMatchObject({ visible: false })
  })

  it('falls back to computed visibility where checkVisibility is missing', () => {
    const window = new FakeWindow()
    const el = window.document.add('#x', window.document.element('INPUT', { type: 'text' }))
    ;(el as { checkVisibility: unknown }).checkVisibility = undefined
    expect(window.run(inspectScript('#x'))).toMatchObject({ visible: true })
    el.shown = false
    expect(window.run(inspectScript('#x'))).toMatchObject({ visible: false })
  })

  it('reports an invalid selector without echoing it', () => {
    const window = new FakeWindow()
    window.document.invalidSelectors.add('[[')
    expect(window.run(inspectScript('[['))).toEqual({ error: 'invalid-selector' })
  })
})

describe('pointScript', () => {
  it('scrolls the element into view and gives its centre', () => {
    const window = new FakeWindow()
    const button = window.document.add(
      '#go',
      window.document.element('BUTTON', { rect: { left: 100, top: 200, width: 50, height: 20 } }),
    )
    expect(window.run(pointScript('#go'))).toEqual({ x: 125, y: 210, hit: true, indexInParent: null })
    expect(button.scrolledIntoView).toBe(1)
  })

  it('counts a click on a child of the element as a hit', () => {
    const window = new FakeWindow()
    const button = window.document.add('#go', window.document.element('BUTTON'))
    const label = window.document.element('SPAN')
    button.children.push(label)
    window.document.hitTest = () => label
    expect(window.run(pointScript('#go'))).toMatchObject({ hit: true })
  })

  it('reports a miss when something else covers the centre', () => {
    const window = new FakeWindow()
    window.document.add('#go', window.document.element('BUTTON'))
    const overlay = window.document.element('DIV')
    window.document.hitTest = () => overlay
    expect(window.run(pointScript('#go'))).toMatchObject({ hit: false })
  })

  it('reports nothing is under the point', () => {
    const window = new FakeWindow()
    window.document.add('#go', window.document.element('BUTTON'))
    window.document.hitTest = () => null
    expect(window.run(pointScript('#go'))).toMatchObject({ hit: false })
  })

  it('refuses an element with no size', () => {
    const window = new FakeWindow()
    window.document.add(
      '#go',
      window.document.element('BUTTON', { rect: { left: 1, top: 1, width: 0, height: 5 } }),
    )
    expect(window.run(pointScript('#go'))).toEqual({ error: 'not-visible' })
  })

  it('reports its index in the parent from inside a child frame', () => {
    const parent = new FakeWindow()
    parent.attachChild(new FakeWindow())
    const child = new FakeWindow()
    parent.attachChild(child)
    child.document.add('#go', child.document.element('BUTTON'))
    expect(child.run(pointScript('#go'))).toMatchObject({ indexInParent: 1 })
  })

  it('reports no index when the parent does not list it', () => {
    const child = new FakeWindow({ parent: new FakeWindow().global })
    child.document.add('#go', child.document.element('BUTTON'))
    expect(child.run(pointScript('#go'))).toMatchObject({ indexInParent: null })
  })

  it('reports an invalid selector', () => {
    const window = new FakeWindow()
    window.document.invalidSelectors.add('a[')
    expect(window.run(pointScript('a['))).toEqual({ error: 'invalid-selector' })
  })
})

describe('frameOffsetScript', () => {
  it('finds the iframe element for a child index and gives its content box', () => {
    const parent = new FakeWindow()
    const child = new FakeWindow()
    parent.attachChild(child)
    const iframe = parent.document.add(
      'iframe, frame',
      parent.document.element('IFRAME', { rect: { left: 40, top: 300, width: 400, height: 200 } }),
    )
    iframe.contentWindow = child.global
    iframe.clientLeft = 2
    iframe.clientTop = 3
    expect(parent.run(frameOffsetScript(0))).toEqual({ x: 42, y: 303, indexInParent: null })
    expect(iframe.scrolledIntoView).toBe(1)
  })

  it('gives null for an index with no frame', () => {
    expect(new FakeWindow().run(frameOffsetScript(3))).toBeNull()
  })

  it('gives null when no iframe element holds that frame', () => {
    const parent = new FakeWindow()
    parent.attachChild(new FakeWindow())
    parent.document.add('iframe, frame', parent.document.element('IFRAME'))
    expect(parent.run(frameOffsetScript(0))).toBeNull()
  })
})

describe('focusScript', () => {
  it('focuses an input and selects its contents, so typing replaces them', () => {
    const window = new FakeWindow()
    const input = window.document.add('#user', window.document.element('INPUT', { type: 'email' }))
    expect(window.run(focusScript('#user'))).toEqual({ focused: true })
    expect(window.document.activeElement).toBe(input)
    expect(input.selected).toBe(true)
  })

  it('survives an input type whose select() throws', () => {
    const window = new FakeWindow()
    const input = window.document.add('#n', window.document.element('INPUT', { type: 'number' }))
    input.select = () => {
      throw new Error('InvalidStateError')
    }
    expect(window.run(focusScript('#n'))).toEqual({ focused: true })
  })

  it('selects the contents of a contenteditable element', () => {
    const window = new FakeWindow()
    const div = window.document.add('#editor', window.document.element('DIV'))
    div.isContentEditable = true
    expect(window.run(focusScript('#editor'))).toEqual({ focused: true })
    expect(window.calls).toEqual(['removeAllRanges', 'addRange'])
  })

  it('says so when the element would not take focus', () => {
    const window = new FakeWindow()
    const div = window.document.add('#static', window.document.element('DIV'))
    div.focusable = false
    expect(window.run(focusScript('#static'))).toEqual({ focused: false })
  })

  it('gives null when nothing matches and reports an invalid selector', () => {
    const window = new FakeWindow()
    window.document.invalidSelectors.add('::')
    expect(window.run(focusScript('#nothing'))).toBeNull()
    expect(window.run(focusScript('::'))).toEqual({ error: 'invalid-selector' })
  })
})

describe('textPresentScript', () => {
  it('looks in the rendered text of the body', () => {
    const window = new FakeWindow()
    window.document.body = { innerText: 'Welcome back, Nick' }
    expect(window.run(textPresentScript('Welcome back'))).toBe(true)
    expect(window.run(textPresentScript('Sign in'))).toBe(false)
  })

  it('is false before there is a body', () => {
    const window = new FakeWindow()
    window.document.body = null
    expect(window.run(textPresentScript('x'))).toBe(false)
  })
})

describe('extractScript', () => {
  it('gives the trimmed text of the first match, or null', () => {
    const window = new FakeWindow()
    const price = window.document.add('.price', window.document.element('SPAN'))
    price.textContent = '  $4.50 \n'
    expect(window.run(extractScript('.price', null, false))).toEqual({ value: '$4.50' })
    expect(window.run(extractScript('.missing', null, false))).toEqual({ value: null })
  })

  it('gives every match, or an attribute', () => {
    const window = new FakeWindow()
    window.document.add('a', window.document.element('A', { attributes: { href: '/one' } }))
    window.document.add('a', window.document.element('A', { attributes: { href: '/two' } }))
    expect(window.run(extractScript('a', 'href', true))).toEqual({ value: ['/one', '/two'] })
    expect(window.run(extractScript('a', null, true))).toEqual({ value: ['', ''] })
  })

  it('reports an invalid selector', () => {
    const window = new FakeWindow()
    window.document.invalidSelectors.add('>>')
    expect(window.run(extractScript('>>', null, false))).toEqual({ error: 'invalid-selector' })
  })
})

describe('fetchScript', () => {
  it('sends same-origin credentials and a JSON body, and parses a JSON response', async () => {
    const requests: [string, unknown][] = []
    const window = new FakeWindow({
      fetch: async (url, init) => {
        requests.push([url, init])
        return {
          status: 200,
          headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
          text: async () => '{"TrolleyItemCount":3}',
        }
      },
    })
    const result = await window.run(
      fetchScript({
        url: 'https://www.example.com/api/v3/ui/trolley/update',
        method: 'POST',
        headers: { accept: 'application/json' },
        hasJson: true,
        json: { items: [{ stockcode: 1, quantity: 2 }] },
      }),
    )
    expect(result).toEqual({
      status: 200,
      contentType: 'application/json',
      body: { TrolleyItemCount: 3 },
      redirected: false,
    })
    expect(requests).toEqual([
      [
        'https://www.example.com/api/v3/ui/trolley/update',
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: '{"items":[{"stockcode":1,"quantity":2}]}',
        },
      ],
    ])
  })

  it('says when the answer came after a redirect, as a page sent on to sign in gets', async () => {
    const window = new FakeWindow({
      fetch: async () => ({
        status: 200,
        redirected: true,
        headers: { get: () => 'text/html' },
        text: async () => '<form>',
      }),
    })
    expect(
      await window.run(
        fetchScript({
          url: 'https://www.example.com/account',
          method: 'GET',
          headers: {},
          hasJson: false,
          json: null,
        }),
      ),
    ).toEqual({
      status: 200,
      contentType: 'text/html',
      body: '<form>',
      redirected: true,
    })
  })

  it('keeps a content type the caller set, in any case', async () => {
    let seen: unknown = null
    const window = new FakeWindow({
      fetch: async (_url, init) => {
        seen = init
        return { status: 204, headers: { get: () => null }, text: async () => '' }
      },
    })
    await window.run(
      fetchScript({
        url: 'https://www.example.com/x',
        method: 'PUT',
        headers: { 'Content-Type': 'application/vnd.example+json' },
        hasJson: true,
        json: null,
      }),
    )
    expect(seen).toMatchObject({ headers: { 'Content-Type': 'application/vnd.example+json' }, body: 'null' })
  })

  it('gives text back when the body is not JSON, and sends no body without one', async () => {
    let seen: unknown = null
    const window = new FakeWindow({
      fetch: async (_url, init) => {
        seen = init
        return {
          status: 403,
          headers: { get: () => 'text/html' },
          text: async () => '<h1>Access Denied</h1>',
        }
      },
    })
    const result = await window.run(
      fetchScript({
        url: 'https://www.example.com/',
        method: 'GET',
        headers: {},
        hasJson: false,
        json: null,
      }),
    )
    expect(result).toEqual({
      status: 403,
      contentType: 'text/html',
      body: '<h1>Access Denied</h1>',
      redirected: false,
    })
    expect(seen).toEqual({ method: 'GET', headers: {}, credentials: 'same-origin' })
  })

  it('reports a network failure without its message', async () => {
    const window = new FakeWindow()
    const result = await window.run(
      fetchScript({ url: 'https://evil.test/', method: 'GET', headers: {}, hasJson: false, json: null }),
    )
    expect(result).toEqual({ error: 'network' })
  })

  it('tells a fetch the page’s own policy refused from a network failure', async () => {
    let window: FakeWindow | null = null
    window = new FakeWindow({
      fetch: () => {
        // As Chromium does it: the promise rejects first, and the violation event follows.
        setTimeout(() =>
          window?.document.dispatchEvent('securitypolicyviolation', {
            isTrusted: true,
            effectiveDirective: 'connect-src',
            blockedURI: 'https://api.example.com/v0/item/1.json',
          }),
        )
        return Promise.reject(new TypeError('Failed to fetch'))
      },
    })
    const result = await window.run(
      fetchScript({
        url: 'https://api.example.com/v0/item/1.json',
        method: 'GET',
        headers: {},
        hasJson: false,
        json: null,
      }),
    )
    expect(result).toEqual({ error: 'page-policy' })
    expect(window.document.listeners.get('securitypolicyviolation')?.size).toBe(0)
  })

  it('ignores a policy violation for another origin or directive, or not from the browser', async () => {
    let window: FakeWindow | null = null
    window = new FakeWindow({
      fetch: () => {
        window?.document.dispatchEvent('securitypolicyviolation', {
          isTrusted: true,
          effectiveDirective: 'connect-src',
          blockedURI: 'https://analytics.example.net/collect',
        })
        // One the page's own scripts made up.
        window?.document.dispatchEvent('securitypolicyviolation', {
          effectiveDirective: 'connect-src',
          blockedURI: 'https://api.example.com/x',
        })
        window?.document.dispatchEvent('securitypolicyviolation', {
          isTrusted: true,
          effectiveDirective: 'img-src',
          blockedURI: 'https://api.example.com/pixel.gif',
        })
        return Promise.reject(new TypeError('Failed to fetch'))
      },
    })
    const result = await window.run(
      fetchScript({
        url: 'https://api.example.com/x',
        method: 'GET',
        headers: {},
        hasJson: false,
        json: null,
      }),
    )
    expect(result).toEqual({ error: 'network' })
  })
})

describe('evaluateScript', () => {
  it('runs an expression with args and returns plain data', async () => {
    const window = new FakeWindow()
    expect(await window.run(evaluateScript('args.a + args.b', { a: 2, b: 3 }))).toBe(5)
  })

  it('awaits an async IIFE', async () => {
    const window = new FakeWindow()
    expect(await window.run(evaluateScript('(async () => ({ ok: args }))()', 'x'))).toEqual({ ok: 'x' })
  })

  it('gives null for undefined results and missing args', async () => {
    const window = new FakeWindow()
    expect(await window.run(evaluateScript('undefined', undefined))).toBeNull()
    expect(await window.run(evaluateScript('args', undefined))).toBeNull()
  })

  it('strips what JSON cannot carry from the result', async () => {
    const window = new FakeWindow()
    expect(await window.run(evaluateScript('({ fn: () => 1, n: 1, d: new Date(0) })', null))).toEqual({
      n: 1,
      d: '1970-01-01T00:00:00.000Z',
    })
  })

  it('survives a trailing line comment in the source', async () => {
    const window = new FakeWindow()
    expect(await window.run(evaluateScript('1 + 1 // two', null))).toBe(2)
  })

  it('refuses args JSON cannot carry', () => {
    expect(() => evaluateScript('1', { big: 1n })).toThrow()
  })
})
