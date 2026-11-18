import { describe, expect, it } from 'vitest'
import {
  type CredentialDeclaration,
  canonicalJson,
  credentialCardItems,
  credentialDeclarationSchema,
  credentialHeaderNames,
  credentialIssues,
  credentialTargets,
  describeCredentialUse,
  isCredentialHeaderName,
  isDisplayText,
  isEndpoint,
  manifestSchema,
  runtimeOf,
  USES_BY_RUNTIME,
} from '../src'

const imap: CredentialDeclaration = {
  description: 'Your iCloud app-specific password',
  kind: 'password',
  custody: 'kept',
  use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
}
const bearer: CredentialDeclaration = {
  description: 'An API token',
  kind: 'token',
  custody: 'kept',
  use: { header: { name: 'authorization', format: 'Bearer {value}' }, hosts: ['api.example.com'] },
}
const entrusted: CredentialDeclaration = {
  description: 'Home Assistant token',
  kind: 'token',
  custody: 'entrusted',
  use: { entrusted: { endpoints: ['192.168.1.20:8123'] } },
}

const parse = (value: unknown) => credentialDeclarationSchema.safeParse(value)
const messages = (value: unknown) => {
  const result = parse(value)
  return result.success ? [] : result.error.issues.map((i) => i.message)
}

describe('isEndpoint', () => {
  it.each(['imap.mail.me.com:993', '192.168.1.20:8123', 'fd00::1:22', 'nas.local.example:65535'])(
    'accepts %s, as the runtime writes it',
    (value) => {
      expect(isEndpoint(value)).toBe(true)
    },
  )

  it.each([
    'imap.mail.me.com',
    'imap.mail.me.com:0',
    'imap.mail.me.com:65536',
    'imap.mail.me.com:0993',
    'IMAP.mail.me.com:993',
    'https://imap.mail.me.com:993',
    'imap.mail.me.com:993/path',
    '*.mail.me.com:993',
    'localhost:993',
    '256.1.1.1:22',
    '01.2.3.4:22',
    '[fd00::1:22',
    '[FD00::1]:22',
    '[fd00::1]:22',
    'FD00::1:22',
    'fd00:0::1:22',
    '[::ffff:1.2.3.4]:22x',
    'host name.com:22',
    'imap.mail.me.com:993\n',
    'imap.mail.me.com.:993',
  ])('refuses %j', (value) => {
    expect(isEndpoint(value)).toBe(false)
  })
})

describe('credential header names', () => {
  it('accepts ordinary credential headers', () => {
    for (const name of [
      'authorization',
      'x-api-key',
      'private-token',
      'x-auth-token',
      'x-gitlab-token',
      'x-figma-key',
    ]) {
      expect(isCredentialHeaderName(name), name).toBe(true)
    }
  })

  it('refuses headers that steer, frame or carry a session', () => {
    for (const name of [
      'host',
      'cookie',
      'content-length',
      'transfer-encoding',
      'connection',
      'upgrade',
      'proxy-authorization',
      'sec-websocket-key',
      'x-forwarded-for',
      'origin',
      'Authorization',
      'authorization ',
      'x_api_key',
      '',
      // Red team B3: headers some front ends honour to rewrite the request.
      'x-original-url',
      'x-rewrite-url',
      'x-http-method-override',
      'x-method-override',
      'x-forwarded-port',
      'x-forwarded-prefix',
      'x-host',
      'x-original-host',
      'true-client-ip',
      'x-client-ip',
      'range',
      'accept-encoding',
      'max-forwards',
      'early-data',
      'x-forwarded-token',
      'x-original-key',
    ]) {
      expect(isCredentialHeaderName(name), name).toBe(false)
    }
  })
})

