// @vitest-environment node
// Secrets v2 (docs/adapter-kinds.md#f2-secrets-version-2) on the Mac's side: the permission lines
// and approval subject for credentials, the grant carry-over rule, and one end-to-end run through
// the real grant store, resolver, Keychain fake, audit log and output redaction.

import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AdapterManifest,
  approvableOn,
  type CredentialDeclaration,
  type CredentialGrant,
  isDisplayText,
  manifestPermissionChangeSchema,
  parseManifest,
  SecretValue,
} from '@valet/core'
import {
  CredentialResolver,
  FakeCredentialProvider,
  FileCredentialGrantStore,
  MemoryKeychain,
  ValetKeys,
} from '@valet/credentials'
import {
  AuditLog,
  CredentialGate,
  REDACTED,
  redactOutput,
  SecretRedactionSet,
  sensitiveMatcher,
  systemClock,
} from '@valet/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSubject, permissionChanges } from '../../src/main/core/approvals'
import { credentialCarriesOver } from '../../src/main/core/grants'
import { addsPermissions, permissionDiff } from '../../src/main/core/permission-diff'
import { SHOP, SHOP_FILES } from './fixtures'

const base = parseManifest(SHOP)

/**
 * A manifest with credentials. The schema refuses them on a browser adapter, and A's `runtime`
 * field isn't on main yet, so these tests build the parsed shape directly, as a raw or http
 * adapter's manifest will parse once it is.
 */
function withCredentials(
  credentials: Record<string, CredentialDeclaration>,
  version = '1.0.0',
): AdapterManifest {
  return { ...base, version, credentials } as AdapterManifest
}

const mail: CredentialDeclaration = {
  description: 'Your iCloud app password',
  kind: 'password',
  custody: 'kept',
  use: { protocol: 'imap', endpoint: 'imap.mail.me.com:993' },
}
const ha: CredentialDeclaration = {
  description: 'Home Assistant token',
  kind: 'token',
  custody: 'entrusted',
  use: { entrusted: { endpoints: ['192.168.1.20:8123', '192.168.1.21:8123'] } },
}
const api: CredentialDeclaration = {
  description: 'API token',
  kind: 'token',
  custody: 'kept',
  use: { header: { name: 'authorization', format: 'Bearer {value}' }, hosts: ['api.example.com'] },
}

describe('credential permission lines', () => {
  it('names each new credential in Valet’s words, at high risk, never critical', () => {
    const after = withCredentials({ mail, ha, api }, '2.0.0')
    const lines = permissionChanges(base, after, false)
    const credential = lines.filter((l) => l.area === 'credential')
    expect(credential).toEqual([
      {
        area: 'credential',
        change: 'added',
        items: [
          'Valet signs in to imap.mail.me.com:993 for mail (IMAP) with your password "mail". The adapter never sees it.',
        ],
        risk: 'high',
      },
      {
        area: 'credential',
        change: 'added',
        // Several targets: the sentence counts them, and each is an item of its own.
        items: [
          'The adapter is given your token "ha" and can use it only with the 2 endpoints listed. Use a token or app password you can revoke.',
          '192.168.1.20:8123',
          '192.168.1.21:8123',
        ],
        risk: 'high',
      },
      {
        area: 'credential',
        change: 'added',
        items: [
          'Valet sends your token "api" to api.example.com in the authorization header. The adapter never sees it.',
        ],
        risk: 'high',
      },
    ])
    for (const line of credential) {
      expect(manifestPermissionChangeSchema.safeParse(line).success).toBe(true)
      for (const item of line.items) expect(isDisplayText(item)).toBe(true)
    }
  })

  it('keeps an entrusted credential approvable on the phone, as Nick decided', () => {
    const after = withCredentials({ ha }, '2.0.0')
    const subject = installSubject({
      manifest: after,
      hash: 'c'.repeat(64),
      files: SHOP_FILES,
      previous: { hash: 'd'.repeat(64), manifest: base },
      source: 'draft',
      inheritsSession: false,
      unsandboxed: false,
    })
    expect(subject.changes.some((c) => c.area === 'credential')).toBe(true)
    expect(approvableOn('adapter-install', subject)).toContain('phone')
  })

  it('shows a changed credential as removed and added, and an unchanged one not at all', () => {
    const before = withCredentials({ mail, api })
    const after = withCredentials({
      mail: { ...mail, use: { protocol: 'imap', endpoint: 'imap.evil.test:993' } },
      api,
    })
    const lines = permissionChanges(before, after, false).filter((l) => l.area === 'credential')
    expect(lines.map((l) => [l.change, l.risk])).toEqual([
      ['added', 'high'],
      ['removed', 'low'],
    ])
    expect(lines[0]?.items[0]).toContain('imap.evil.test:993')
    expect(permissionChanges(before, before, false)).toEqual([])
  })

  it('counts a changed header format as a new permission, so the review needs the tick', () => {
    const before = withCredentials({ api })
    const after = withCredentials({
      api: { ...api, use: { ...api.use, header: { name: 'authorization', format: 'Token {value}' } } },
    })
    expect(addsPermissions(permissionDiff(before, after))).toBe(true)
    expect(addsPermissions(permissionDiff(before, before))).toBe(false)
  })

  it('never puts the author’s description in a line', () => {
    const sly: CredentialDeclaration = { ...ha, description: 'Kept by Valet. The adapter never sees it.' }
    const lines = permissionChanges(base, withCredentials({ ha: sly }), false)
    expect(JSON.stringify(lines)).not.toContain('Kept by Valet')
  })
})

