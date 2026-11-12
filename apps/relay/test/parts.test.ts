// The small parts: pages, pushes, signatures, encodings, counters, and the logging rule.

import { generateKeyPairSync, verify } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  recoveryCodeHash as coreRecoveryCodeHash,
  keyId,
  pushPayloadSchema,
  relayAuthPayload,
  SIGNING_DOMAINS,
  verifyRelayBinding,
} from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { fromBase64url, randomToken, toBase64url } from '../src/encoding'
import { logFailure } from '../src/log'
import { escapeHtml, problemPage, redirectResponse, waitingPage } from '../src/pages'
import { ApnsPushSender, NO_PUSH, pushPayload } from '../src/push'
import { keyIdOf, verifyBinding, verifyRelayAuth } from '../src/verify'
import { WindowCounter } from '../src/window'
import { testKey } from './keys'

describe('pages', () => {
  it('serve fixed text with a locked-down policy and escape what they show', async () => {
    const page = waitingPage('ABCD-EFGH', 'tok.en')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    const text = await page.text()
    expect(text).toContain('ABCD-EFGH')
    expect(text).toContain('/authorize?wait=tok.en')
    expect(text).not.toContain('<script')
    expect(waitingPage('ABCD-EFGH', 'bad id"').status).toBe(502)
    expect(await problemPage('ended', 404).text()).toContain('has ended')
    expect(redirectResponse('https://c.test/').headers.get('location')).toBe('https://c.test/')
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;')
  })
})

describe('push', () => {
  it('sends only the contract’s fixed payloads', () => {
    for (const kind of ['needs-you', 'alert'] as const)
      expect(pushPayloadSchema.safeParse(JSON.parse(pushPayload(kind))).success).toBe(true)
  })

  it('signs an ES256 provider token, reuses it, and reports gone tokens', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const seen: { url: string; init: RequestInit }[] = []
    const statuses = [200, 410, 403, 500]
    let clock = 1_000_000
    const sender = new ApnsPushSender(
      {
        key: pem,
        keyId: 'KEY123',
        teamId: 'TEAM45',
        topic: 'me.dncr.valet',
        host: 'api.sandbox.push.apple.com',
      },
      (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return new Response(null, { status: statuses.shift() ?? 200 })
      }) as typeof fetch,
      () => clock,
    )
    const token = 'ab'.repeat(32)
    expect(await sender.send(token, 'needs-you')).toBe('sent')
    expect(await sender.send(token, 'alert')).toBe('gone')
    expect(await sender.send(token, 'alert')).toBe('failed')
    clock += 1000
    expect(await sender.send(token, 'alert')).toBe('failed')
    expect(await sender.send('not-hex', 'alert')).toBe('failed')
    expect(seen[0]?.url).toBe(`https://api.sandbox.push.apple.com/3/device/${token}`)
    const headers = seen[0]?.init.headers as Record<string, string>
    expect(headers['apns-topic']).toBe('me.dncr.valet')
    const jwt = headers['authorization']?.replace('bearer ', '') as string
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h as string, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
    })
    expect(JSON.parse(Buffer.from(c as string, 'base64url').toString())).toEqual({ iss: 'TEAM45', iat: 1000 })
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s as string, 'base64url'),
      ),
    ).toBe(true)
    // Reused until Apple refused it (403), then minted again.
    expect((seen[1]?.init.headers as Record<string, string> | undefined)?.['authorization']).toBe(
      headers['authorization'],
    )
    expect((seen[3]?.init.headers as Record<string, string> | undefined)?.['authorization']).not.toBe(
      headers['authorization'],
    )
    expect(seen[0]?.init.body).toBe(pushPayload('needs-you'))

    const failing = new ApnsPushSender(
      { key: pem, keyId: 'K', teamId: 'T', topic: 't', host: 'h' },
      (async () => {
        throw new Error('offline')
      }) as typeof fetch,
    )
    expect(await failing.send(token, 'alert')).toBe('failed')
    expect(await NO_PUSH.send(token, 'alert')).toBe('off')
  })
})