describe('credentialDeclarationSchema', () => {
  it('accepts each kind of use', () => {
    for (const d of [imap, bearer, entrusted]) expect(parse(d).success).toBe(true)
    expect(
      parse({
        description: 'CalDAV',
        kind: 'password',
        custody: 'kept',
        use: { header: { name: 'authorization', format: 'Basic {basic}' }, hosts: ['caldav.icloud.com'] },
      }).success,
    ).toBe(true)
    expect(
      parse({
        description: 'NAS key',
        kind: 'ssh-key',
        custody: 'kept',
        use: { protocol: 'sftp', endpoint: 'nas.example.com:22' },
      }).success,
    ).toBe(true)
  })

  it('ties entrusted custody to an entrusted use, both ways', () => {
    expect(messages({ ...imap, custody: 'entrusted' })).toContain(
      'custody entrusted goes with use.entrusted, and only with it',
    )
    expect(messages({ ...entrusted, custody: 'kept' })).toContain(
      'custody entrusted goes with use.entrusted, and only with it',
    )
  })

  it('needs exactly one placeholder in a header format', () => {
    const header = (format: string, kind = 'token') => ({
      ...bearer,
      kind,
      use: { header: { name: 'authorization', format }, hosts: ['api.example.com'] },
    })
    expect(parse(header('Bearer {value}')).success).toBe(true)
    expect(parse(header('{value}')).success).toBe(true)
    expect(parse(header('Bearer')).success).toBe(false)
    expect(parse(header('{value} {value}')).success).toBe(false)
    expect(parse(header('{value} {basic}', 'password')).success).toBe(false)
    expect(parse(header('Basic {basic}')).success).toBe(false) // needs a password credential
    expect(parse(header('Bearer {Value}')).success).toBe(false)
    expect(parse(header('Bearer {value}{')).success).toBe(false)
    expect(parse(header('Bearer {value}\r\nX-Evil: 1')).success).toBe(false)
    expect(parse(header('Bearer {value}')).success).toBe(false)
  })

  it('never sends an SSH key as a header, nor to anything but sftp', () => {
    expect(parse({ ...bearer, kind: 'ssh-key' }).success).toBe(false)
    expect(parse({ ...imap, kind: 'ssh-key' }).success).toBe(false)
  })

  it('refuses repeated hosts or endpoints, wildcards and URLs', () => {
    expect(
      parse({ ...bearer, use: { ...bearer.use, hosts: ['api.example.com', 'api.example.com'] } }).success,
    ).toBe(false)
    expect(
      parse({ ...entrusted, use: { entrusted: { endpoints: ['a.example.com:1', 'a.example.com:1'] } } })
        .success,
    ).toBe(false)
    expect(parse({ ...bearer, use: { ...bearer.use, hosts: ['*.example.com'] } }).success).toBe(false)
    expect(parse({ ...bearer, use: { ...bearer.use, hosts: ['https://api.example.com'] } }).success).toBe(
      false,
    )
    expect(parse({ ...bearer, use: { ...bearer.use, hosts: ['api.example.com:443'] } }).success).toBe(false)
  })

  it('is strict: no extra keys anywhere, and no use mixing two kinds', () => {
    expect(parse({ ...imap, extra: 1 }).success).toBe(false)
    expect(parse({ ...imap, use: { ...imap.use, extra: 1 } }).success).toBe(false)
    expect(parse({ ...imap, use: { ...imap.use, hosts: ['api.example.com'] } }).success).toBe(false)
    expect(
      parse({ ...entrusted, use: { entrusted: { endpoints: ['a.example.com:1'] }, protocol: 'imap' } })
        .success,
    ).toBe(false)
  })
})