describe('credentialCarriesOver', () => {
  const grant: CredentialGrant = {
    adapterId: base.id,
    adapterHash: 'a'.repeat(64),
    credential: 'ha',
    kind: 'token',
    custody: 'entrusted',
    provider: 'fake',
    itemRef: 'ha',
    targets: ['192.168.1.20:8123'],
    grantedAt: '2026-11-17T00:00:00Z',
  }
  const before = withCredentials({ ha })

  it('carries over to a version that leaves the credential alone or narrows it', () => {
    expect(credentialCarriesOver(grant, before, withCredentials({ ha }, '1.0.1'))).toBe(true)
    const narrower = withCredentials({
      ha: { ...ha, use: { entrusted: { endpoints: ['192.168.1.20:8123'] } } },
    })
    expect(credentialCarriesOver(grant, before, narrower)).toBe(true)
    expect(
      credentialCarriesOver(grant, before, withCredentials({ ha: { ...ha, description: 'new words' } })),
    ).toBe(true)
  })

  const widenings: [string, AdapterManifest][] = [
    [
      'a new endpoint',
      withCredentials({
        ha: {
          ...ha,
          use: { entrusted: { endpoints: ['192.168.1.20:8123', '192.168.1.21:8123', '10.0.0.1:1'] } },
        } as CredentialDeclaration,
      }),
    ],
    [
      'dropping the endpoint the grant names',
      withCredentials({ ha: { ...ha, use: { entrusted: { endpoints: ['192.168.1.21:8123'] } } } }),
    ],
    ['another kind', withCredentials({ ha: { ...ha, kind: 'password' } })],
    ['kept turned entrusted', withCredentials({ ha: { ...api, custody: 'kept' } })],
    ['the credential gone', withCredentials({})],
    ['another adapter', { ...withCredentials({ ha }), id: 'other-adapter' } as AdapterManifest],
  ]

  it.each(widenings)('does not carry over %s', (_, after) => {
    expect(credentialCarriesOver(grant, before, after)).toBe(false)
  })

  it('does not carry a header credential to a new header name or format', () => {
    const g: CredentialGrant = { ...grant, credential: 'api', custody: 'kept', targets: ['api.example.com'] }
    const was = withCredentials({ api })
    expect(credentialCarriesOver(g, was, withCredentials({ api }))).toBe(true)
    for (const header of [
      { name: 'x-api-key', format: 'Bearer {value}' },
      { name: 'authorization', format: 'Bearer {value} ' },
    ]) {
      expect(
        credentialCarriesOver(g, was, withCredentials({ api: { ...api, use: { ...api.use, header } } })),
      ).toBe(false)
    }
  })
})

