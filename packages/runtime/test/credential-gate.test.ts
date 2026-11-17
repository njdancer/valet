import {
  type AuditEvent,
  type CredentialDeclaration,
  type CredentialGrant,
  type ItemField,
  SecretValue,
  ValetError,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import { CredentialGate, type CredentialGateOptions } from '../src/credential-gate'
import { REDACTED, redactOutput, SecretRedactionSet, sensitiveMatcher } from '../src/redaction'

const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

const credentials: Record<string, CredentialDeclaration> = {
  mail: {
    description: 'iCloud app password',
    kind: 'password',
    custody: 'kept',
    use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
  },
  api: {
    description: 'API token',
    kind: 'token',
    custody: 'kept',
    use: {
      header: { name: 'authorization', format: 'Bearer {value}' },
      hosts: ['api.example.com', 'b.example.com'],
    },
  },
  dav: {
    description: 'CalDAV',
    kind: 'password',
    custody: 'kept',
    use: { header: { name: 'authorization', format: 'Basic {basic}' }, hosts: ['caldav.icloud.com'] },
  },
  ha: {
    description: 'Home Assistant',
    kind: 'token',
    custody: 'entrusted',
    use: { entrusted: { endpoints: ['192.168.1.20:8123', '192.168.1.21:8123'] } },
  },
  nas: {
    description: 'NAS key',
    kind: 'ssh-key',
    custody: 'kept',
    use: { protocol: 'sftp', endpoint: 'nas.example.com:22' },
  },
}

const ITEMS: Record<string, Partial<Record<ItemField, string>>> = {
  'op://v/mail': { username: 'nick@icloud.example', password: 'abcd-efgh-ijkl-mnop' },
  'op://v/api': { token: 'tok_live_9f8e7d6c5b4a' },
  'op://v/dav': { username: 'nick@icloud.example', password: 'qrst-uvwx-yzab-cdef' },
  'op://v/ha': { token: 'eyJhbGciOiJIUzI1NiJ9.ha-token-value' },
  'op://v/nas': {
    'ssh-key':
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\n',
  },
}

function grantFor(name: string, overrides: Partial<CredentialGrant> = {}): CredentialGrant {
  const d = credentials[name] as CredentialDeclaration
  const targets =
    'protocol' in d.use ? [d.use.endpoint] : 'header' in d.use ? d.use.hosts : d.use.entrusted.endpoints
  return {
    adapterId: 'mail-reader',
    adapterHash: HASH,
    credential: name,
    kind: d.kind,
    custody: d.custody,
    provider: 'fake',
    itemRef: `op://v/${name}`,
    targets,
    grantedAt: '2026-11-17T00:00:00Z',
    ...overrides,
  }
}

interface World {
  gate: CredentialGate
  audit: AuditEvent[]
  set: SecretRedactionSet
  resolved: { itemRef: string; field: ItemField }[]
}

function world(
  overrides: Partial<CredentialGateOptions> = {},
  grants?: Record<string, CredentialGrant | null>,
): World {
  const audit: AuditEvent[] = []
  const set = new SecretRedactionSet()
  const resolved: World['resolved'] = []
  const gate = new CredentialGate({
    adapterId: 'mail-reader',
    adapterHash: HASH,
    credentials,
    findGrant: async (name) => (grants !== undefined ? (grants[name] ?? null) : grantFor(name)),
    resolve: async (grant, field) => {
      resolved.push({ itemRef: grant.itemRef, field })
      const value = ITEMS[grant.itemRef]?.[field]
      if (value === undefined) throw new ValetError('credential', 'field-missing')
      return SecretValue.fromString(value)
    },
    audit: {
      append: async (event) => {
        audit.push(event)
      },
    },
    remember: (secret) => set.register(secret),
    callId: 'call-1',
    ...overrides,
  })
  return { gate, audit, set, resolved }
}

const reveal = (v: SecretValue) => v.reveal((s) => s)

describe('headerFor', () => {
  it('fills the declared header for a declared host, audits it, and registers it for redaction', async () => {
    const w = world()
    const { name, value } = await w.gate.headerFor('api', 'api.example.com')
    expect(name).toBe('authorization')
    expect(reveal(value)).toBe('Bearer tok_live_9f8e7d6c5b4a')
    expect(w.audit).toEqual([
      {
        type: 'secret-used',
        adapterId: 'mail-reader',
        adapterHash: HASH,
        secret: 'api',
        field: 'token',
        origin: 'api.example.com',
        callId: 'call-1',
        custody: 'kept',
      },
    ])
    const sensitive = sensitiveMatcher([], w.set)
    expect(sensitive('tok_live_9f8e7d6c5b4a')).toBe(true)
    expect(sensitive(Buffer.from('tok_live_9f8e7d6c5b4a').toString('base64'))).toBe(true)
    expect(JSON.stringify(w.audit)).not.toContain('tok_live')
  })

  it('builds Basic credentials from the item’s username and password, and redacts the result', async () => {
    const w = world()
    const { value } = await w.gate.headerFor('dav', 'caldav.icloud.com')
    const basic = Buffer.from('nick@icloud.example:qrst-uvwx-yzab-cdef').toString('base64')
    expect(reveal(value)).toBe(`Basic ${basic}`)
    const out = redactOutput({ echoed: basic, also: `Basic ${basic}` }, sensitiveMatcher([], w.set))
    expect(out).toEqual({ echoed: REDACTED, also: REDACTED })
  })

  it('matches the host without regard to case, and never another host', async () => {
    const w = world()
    await expect(w.gate.headerFor('api', 'API.Example.com')).resolves.toBeTruthy()
    for (const host of ['evil.example.com', 'api.example.com.evil.test', 'example.com', '']) {
      await expect(world().gate.headerFor('api', host)).rejects.toMatchObject({
        stage: 'credential',
        errorClass: 'origin-mismatch',
      })
    }
  })

  it('refuses a host the declaration names but the grant left out', async () => {
    const w = world({}, { api: grantFor('api', { targets: ['api.example.com'] }) })
    await expect(w.gate.headerFor('api', 'b.example.com')).rejects.toMatchObject({
      errorClass: 'origin-mismatch',
    })
    expect(w.resolved).toEqual([])
    expect(w.audit).toEqual([])
  })

  it('refuses a credential that is not a header credential', async () => {
    await expect(world().gate.headerFor('mail', 'imap.mail.me.com')).rejects.toMatchObject({
      errorClass: 'invalid',
    })
    await expect(world().gate.headerFor('ha', '192.168.1.20')).rejects.toMatchObject({
      errorClass: 'invalid',
    })
  })

  it('refuses a value that would break the header', async () => {
    const w = world({
      resolve: async () => SecretValue.fromString('tok\r\nX-Injected: 1'),
    })
    await expect(w.gate.headerFor('api', 'api.example.com')).rejects.toMatchObject({ errorClass: 'invalid' })
    expect(w.audit).toEqual([])
  })

  it('refuses a Basic username with a colon', async () => {
    const w = world({
      resolve: async (_g, field) => SecretValue.fromString(field === 'username' ? 'a:b' : 'pw'),
    })
    await expect(w.gate.headerFor('dav', 'caldav.icloud.com')).rejects.toMatchObject({
      errorClass: 'invalid',
    })
  })
})

describe('signIn', () => {
  it('gives the protocol client the username and password for the declared endpoint', async () => {
    const w = world()
    const { username, secret } = await w.gate.signIn('mail', 'imap', 'imap.mail.me.com:993')
    expect(username && reveal(username)).toBe('nick@icloud.example')
    expect(reveal(secret)).toBe('abcd-efgh-ijkl-mnop')
    expect(w.audit).toMatchObject([
      { secret: 'mail', field: 'password', origin: 'imap.mail.me.com:993', custody: 'kept' },
    ])
    expect(sensitiveMatcher([], w.set)('abcd-efgh-ijkl-mnop')).toBe(true)
  })

  it('signs in with an SSH key and no username when the item has none', async () => {
    const w = world()
    const { username, secret } = await w.gate.signIn('nas', 'sftp', 'nas.example.com:22')
    expect(username).toBeNull()
    expect(reveal(secret)).toContain('OPENSSH PRIVATE KEY')
    // A line of the key, quoted on its own, is redacted.
    expect(sensitiveMatcher([], w.set)('AAAAB3NzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ')).toBe(true)
  })

  it('refuses another endpoint, another port, or another protocol', async () => {
    for (const [protocol, endpoint] of [
      ['imap', 'imap.mail.me.com:143'],
      ['imap', 'imap.evil.test:993'],
      ['smtp', 'imap.mail.me.com:993'],
    ] as const) {
      const w = world()
      await expect(w.gate.signIn('mail', protocol, endpoint)).rejects.toMatchObject({
        errorClass: 'origin-mismatch',
      })
      expect(w.resolved).toEqual([])
    }
  })
})

describe('entrusted', () => {
  it('hands a raw adapter its entrusted value with the endpoints it may use', async () => {
    const w = world()
    const { secret, endpoints, username } = await w.gate.entrusted('ha')
    expect(reveal(secret)).toBe('eyJhbGciOiJIUzI1NiJ9.ha-token-value')
    expect(endpoints).toEqual(['192.168.1.20:8123', '192.168.1.21:8123'])
    expect(username).toBeNull()
    expect(w.audit).toMatchObject([{ custody: 'entrusted', origin: '192.168.1.20:8123 192.168.1.21:8123' }])
  })

  it('narrows the endpoints to the grant’s', async () => {
    const w = world({}, { ha: grantFor('ha', { targets: ['192.168.1.21:8123'] }) })
    expect((await w.gate.entrusted('ha')).endpoints).toEqual(['192.168.1.21:8123'])
  })

  it('never entrusts a kept credential', async () => {
    for (const name of ['mail', 'api', 'nas']) {
      await expect(world().gate.entrusted(name)).rejects.toMatchObject({ errorClass: 'invalid' })
    }
  })
})

describe('grant confusion', () => {
  const cases: [string, Partial<CredentialGrant>][] = [
    ['another adapter', { adapterId: 'other-adapter' }],
    ['another version', { adapterHash: OTHER_HASH }],
    ['another credential', { credential: 'api' }],
    ['another kind', { kind: 'token' }],
    ['kept turned entrusted', { custody: 'entrusted' }],
    ['a target the declaration doesn’t name', { targets: ['imap.mail.me.com:993', 'imap.evil.test:993'] }],
    ['no targets', { targets: [] }],
  ]

  it.each(cases)('refuses a grant for %s, before anything is resolved', async (_, overrides) => {
    const w = world({}, { mail: grantFor('mail', overrides) })
    await expect(w.gate.signIn('mail', 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
      stage: 'credential',
      errorClass: 'not-granted',
    })
    expect(w.resolved).toEqual([])
    expect(w.audit).toEqual([])
  })

  it('refuses an undeclared credential, and one named like an Object.prototype member', async () => {
    for (const name of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await expect(world().gate.signIn(name, 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
        errorClass: 'not-granted',
      })
    }
  })

  it('refuses when there is no grant, or the grant store fails', async () => {
    await expect(world({}, {}).gate.headerFor('api', 'api.example.com')).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
    const failing = world({
      findGrant: async () => {
        throw new Error('disk')
      },
    })
    await expect(failing.gate.headerFor('api', 'api.example.com')).rejects.toMatchObject({
      errorClass: 'unavailable',
    })
  })

  it('refuses everything for a manifest with no credentials', async () => {
    await expect(
      world({ credentials: undefined }).gate.headerFor('api', 'api.example.com'),
    ).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
  })
})

describe('order of hand-over', () => {
  it('hands nothing over, and disposes what it resolved, when the audit can’t be written', async () => {
    const seen: SecretValue[] = []
    const w = world({
      audit: {
        append: async () => {
          throw new Error('disk full')
        },
      },
      resolve: async (grant, field) => {
        const v = SecretValue.fromString(ITEMS[grant.itemRef]?.[field] ?? 'x')
        seen.push(v)
        return v
      },
    })
    await expect(w.gate.signIn('mail', 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
      errorClass: 'internal',
    })
    await expect(w.gate.headerFor('api', 'api.example.com')).rejects.toMatchObject({ errorClass: 'internal' })
    await expect(w.gate.entrusted('ha')).rejects.toMatchObject({ errorClass: 'internal' })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((v) => v.disposed)).toBe(true)
    // Registered for redaction first, so even a value that was never handed over is redacted.
    expect(sensitiveMatcher([], w.set)('tok_live_9f8e7d6c5b4a')).toBe(true)
  })

  it('hands nothing over when it can’t keep a copy for redaction, and audits nothing', async () => {
    const w = world({
      remember: () => {
        throw new Error('no')
      },
    })
    await expect(w.gate.signIn('mail', 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
      errorClass: 'internal',
    })
    expect(w.audit).toEqual([])
  })

  it('refuses a provider that answers with something other than a live SecretValue', async () => {
    const disposed = SecretValue.fromString('x')
    disposed.dispose()
    for (const bad of ['plain string', disposed, null]) {
      const w = world({ resolve: async () => bad as unknown as SecretValue })
      await expect(w.gate.signIn('mail', 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
        errorClass: 'internal',
      })
      expect(w.audit).toEqual([])
    }
  })

  it('passes a missing username through as none, and any other failure as it is', async () => {
    const w = world({
      resolve: async (_g, field) => {
        if (field === 'username') throw new ValetError('credential', 'locked')
        return SecretValue.fromString('pw-value-123')
      },
    })
    await expect(w.gate.signIn('mail', 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
      errorClass: 'locked',
    })
    expect(w.audit).toEqual([])
  })
})