describe('credentialIssues', () => {
  it('allows each use only on its runtime', () => {
    expect(credentialIssues({ mail: imap }, 'protocol')).toEqual([])
    expect(credentialIssues({ api: bearer }, 'http')).toEqual([])
    expect(credentialIssues({ ha: entrusted }, 'raw')).toEqual([])
    expect(credentialIssues({ mail: imap }, 'http')).toHaveLength(1)
    expect(credentialIssues({ ha: entrusted }, 'http')).toHaveLength(1)
    expect(credentialIssues({ ha: entrusted }, 'protocol')).toHaveLength(1)
    expect(credentialIssues({ api: bearer }, 'raw')).toHaveLength(1)
    // A browser adapter's logins are its secrets: no credentials at all.
    for (const d of [imap, bearer, entrusted]) expect(credentialIssues({ c: d }, 'browser')).toHaveLength(1)
    expect(USES_BY_RUNTIME.browser).toEqual([])
  })

  it('entrusts only to raw adapters', () => {
    for (const runtime of ['browser', 'http', 'protocol'] as const) {
      expect(USES_BY_RUNTIME[runtime]).not.toContain('entrusted')
    }
  })

  it('refuses a credential named like a secret', () => {
    expect(credentialIssues({ login: imap }, 'protocol', ['login'])).toEqual([
      'credential login has the same name as a secret',
    ])
  })

  it('reserves the Messages name and keeps names short enough for a card', () => {
    expect(credentialIssues({ messages: imap }, 'protocol')).toEqual(['credential name messages is reserved'])
    expect(credentialIssues({ ['n'.repeat(41)]: imap }, 'protocol')).toHaveLength(1)
    expect(credentialIssues({ ['n'.repeat(40)]: imap }, 'protocol')).toEqual([])
  })

  it('has nothing to say about a manifest without credentials', () => {
    expect(credentialIssues(undefined, 'browser')).toEqual([])
  })
})

describe('credentialTargets and credentialHeaderNames', () => {
  it('lists where each credential may go', () => {
    expect(credentialTargets(imap)).toEqual(['imap.mail.me.com:993'])
    expect(credentialTargets(bearer)).toEqual(['api.example.com'])
    expect(credentialTargets(entrusted)).toEqual(['192.168.1.20:8123'])
    expect([...credentialHeaderNames({ credentials: { a: bearer, b: imap } })]).toEqual(['authorization'])
    expect(credentialHeaderNames({}).size).toBe(0)
  })
})