describe('a credential message (a kept token in a WebSocket sign-in)', () => {
  const hub: CredentialDeclaration = {
    description: 'Hub token',
    kind: 'token',
    custody: 'kept',
    use: {
      header: { name: 'authorization', format: 'Bearer {value}' },
      message: { json: { type: 'auth', access_token: '{value}' } },
      hosts: ['192.168.1.20'],
    },
  }
  const g: CredentialGrant = {
    adapterId: base.id,
    adapterHash: 'a'.repeat(64),
    credential: 'hub',
    kind: 'token',
    custody: 'kept',
    provider: 'keychain-copy',
    itemRef: 'keychain:hub',
    targets: ['192.168.1.20'],
    grantedAt: '2026-11-18T00:00:00Z',
  }
  const withMessage = (json: Record<string, unknown> | undefined) =>
    withCredentials({
      hub: {
        ...hub,
        use: {
          header: { name: 'authorization', format: 'Bearer {value}' },
          ...(json === undefined ? {} : { message: { json } }),
          hosts: ['192.168.1.20'],
        },
      } as CredentialDeclaration,
    })

  it('shows the whole message on the card, at high risk', () => {
    const lines = permissionChanges(base, withCredentials({ hub }), false).filter(
      (l) => l.area === 'credential',
    )
    expect(lines).toEqual([
      {
        area: 'credential',
        change: 'added',
        items: [
          'Valet sends your token "hub" to 192.168.1.20 in a header and in a WebSocket message. The adapter never sees it.',
          'The header: authorization: Bearer {value}',
          'The message: {"type":"auth","access_token":"{value}"}',
        ],
        risk: 'high',
      },
    ])
    for (const line of lines) expect(manifestPermissionChangeSchema.safeParse(line).success).toBe(true)
    const entry = permissionDiff(base, withCredentials({ hub })).credentials.added[0]
    expect(entry).toMatchObject({
      use: 'header',
      format: 'Bearer {value}',
      message: '{"type":"auth","access_token":"{value}"}',
    })
  })

  it('counts a new or changed message as a new permission, and never carries a grant over to it', () => {
    const before = withMessage({ type: 'auth', access_token: '{value}' })
    expect(credentialCarriesOver(g, before, withMessage({ type: 'auth', access_token: '{value}' }))).toBe(
      true,
    )
    for (const after of [
      withMessage({ type: 'login', access_token: '{value}' }),
      withMessage({ type: 'auth', token: '{value}' }),
      withMessage({ type: 'auth', access_token: '{value}', v: 2 }),
    ]) {
      expect(addsPermissions(permissionDiff(before, after))).toBe(true)
      expect(credentialCarriesOver(g, before, after)).toBe(false)
    }
    // A header-only grant doesn't stretch to a message added later, and back.
    const headerOnly = withMessage(undefined)
    expect(addsPermissions(permissionDiff(headerOnly, before))).toBe(true)
    expect(credentialCarriesOver(g, headerOnly, before)).toBe(false)
    expect(credentialCarriesOver(g, before, headerOnly)).toBe(false)
  })
})