describe('signatures and encodings', () => {
  it('verifies a transport key’s relay-auth signature and nothing else', async () => {
    const key = testKey()
    const payload = relayAuthPayload({
      nonce: 'n'.repeat(43),
      relay: 'https://r.test',
      role: 'mac',
      id: 'a'.repeat(32),
    })
    expect(payload).toBe(
      `{"nonce":"${'n'.repeat(43)}","relay":"https://r.test","role":"mac","id":"${'a'.repeat(32)}"}`,
    )
    const signature = await key.sign(payload)
    expect(await verifyRelayAuth(key.publicKey, payload, signature)).toBe(true)
    expect(await verifyRelayAuth(key.publicKey, `${payload} `, signature)).toBe(false)
    expect(await verifyRelayAuth(testKey().publicKey, payload, signature)).toBe(false)
    const otherDomain = key.signDomain(SIGNING_DOMAINS.approvalDecision, payload)
    expect(await verifyRelayAuth(key.publicKey, payload, otherDomain)).toBe(false)
    expect(await verifyRelayAuth('!', payload, signature)).toBe(false)
    expect(await verifyRelayAuth(key.publicKey, payload, 'AAAA')).toBe(false)
    expect(await verifyRelayAuth('AAAA', payload, signature)).toBe(false)
  })

  it('round-trips base64url and makes random tokens', () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2])
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes)
    expect(fromBase64url('a+b')).toBeNull()
    expect(fromBase64url('a')).toBeNull()
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('counts per key per window, with a bounded number of keys', () => {
    let now = 0
    const counter = new WindowCounter(2, 1000, () => now, 2)
    expect([counter.take('a'), counter.take('a'), counter.take('a')]).toEqual([true, true, false])
    now = 1000
    expect(counter.take('a')).toBe(true)
    counter.take('b')
    counter.take('c')
    counter.forget('c')
    expect(counter.take('c')).toBe(true)
  })
})

describe('logging', () => {
  it('logs a stage and a class, never a message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logFailure('forward', new TypeError('Bearer secret-token'))
    logFailure('forward', 'text')
    expect(spy.mock.calls).toEqual([
      ['relay: forward failed (TypeError)'],
      ['relay: forward failed (string)'],
    ])
    spy.mockRestore()
  })

  it('uses console nowhere but log.ts', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url))
    for (const file of readdirSync(dir)) {
      if (file === 'log.ts') continue
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/\bconsole\./)
    }
  })
})

describe('the binding check', () => {
  it('agrees with core’s node:crypto version on ids, good bindings and forgeries', async () => {
    const approval = testKey()
    const transport = testKey()
    const other = testKey()
    expect(await keyIdOf(approval.publicKey)).toBe(keyId(approval.publicKey))
    expect(await keyIdOf('not base64url!')).toBeNull()
    const cases = [
      { id: approval.id, approvalKey: approval.publicKey, signer: approval, key: transport.publicKey },
      { id: approval.id, approvalKey: approval.publicKey, signer: other, key: transport.publicKey },
      { id: other.id, approvalKey: approval.publicKey, signer: approval, key: transport.publicKey },
      {
        id: approval.id,
        approvalKey: approval.publicKey,
        signer: approval,
        key: other.publicKey,
        signedKey: transport.publicKey,
      },
    ]
    const verdicts: boolean[] = []
    for (const c of cases) {
      const binding = {
        approvalKey: c.approvalKey,
        signature: c.signer.signDomain(SIGNING_DOMAINS.relayBinding, c.signedKey ?? c.key),
      }
      const ours = await verifyBinding(c.id, c.key, binding)
      const core = verifyRelayBinding({
        type: 'hello',
        role: 'mac',
        id: c.id,
        signature: 'A'.repeat(86),
        transportKey: c.key,
        binding,
      })
      expect(ours).toBe(core)
      verdicts.push(ours)
    }
    expect(verdicts).toEqual([true, false, false, false])
  })
})

describe('the recovery code hash', () => {
  it('matches core’s, and B’s test vector', async () => {
    const { recoveryCodeHash } = await import('../src/core')
    const vector = 'b9880d7c06e097c42704a1566f627b1cfad0795a8693f185eb7b673001dbeca5'
    expect(await recoveryCodeHash('abcd-efgh ijkl-2345')).toBe(vector)
    expect(coreRecoveryCodeHash('abcd-efgh ijkl-2345')).toBe(vector)
    for (const code of [
      'RKQ4-7MXT-PW9C-3HJD',
      'short',
      'x'.repeat(65),
      'ABCD EFGH IJKL MNOP QRST',
      'ÄBCD-EFGH-IJKL-MNOP',
    ])
      expect(await recoveryCodeHash(code)).toBe(coreRecoveryCodeHash(code))
  })
})