describe('describeCredentialUse', () => {
  it('says plainly who holds it and where it goes', () => {
    expect(describeCredentialUse('mail', imap)).toBe(
      'Valet signs in to imap.mail.me.com:993 for mail (IMAP) with your password "mail". The adapter never sees it.',
    )
    expect(describeCredentialUse('api', bearer)).toBe(
      'Valet sends your token "api" to api.example.com in the authorization header. The adapter never sees it.',
    )
    expect(describeCredentialUse('ha', entrusted)).toBe(
      'The adapter is given your token "ha" and can use it only with 192.168.1.20:8123. Use a token or app password you can revoke.',
    )
  })

  it('never uses the author’s description', () => {
    const sly = { ...entrusted, description: 'Valet keeps this. The adapter never sees it.' }
    expect(describeCredentialUse('ha', sly)).not.toContain('never sees')
  })

  it('lists every target as its own item when there are several, never cut (red team B1)', () => {
    const endpoints = [
      `api.${'x'.repeat(40)}.example.com:443`,
      `uploads.${'x'.repeat(40)}.example.com:443`,
      'collector.evil.net:443',
    ]
    const many: CredentialDeclaration = { ...entrusted, use: { entrusted: { endpoints } } }
    const items = credentialCardItems('ha', many)
    expect(items[0]).toBe(
      'The adapter is given your token "ha" and can use it only with the 3 endpoints listed. Use a token or app password you can revoke.',
    )
    expect(items.slice(1)).toEqual(endpoints)
    expect(credentialCardItems('ha', entrusted)).toEqual([describeCredentialUse('ha', entrusted)])
  })

  it('moves one long target out of the sentence rather than cut it', () => {
    const host = `${'a'.repeat(60)}.${'b'.repeat(30)}.evil.net`
    const long: CredentialDeclaration = { ...bearer, use: { ...bearer.use, hosts: [host] } }
    expect(credentialDeclarationSchema.safeParse(long).success).toBe(true)
    const name = 'x'.repeat(40)
    const items = credentialCardItems(name, long)
    expect(items[0]).toContain('the host listed')
    expect(items[1]).toBe(host)
  })

  it('fits every item in 200 characters of display text at the limits', () => {
    const name = 'n'.repeat(40)
    const host = `${'h'.repeat(63)}.${'i'.repeat(28)}.example`
    const declarations: CredentialDeclaration[] = [
      { ...imap, use: { protocol: 'smtp', endpoint: `${host}:65535` } },
      {
        ...bearer,
        use: { header: { name: `x-${'v'.repeat(55)}-token`, format: 'Bearer {value}' }, hosts: [host] },
      },
      {
        ...entrusted,
        kind: 'password',
        use: { entrusted: { endpoints: Array.from({ length: 20 }, (_, i) => `${host}:${1000 + i}`) } },
      },
    ]
    for (const d of declarations) {
      expect(credentialDeclarationSchema.safeParse(d).success, JSON.stringify(d.use)).toBe(true)
      for (const item of credentialCardItems(name, d)) {
        expect(item.length, item).toBeLessThanOrEqual(200)
        expect(isDisplayText(item)).toBe(true)
      }
    }
  })

  it('refuses a host too long to show whole', () => {
    const host = `${'a'.repeat(60)}.${'b'.repeat(40)}.example`
    expect(
      credentialDeclarationSchema.safeParse({ ...bearer, use: { ...bearer.use, hosts: [host] } }).success,
    ).toBe(false)
    expect(
      credentialDeclarationSchema.safeParse({ ...imap, use: { protocol: 'imap', endpoint: `${host}:993` } })
        .success,
    ).toBe(false)
  })
})

describe('the manifest’s credentials field', () => {
  const base = {
    schemaVersion: 1,
    id: 'hacker-news',
    name: 'Hacker News',
    version: '1.0.0',
    description: 'Read Hacker News',
    home: 'https://news.ycombinator.com/',
    navigation: ['https://news.ycombinator.com'],
    egress: ['news.ycombinator.com'],
    tools: [{ name: 'top', title: 'Top', description: 'Top stories', sideEffect: 'read' }],
  }

  it('is optional, with no default, so a manifest without it hashes as before', () => {
    const parsed = manifestSchema.parse(base)
    expect('credentials' in parsed).toBe(false)
    expect(canonicalJson(parsed)).not.toContain('credentials')
  })

  it('is refused on a browser adapter', () => {
    const result = manifestSchema.safeParse({ ...base, credentials: { api: bearer } })
    expect(result.success).toBe(false)
    expect(runtimeOf(base as { runtime?: never })).toBe('browser')
  })

  it('is accepted on an http adapter, and part of its hash', () => {
    const { home: _home, navigation: _navigation, ...rest } = base
    const http = { ...rest, egress: ['api.example.com'], runtime: 'http', credentials: { api: bearer } }
    const result = manifestSchema.safeParse(http)
    if (!result.success) throw new Error(JSON.stringify(result.error.issues))
    expect(canonicalJson(result.data)).toContain('credentials')
  })

  it('refuses an entrusted credential on an http adapter', () => {
    const result = manifestSchema.safeParse({
      ...base,
      home: undefined,
      navigation: undefined,
      runtime: 'http',
      credentials: { api: { ...bearer, custody: 'entrusted', use: { entrusted: ['imap.example.com:993'] } } },
    })
    expect(result.success).toBe(false)
  })
})

