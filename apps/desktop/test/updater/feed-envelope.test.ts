// @vitest-environment node
// verifyFeed: the signed envelope over a channel file. One test per way of getting it wrong. The
// envelopes are written by scripts/make-feed.mjs, so this also proves the app accepts what the
// release script signs.

import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildEnvelope,
  MAX_VALID_DAYS,
  ENVELOPE_KEYS as SCRIPT_ENVELOPE_KEYS,
  signEnvelope,
} from '../../scripts/make-feed.mjs'
import {
  canonicalEnvelope,
  ENVELOPE_KEYS,
  type FeedEnvelope,
  loadFeedPublicKey,
  MAX_ENVELOPE_VALIDITY_MS,
  type VerifyFeedOptions,
  verifyFeed,
} from '../../src/main/updater'
import { TEST_FEED_KEYS } from './fakes'

const YML = "version: '1.3.0'\nfiles:\n  - url: 'valet-1.3.0-arm64.zip'\n"
const ISSUED = '2026-11-07T10:00:00.000Z'
const EXPIRES = '2026-12-07T10:00:00.000Z'
const NOW = Date.parse('2026-11-10T00:00:00.000Z')

const readYmlVersion = (yml: string) => /^version: '([^']+)'$/m.exec(yml)?.[1]

function options(patch: Partial<VerifyFeedOptions> = {}): VerifyFeedOptions {
  return { publicKey: TEST_FEED_KEYS.publicKey, channel: 'latest', now: NOW, readYmlVersion, ...patch }
}

function envelopeFor(patch: Partial<Parameters<typeof buildEnvelope>[0]> = {}): string {
  return buildEnvelope({
    channel: 'latest',
    version: '1.3.0',
    yml: YML,
    minimumVersion: '1.2.4',
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    ...patch,
  })
}

function signed(envelope = envelopeFor(), key = TEST_FEED_KEYS.privateKey) {
  return { yml: YML, envelope, signature: signEnvelope(envelope, key) }
}

/** Signs arbitrary text as the feed key would: for envelopes make-feed refuses to write. */
function signRaw(text: string) {
  return {
    yml: YML,
    envelope: text,
    signature: sign(null, Buffer.from(text), TEST_FEED_KEYS.privateKey).toString('base64'),
  }
}

describe('verifyFeed: accepting', () => {
  it('accepts a channel file covered by an envelope the feed key signed', () => {
    const verdict = verifyFeed(signed(), options())
    expect(verdict).toMatchObject({ ok: true, envelope: { version: '1.3.0', minimumVersion: '1.2.4' } })
  })

  it('agrees with make-feed on the key order and the canonical form', () => {
    expect(SCRIPT_ENVELOPE_KEYS).toEqual([...ENVELOPE_KEYS])
    const text = envelopeFor()
    expect(canonicalEnvelope(JSON.parse(text) as FeedEnvelope)).toBe(text)
    expect(JSON.parse(text).ymlSha256).toBe(createHash('sha256').update(YML).digest('hex'))
    expect(MAX_VALID_DAYS * 24 * 60 * 60 * 1000).toBe(MAX_ENVELOPE_VALIDITY_MS)
  })

  it('reads the channel file’s version only after its bytes match', () => {
    const seen: string[] = []
    const tampered = { ...signed(), yml: YML.replace('1.3.0', '9.9.9') }
    verifyFeed(tampered, options({ readYmlVersion: (yml) => seen.push(yml) }))
    expect(seen).toEqual([])
  })

  it('tolerates one trailing newline on the signature, and nothing else', () => {
    const feed = signed()
    expect(feed.signature.endsWith('\n')).toBe(true)
    expect(verifyFeed({ ...feed, signature: feed.signature.trimEnd() }, options()).ok).toBe(true)
    expect(verifyFeed({ ...feed, signature: `${feed.signature}\n` }, options())).toEqual({
      ok: false,
      reason: 'signature-invalid',
    })
    expect(verifyFeed({ ...feed, signature: ` ${feed.signature}` }, options()).ok).toBe(false)
  })
})