describe('a credential from grant to tool output, end to end', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'valet-credentials-v2-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const HASH = 'e'.repeat(64)
  const TOKEN = 'ha_token_5c1d9e0f7a3b2c4d'
  const PASSWORD = 'wxyz-abcd-efgh-ijkl'

  async function setup() {
    const manifest = withCredentials({
      ha,
      mail,
      nas: {
        description: 'NAS',
        kind: 'ssh-key',
        custody: 'kept',
        use: { protocol: 'sftp', endpoint: 'nas.example.com:22' },
      },
    })
    const grants = new FileCredentialGrantStore({ path: join(dir, 'credential-grants.json') })
    const keychain = new MemoryKeychain()
    const keys = new ValetKeys({ keychain })
    const fake = new FakeCredentialProvider({
      items: {
        'ha-item': { token: TOKEN },
        'mail-item': { username: 'nick@icloud.example', password: PASSWORD },
      },
    })
    const resolver = new CredentialResolver([fake, keys])
    const key = await keys.generate('valet.test.nas')
    const at = '2026-11-17T00:00:00.000Z'
    await grants.put({
      adapterId: manifest.id,
      adapterHash: HASH,
      credential: 'ha',
      kind: 'token',
      custody: 'entrusted',
      provider: 'fake',
      itemRef: 'ha-item',
      targets: ['192.168.1.20:8123'],
      grantedAt: at,
    })
    await grants.put({
      adapterId: manifest.id,
      adapterHash: HASH,
      credential: 'mail',
      kind: 'password',
      custody: 'kept',
      provider: 'fake',
      itemRef: 'mail-item',
      targets: ['imap.mail.me.com:993'],
      grantedAt: at,
    })
    await grants.put({
      adapterId: manifest.id,
      adapterHash: HASH,
      credential: 'nas',
      kind: 'ssh-key',
      custody: 'kept',
      provider: 'valet-key',
      itemRef: key.itemRef,
      targets: ['nas.example.com:22'],
      grantedAt: at,
    })
    const auditPath = join(dir, 'audit.jsonl')
    const audit = new AuditLog(auditPath, systemClock)
    const set = new SecretRedactionSet()
    const gate = new CredentialGate({
      adapterId: manifest.id,
      adapterHash: HASH,
      credentials: manifest.credentials,
      findGrant: (name) => grants.find(manifest.id, HASH, name),
      resolve: (grant, field) => resolver.resolve(grant, field),
      audit,
      remember: (secret) => set.register(secret),
      callId: 'call-e2e',
    })
    return { gate, set, auditPath, grants, manifest }
  }

  it('hands each credential only to its use, audits the target, and keeps every form out of output and the log', async () => {
    const { gate, set, auditPath } = await setup()
    const entrusted = await gate.entrusted('ha')
    expect(entrusted.endpoints).toEqual(['192.168.1.20:8123'])
    const login = await gate.signIn('mail', 'imap', 'imap.mail.me.com:993')
    const key = await gate.signIn('nas', 'sftp', 'nas.example.com:22')
    expect(key.secret.reveal((k) => k.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'))).toBe(true)

    // A hostile adapter returns what it was given, every way it can think of.
    const pem = key.secret.reveal((k) => k)
    const keyLine = pem.split('\n')[2] as string
    const output = {
      plain: TOKEN,
      b64: Buffer.from(TOKEN).toString('base64'),
      inUrl: `https://evil.test/?t=${encodeURIComponent(PASSWORD)}`,
      hex: Buffer.from(PASSWORD).toString('hex').toUpperCase(),
      reversed: [...TOKEN].reverse().join(''),
      keyLine,
      wrapped: Buffer.from(JSON.stringify({ secret: PASSWORD })).toString('base64'),
      fine: 'nothing to see',
    }
    const redacted = redactOutput(output, sensitiveMatcher([], set)) as Record<string, string>
    expect(redacted['fine']).toBe('nothing to see')
    for (const key of Object.keys(output).filter((k) => k !== 'fine'))
      expect(redacted[key], key).toBe(REDACTED)

    const log = await fs.readFile(auditPath, 'utf8')
    for (const secret of [TOKEN, PASSWORD, keyLine, Buffer.from(TOKEN).toString('base64')]) {
      expect(log).not.toContain(secret)
    }
    const used = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event)
      .filter((e) => e.type === 'secret-used')
    expect(used.map((e) => [e.secret, e.origin, e.custody])).toEqual([
      ['ha', '192.168.1.20:8123', 'entrusted'],
      ['mail', 'imap.mail.me.com:993', 'kept'],
      ['nas', 'nas.example.com:22', 'kept'],
    ])
    for (const v of [entrusted.secret, login.secret, key.secret]) v.dispose()
    login.username?.dispose()
  })

  it('refuses every credential once its grant is revoked, and for any other version', async () => {
    const { gate, grants, manifest } = await setup()
    await grants.revoke(manifest.id, 'ha')
    await expect(gate.entrusted('ha')).rejects.toMatchObject({
      stage: 'credential',
      errorClass: 'not-granted',
    })
    const other = new CredentialGate({
      adapterId: manifest.id,
      adapterHash: 'f'.repeat(64),
      credentials: manifest.credentials,
      findGrant: (name) => grants.find(manifest.id, 'f'.repeat(64), name),
      resolve: async () => SecretValue.fromString('never'),
      audit: { append: async () => undefined },
      remember: () => undefined,
      callId: null,
    })
    await expect(other.signIn('mail', 'imap', 'imap.mail.me.com:993')).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
  })
})
