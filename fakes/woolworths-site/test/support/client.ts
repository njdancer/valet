// A minimal cookie-carrying HTTP client for exercising the fake over real sockets. It does what a
// browser would that matters here: keeps cookies, and runs the sensor script's one effect (setting
// `_abck`) when told to. Redirects are not followed, so tests can assert on them.

export interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly setCookies: readonly string[]
}

export function sensorValueIn(html: string): string | null {
  return /document\.cookie = '_abck=([^;']+);/.exec(html)?.[1] ?? null
}

export class Client {
  readonly cookies = new Map<string, string>()

  constructor(readonly origin: string) {}

  async request(
    method: string,
    path: string,
    body?: { readonly form?: Record<string, string>; readonly json?: unknown; readonly raw?: string },
  ): Promise<Reply> {
    const headers = new Headers()
    if (this.cookies.size > 0) {
      headers.set('cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    let payload: string | undefined
    if (body?.form !== undefined) {
      headers.set('content-type', 'application/x-www-form-urlencoded')
      payload = new URLSearchParams(body.form).toString()
    } else if (body?.json !== undefined) {
      headers.set('content-type', 'application/json')
      payload = JSON.stringify(body.json)
    } else if (body?.raw !== undefined) {
      headers.set('content-type', 'application/json')
      payload = body.raw
    }
    const response = await fetch(new URL(path, this.origin), {
      method,
      headers,
      body: payload,
      redirect: 'manual',
    })
    const setCookies = response.headers.getSetCookie()
    for (const line of setCookies) {
      const [pair = ''] = line.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      if (/max-age=0(;|$)/i.test(line)) this.cookies.delete(name)
      else this.cookies.set(name, pair.slice(index + 1))
    }
    return { status: response.status, headers: response.headers, text: await response.text(), setCookies }
  }

  get(path: string): Promise<Reply> {
    return this.request('GET', path)
  }

  postForm(path: string, form: Record<string, string>): Promise<Reply> {
    return this.request('POST', path, { form })
  }

  postJson(path: string, json: unknown): Promise<Reply> {
    return this.request('POST', path, { json })
  }

  /** Loads a page and, like a browser running its inline sensor script, keeps the `_abck` it sets. */
  async visit(path = '/'): Promise<Reply> {
    const reply = await this.get(path)
    const sensor = sensorValueIn(reply.text)
    if (sensor !== null && !this.cookies.has('_abck')) this.cookies.set('_abck', sensor)
    return reply
  }
}