describe('verifyFeed: the signature', () => {
  it('refuses a signature by another key', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    expect(verifyFeed(signed(envelopeFor(), other), options())).toEqual({
      ok: false,
      reason: 'signature-invalid',
    })
  })

  it('refuses a valid signature over different bytes', () => {
    const feed = signed()
    const envelope = feed.envelope.replace('"1.2.4"', '"1.2.5"')
    expect(verifyFeed({ ...feed, envelope }, options())).toEqual({ ok: false, reason: 'signature-invalid' })
  })

  it('refuses a missing, empty, too long, short or non-base64 signature', () => {
    const feed = signed()
    const valid = feed.signature.trimEnd()
    for (const signature of [
      null,
      '',
      '\n',
      `${valid}${valid}`,
      'A'.repeat(4096),
      valid.slice(0, 40),
      `${valid.slice(0, 85)}!==`,
      `${valid.slice(0, 86)}=`,
      Buffer.alloc(63).toString('base64'),
      Buffer.alloc(65).toString('base64'),
    ]) {
      expect(verifyFeed({ ...feed, signature }, options()), String(signature)).toEqual({
        ok: false,
        reason: 'signature-invalid',
      })
    }
  })

  it('refuses a missing or oversized envelope before checking anything else', () => {
    expect(verifyFeed({ ...signed(), envelope: null }, options())).toEqual({
      ok: false,
      reason: 'envelope-invalid',
    })
    expect(verifyFeed(signRaw(`${envelopeFor()}${' '.repeat(2000)}`), options())).toEqual({
      ok: false,
      reason: 'envelope-invalid',
    })
  })
})

describe('verifyFeed: the envelope', () => {
  const fields = JSON.parse(envelopeFor()) as Record<string, string> & { ymlSha256: string }

  it('refuses extra, missing, reordered or duplicate keys, even when signed', () => {
    const variants = [
      JSON.stringify({ ...fields, extra: 'x' }),
      JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'minimumVersion'))),
      JSON.stringify(Object.fromEntries(Object.entries(fields).reverse())),
      envelopeFor().replace('"channel":"latest",', '"channel":"beta","channel":"latest",'),
      JSON.stringify(fields, null, 2),
      ` ${envelopeFor()}`,
      envelopeFor().replace('"latest"', '"\\u006catest"'),
      '[]',
      'null',
      '{',
    ]
    for (const text of variants) {
      expect(verifyFeed(signRaw(text), options()), text).toEqual({ ok: false, reason: 'envelope-invalid' })
    }
  })

  it('refuses a malformed field, even when signed', () => {
    const variants: Record<string, string>[] = [
      { ...fields, channel: 'alpha' },
      { ...fields, version: 'v1.3.0' },
      { ...fields, version: '1.3.0+build' },
      { ...fields, minimumVersion: '1.4.0' },
      { ...fields, minimumVersion: '' },
      { ...fields, ymlSha256: fields.ymlSha256.toUpperCase() },
      { ...fields, ymlSha256: 'ab' },
      { ...fields, issuedAt: '2026-11-07' },
      { ...fields, expiresAt: '2026-13-40T99:00:00Z' },
    ]
    for (const variant of variants) {
      const text = canonicalEnvelope(variant as unknown as FeedEnvelope)
      expect(verifyFeed(signRaw(text), options()), text).toEqual({ ok: false, reason: 'envelope-invalid' })
    }
  })

  it('refuses non-ASCII text, even when signed', () => {
    const text = envelopeFor().replace('"latest"', '"lätest"')
    expect(verifyFeed(signRaw(text), options())).toEqual({ ok: false, reason: 'envelope-invalid' })
  })

  it('refuses an envelope for the other channel', () => {
    const beta = signed(envelopeFor({ channel: 'beta' }))
    expect(verifyFeed(beta, options())).toEqual({ ok: false, reason: 'channel-mismatch' })
    expect(verifyFeed(beta, options({ channel: 'beta' })).ok).toBe(true)
  })
})