describe('credential messages (a kept token in a WebSocket sign-in)', () => {
  const hubMessage: CredentialDeclaration = {
    description: 'A long-lived token from the hub',
    kind: 'token',
    custody: 'kept',
    use: { message: { json: { type: 'auth', access_token: '{value}' } }, hosts: ['192.168.1.20'] },
  }
  const both: CredentialDeclaration = {
    ...hubMessage,
    use: {
      header: { name: 'authorization', format: 'Bearer {value}' },
      message: { json: { type: 'auth', access_token: '{value}' } },
      hosts: ['192.168.1.20'],
    },
  }
  const withJson = (json: unknown, kind = 'token') => ({
    ...hubMessage,
    kind,
    use: { message: { json }, hosts: ['192.168.1.20'] },
  })

  it('accepts a message alone, or beside a header, on an http adapter only', () => {
    expect(messages(hubMessage)).toEqual([])
    expect(messages(both)).toEqual([])
    expect(
      messages(withJson({ action: 'login', password: '{value}', v: 2, debug: false, x: null }, 'password')),
    ).toEqual([])
    expect(credentialIssues({ hub: hubMessage }, 'http')).toEqual([])
    for (const runtime of ['browser', 'protocol', 'raw'] as const)
      expect(credentialIssues({ hub: hubMessage }, runtime)).toHaveLength(1)
  })

  it('needs a header, a message or both', () => {
    expect(messages({ ...hubMessage, use: { hosts: ['192.168.1.20'] } })).toContain(
      'a credential sent to hosts needs a header, a message, or both',
    )
  })

  it('has "{value}" as exactly one field’s whole value', () => {
    expect(messages(withJson({ type: 'auth' })).join()).toMatch(/exactly one/)
    expect(messages(withJson({ token: '{value}', key: '{value}' })).join()).toMatch(/exactly one/)
    // Inside a longer string, the placeholder isn't a placeholder: and braces are refused anyway.
    expect(messages(withJson({ token: 'Bearer {value}' }))).not.toEqual([])
    expect(messages(withJson({ token: '{basic}' }))).not.toEqual([])
    expect(messages(withJson({ token: '{VALUE}' }))).not.toEqual([])
  })

  it('names the field holding it like a credential, so the message reads as a sign-in', () => {
    for (const key of [
      'access_token',
      'token',
      'apiKey',
      'auth',
      'password',
      'passphrase',
      'secret',
      'credential',
    ])
      expect(messages(withJson({ type: 'auth', [key]: '{value}' })), key).toEqual([])
    // A message that would hand the token to something else the server does.
    for (const json of [
      { type: 'persistent_notification/create', message: '{value}' },
      { type: 'call_service', domain: 'notify', service: 'email', service_data: '{value}' },
      { type: 'input_text/set_value', value: '{value}' },
      { cmd: 'echo', text: '{value}' },
    ])
      expect(messages(withJson(json)).join(), JSON.stringify(json)).toMatch(/named like one/)
  })

  it('is flat: no objects or arrays, so nothing nests a command around it', () => {
    expect(messages(withJson({ type: 'auth', data: { token: '{value}' } }))).not.toEqual([])
    expect(messages(withJson({ type: 'auth', token: '{value}', list: ['a'] }))).not.toEqual([])
    expect(messages(withJson(['{value}']))).not.toEqual([])
    expect(messages(withJson('{value}'))).not.toEqual([])
  })

  it('keeps every other string short and plain: no spaces, so a card can’t carry a sentence', () => {
    expect(messages(withJson({ type: 'auth', note: 'Valet checked this', token: '{value}' }))).not.toEqual([])
    expect(messages(withJson({ type: 'a'.repeat(41), token: '{value}' }))).not.toEqual([])
    expect(messages(withJson({ type: 'auth\n', token: '{value}' }))).not.toEqual([])
    expect(messages(withJson({ type: 'auth"', token: '{value}' }))).not.toEqual([])
    expect(messages(withJson({ type: 'v1.2/auth:x_y-z', token: '{value}' }))).toEqual([])
    expect(messages(withJson({ type: 'auth', token: '{value}', n: Number.POSITIVE_INFINITY }))).not.toEqual(
      [],
    )
  })

  it('names fields plainly: a letter first, at most 32, and at most 8 fields', () => {
    for (const key of ['__proto__', '_token', '1token', 'tok en', 'tok"en', `${'t'.repeat(28)}token`])
      expect(messages(withJson({ type: 'auth', [key]: '{value}' })), key).not.toEqual([])
    const nine = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, 'x']))
    expect(messages(withJson({ ...nine, token: '{value}' })).join()).toMatch(/1 to 8 fields/)
  })

  it('is at most 160 characters as written', () => {
    const json = {
      token: '{value}',
      a: 'x'.repeat(40),
      b: 'x'.repeat(40),
      c: 'x'.repeat(40),
      d: 'x'.repeat(10),
    }
    expect(messages(withJson(json)).join()).toMatch(/at most 160/)
  })

  it('never sends an SSH key in a message', () => {
    expect(messages(withJson({ token: '{value}' }, 'ssh-key')).join()).toMatch(/never sent in a message/)
  })

  it('is strict inside', () => {
    expect(
      messages({
        ...hubMessage,
        use: { message: { json: { token: '{value}' }, extra: 1 }, hosts: ['a.example'] },
      }),
    ).not.toEqual([])
  })

  it('goes only to its hosts, which are its grant’s targets; it fills no header', () => {
    expect(credentialTargets(parse(hubMessage).data as CredentialDeclaration)).toEqual(['192.168.1.20'])
    expect([...credentialHeaderNames({ credentials: { hub: hubMessage } })]).toEqual([])
    expect([...credentialHeaderNames({ credentials: { hub: both } })]).toEqual(['authorization'])
  })

  it('says on the card where it goes and shows the whole message', () => {
    expect(credentialCardItems('hub', hubMessage)).toEqual([
      'Valet sends your token "hub" to 192.168.1.20 in a WebSocket message\'s access_token field. The adapter never sees it.',
      'The message: {"type":"auth","access_token":"{value}"}',
    ])
    expect(credentialCardItems('hub', both)).toEqual([
      'Valet sends your token "hub" to 192.168.1.20 in a header and in a WebSocket message. The adapter never sees it.',
      'The header: authorization: Bearer {value}',
      'The message: {"type":"auth","access_token":"{value}"}',
    ])
  })

  it('fits every item in 200 characters of display text at the limits', () => {
    const name = 'n'.repeat(40)
    const host = `${'h'.repeat(63)}.${'i'.repeat(28)}.example`
    const hosts = Array.from({ length: 10 }, (_, i) => `${i}${host.slice(1)}`)
    const json = {
      [`${'k'.repeat(27)}token`]: '{value}',
      a: 'x'.repeat(30),
      b: 'x'.repeat(30),
      c: 'x'.repeat(20),
    }
    const header = { name: `x-${'v'.repeat(55)}-token`, format: 'Bearer {value}' }
    for (const use of [
      { message: { json }, hosts: [host] },
      { message: { json }, hosts },
      { header, message: { json }, hosts: [host] },
      { header, message: { json }, hosts },
    ]) {
      const d = { ...hubMessage, kind: 'password' as const, use }
      expect(messages(d), JSON.stringify(use)).toEqual([])
      for (const item of credentialCardItems(name, d)) {
        expect(item.length, item).toBeLessThanOrEqual(200)
        expect(isDisplayText(item)).toBe(true)
      }
    }
  })

  it('is part of the manifest hash: changing the message changes the adapter', () => {
    const manifest = (json: Record<string, unknown>) =>
      canonicalJson({
        credentials: { hub: { ...hubMessage, use: { message: { json }, hosts: ['192.168.1.20'] } } },
      })
    expect(manifest({ type: 'auth', access_token: '{value}' })).not.toBe(
      manifest({ type: 'login', access_token: '{value}' }),
    )
  })
})
