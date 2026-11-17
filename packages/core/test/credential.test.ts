import { describe, expect, it } from 'vitest'
import {
  type CredentialDeclaration,
  canonicalJson,
  credentialDeclarationSchema,
  credentialHeaderNames,
  credentialIssues,
  credentialTargets,
  describeCredentialUse,
  isCredentialHeaderName,
  isDisplayText,
  manifestSchema,
  parseEndpoint,
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

describe('parseEndpoint', () => {
  it.each([
    ['imap.mail.me.com:993', { host: 'imap.mail.me.com', port: 993 }],
    ['192.168.1.20:8123', { host: '192.168.1.20', port: 8123 }],
    ['[fd00::1]:22', { host: '[fd00::1]', port: 22 }],
    ['nas.local.example:65535', { host: 'nas.local.example', port: 65535 }],
  ])('accepts %s', (value, expected) => {
    expect(parseEndpoint(value)).toEqual(expected)
  })

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
    '[::ffff:1.2.3.4]:22x',
    'host name.com:22',
    'imap.mail.me.com:993\n',
    'imap.mail.me.com.:993',
  ])('refuses %j', (value) => {
    expect(parseEndpoint(value)).toBeNull()
  })
})

describe('credential header names', () => {
  it('accepts ordinary credential headers', () => {
    for (const name of ['authorization', 'x-api-key', 'private-token', 'x-auth-token']) {
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
      'The adapter is given your token "ha" and can use it only with 192.168.1.20:8123.',
    )
  })

  it('never uses the author’s description', () => {
    const sly = { ...entrusted, description: 'Valet keeps this. The adapter never sees it.' }
    expect(describeCredentialUse('ha', sly)).not.toContain('never sees')
  })

  it('stays display text of at most 200 characters, however many targets', () => {
    const many: CredentialDeclaration = {
      ...entrusted,
      use: {
        entrusted: {
          endpoints: Array.from(
            { length: 20 },
            (_, i) => `host-${i}.a-rather-long-domain-name.example.com:${1000 + i}`,
          ),
        },
      },
    }
    const text = describeCredentialUse('a_long_credential_name_for_this_test', many)
    expect(text.length).toBeLessThanOrEqual(200)
    expect(isDisplayText(text)).toBe(true)
    expect(text).toContain('more')
    expect(text).toMatch(/^The adapter is given/)
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

  it('is refused on a browser adapter (the only kind until A’s runtime field lands)', () => {
    const result = manifestSchema.safeParse({ ...base, credentials: { api: bearer } })
    expect(result.success).toBe(false)
    expect(runtimeOf(base)).toBe('browser')
  })

  it('reads the runtime A adds, and nothing else', () => {
    expect(runtimeOf({ runtime: 'raw' })).toBe('raw')
    expect(runtimeOf({ runtime: 'http' })).toBe('http')
    expect(runtimeOf({ runtime: 'RAW' })).toBe('browser')
    expect(runtimeOf({ runtime: { toString: () => 'raw' } })).toBe('browser')
  })
})