describe('verifyFeed: time', () => {
  it('refuses an expired envelope, from the moment it expires', () => {
    expect(verifyFeed(signed(), options({ now: Date.parse(EXPIRES) }))).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(verifyFeed(signed(), options({ now: Date.parse(EXPIRES) - 1 })).ok).toBe(true)
  })

  it('refuses an envelope issued more than a day ahead of this clock', () => {
    const now = Date.parse(ISSUED) - 25 * 60 * 60 * 1000
    expect(verifyFeed(signed(), options({ now }))).toEqual({ ok: false, reason: 'expired' })
    expect(verifyFeed(signed(), options({ now: Date.parse(ISSUED) - 60 * 60 * 1000 })).ok).toBe(true)
  })

  it('refuses a validity window that is empty, backwards or longer than allowed, even when signed', () => {
    const fields = JSON.parse(envelopeFor()) as Record<string, string>
    for (const expiresAt of [ISSUED, '2026-11-06T10:00:00.000Z', '2027-03-07T10:00:00.000Z']) {
      const text = canonicalEnvelope({ ...fields, expiresAt } as unknown as FeedEnvelope)
      expect(verifyFeed(signRaw(text), options()), expiresAt).toEqual({ ok: false, reason: 'expired' })
    }
  })

  it('refuses when this clock is nonsense', () => {
    expect(verifyFeed(signed(), options({ now: Number.NaN })).ok).toBe(false)
  })
})

describe('verifyFeed: the channel file', () => {
  it('refuses a channel file whose hash differs by one byte', () => {
    const feed = signed()
    expect(verifyFeed({ ...feed, yml: `${YML} ` }, options())).toEqual({ ok: false, reason: 'yml-mismatch' })
    expect(verifyFeed({ ...feed, yml: YML.replace('arm64', 'arm65') }, options())).toEqual({
      ok: false,
      reason: 'yml-mismatch',
    })
  })

  it('refuses a channel file rewritten to a higher version (the downgrade attack)', () => {
    const feed = signed()
    expect(verifyFeed({ ...feed, yml: YML.replace('1.3.0', '99.0.0') }, options())).toEqual({
      ok: false,
      reason: 'yml-mismatch',
    })
  })

  it('refuses a channel file whose version differs from the envelope’s, with matching bytes', () => {
    const yml = YML.replace("version: '1.3.0'", "version: '1.3.1'")
    const envelope = envelopeFor({ yml })
    const feed = { yml, envelope, signature: signEnvelope(envelope, TEST_FEED_KEYS.privateKey) }
    expect(verifyFeed(feed, options())).toEqual({ ok: false, reason: 'yml-mismatch' })
  })

  it('refuses a missing channel file, or one whose version can’t be read', () => {
    expect(verifyFeed({ ...signed(), yml: null }, options())).toEqual({ ok: false, reason: 'yml-mismatch' })
    const throwing = options({
      readYmlVersion: () => {
        throw new Error('bad yaml')
      },
    })
    expect(verifyFeed(signed(), throwing)).toEqual({ ok: false, reason: 'yml-mismatch' })
  })

  it('never puts feed text into the verdict', () => {
    const verdict = verifyFeed({ ...signed(), yml: 'secret-token-in-yml' }, options())
    expect(JSON.stringify(verdict)).not.toContain('secret')
  })
})

describe('loadFeedPublicKey', () => {
  it('loads an Ed25519 SPKI PEM and nothing else', () => {
    expect(loadFeedPublicKey(TEST_FEED_KEYS.publicPem).asymmetricKeyType).toBe('ed25519')
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      type: 'spki',
      format: 'pem',
    })
    const privatePem = TEST_FEED_KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' })
    for (const pem of [String(ec), String(privatePem), '', `x${TEST_FEED_KEYS.publicPem}`]) {
      expect(() => loadFeedPublicKey(pem)).toThrow()
    }
  })
})

describe('make-feed’s envelope', () => {
  it('refuses what the app would refuse', () => {
    expect(() => envelopeFor({ channel: 'alpha' as 'beta' })).toThrow()
    expect(() => envelopeFor({ minimumVersion: '1.4.0' })).toThrow()
    expect(() => envelopeFor({ minimumVersion: 'v1.0.0' })).toThrow()
    expect(() => envelopeFor({ expiresAt: ISSUED })).toThrow()
    expect(() => envelopeFor({ expiresAt: '2027-03-07T10:00:00.000Z' })).toThrow()
    expect(() => envelopeFor({ yml: 'versión' })).toThrow()
    expect(() =>
      signEnvelope(envelopeFor(), generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey),
    ).toThrow()
  })
})
