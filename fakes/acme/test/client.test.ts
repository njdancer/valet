// The ACME client against the fake CA, with a plain TLS server answering TLS-ALPN-01 in place of
// the relay and the Mac (apps/blind-relay/test/certificates.test.ts covers that whole path).

import { X509Certificate } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { createSecureContext, type SecureContext, TLSSocket } from 'node:tls'
import {
  AcmeClient,
  AcmeError,
  ariCertId,
  generateP256,
  jwkThumbprint,
  privateKeyPem,
  selfSignedCertificate,
  toPem,
} from '@valet/acme'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeAcme, startFakeAcme } from '../src'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** Answers acme-tls/1 for whatever `present` set up; closes anything else. */
async function responder() {
  const contexts = new Map<string, SecureContext>()
  const server: Server = createServer((raw) => {
    raw.once('readable', () => {
      const tls = new TLSSocket(raw, {
        isServer: true,
        ALPNProtocols: ['acme-tls/1'],
        SNICallback: (name, cb) => cb(null, contexts.get(name) ?? createSecureContext()),
      })
      tls.on('error', () => tls.destroy())
      tls.on('secure', () => tls.end())
    })
    raw.on('error', () => undefined)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
  return {
    port: (server.address() as { port: number }).port,
    present: (name: string, keyAuthorization: string) => {
      const keys = generateP256()
      const der = selfSignedCertificate(keys, { names: [name], acmeKeyAuthorization: keyAuthorization })
      contexts.set(name, createSecureContext({ key: privateKeyPem(keys), cert: toPem(der, 'CERTIFICATE') }))
    },
    clear: (name: string) => {
      contexts.delete(name)
    },
    wrong: (name: string) => {
      const keys = generateP256()
      const der = selfSignedCertificate(keys, { names: [name], acmeKeyAuthorization: 'not.it' })
      contexts.set(name, createSecureContext({ key: privateKeyPem(keys), cert: toPem(der, 'CERTIFICATE') }))
    },
  }
}

async function setup(options: Partial<Parameters<typeof startFakeAcme>[0]> = {}) {
  const tls = await responder()
  const acme: FakeAcme = await startFakeAcme({ validationPort: tls.port, ...options })
  cleanup.push(() => acme.close())
  const client = new AcmeClient({ directoryUrl: acme.directoryUrl, accountKey: generateP256(), pollMs: 10 })
  return { tls, acme, client }
}

describe('AcmeClient', () => {
  it('issues a certificate for the name and key, with its ARI id', async () => {
    const { tls, acme, client } = await setup({ rejectEveryNthNonce: 3 })
    const key = generateP256()
    const issued = await client.issue({
      name: 'a.macs.test',
      certificateKey: key,
      present: tls.present,
      clear: tls.clear,
    })
    const leaf = new X509Certificate(issued.pem)
    expect(leaf.checkHost('a.macs.test')).toBe('a.macs.test')
    expect(leaf.publicKey.equals(key.publicKey)).toBe(true)
    expect(leaf.verify(new X509Certificate(acme.rootPem).publicKey)).toBe(true)
    expect(issued.certId).toBe(ariCertId(leaf))
    expect(issued.notAfter.getTime()).toBeGreaterThan(Date.now())
    expect(client.accountUrl).toMatch(/\/account\//)
    // The same key finds the same account again.
    const again = new AcmeClient({ directoryUrl: acme.directoryUrl, accountKey: client.accountKey })
    expect(await again.account()).toBe(client.accountUrl)
    const window = await client.renewalWindow(issued.certId)
    expect(window?.start.getTime()).toBeLessThan(window?.end.getTime() as number)
    expect(window?.checkAgainAt.getTime()).toBeGreaterThan(Date.now() + 3600_000)
  })

  it('reports a rate limit with when to come back', async () => {
    const { tls, client } = await setup({ newOrderLimit: 0, rateLimitRetryAfterS: 120 })
    const error = await client
      .issue({ name: 'a.macs.test', certificateKey: generateP256(), present: tls.present, clear: tls.clear })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AcmeError)
    expect((error as AcmeError).rateLimited).toBe(true)
    expect((error as AcmeError).retryAfter?.getTime()).toBeGreaterThan(Date.now() + 100_000)
  })

  it('fails when the challenge answer is wrong, and clears what it set up', async () => {
    const { tls, acme, client } = await setup()
    const cleared: string[] = []
    const error = await client
      .issue({
        name: 'b.macs.test',
        certificateKey: generateP256(),
        present: (name) => tls.wrong(name),
        clear: (name) => {
          cleared.push(name)
        },
      })
      .catch((e: unknown) => e)
    expect((error as AcmeError).message).toContain('wrong key authorization')
    expect(cleared).toEqual(['b.macs.test'])
    expect(acme.validations[0]?.ok).toBe(false)
  })

  it('refuses a replacement for a certificate the CA never issued', async () => {
    const { tls, client } = await setup()
    const error = await client
      .issue({
        name: 'c.macs.test',
        certificateKey: generateP256(),
        present: tls.present,
        clear: tls.clear,
        replaces: 'AAAA.BBBB',
      })
      .catch((e: unknown) => e)
    expect((error as AcmeError).type).toBe('urn:ietf:params:acme:error:alreadyReplaced')
  })

  it('says when the directory is unusable', async () => {
    const client = new AcmeClient({
      directoryUrl: 'http://ca.invalid/directory',
      accountKey: generateP256(),
      fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    })
    await expect(client.getDirectory()).rejects.toThrow('directory is missing endpoints')
    const down = new AcmeClient({
      directoryUrl: 'http://ca.invalid/directory',
      accountKey: generateP256(),
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    })
    await expect(down.getDirectory()).rejects.toThrow('could not read the directory')
  })

  it('has no renewal window from a CA without ARI', async () => {
    const client = new AcmeClient({
      directoryUrl: 'http://ca.invalid/directory',
      accountKey: generateP256(),
      fetch: (async () =>
        Response.json({
          newNonce: 'http://ca.invalid/n',
          newAccount: 'http://ca.invalid/a',
          newOrder: 'http://ca.invalid/o',
        })) as typeof fetch,
    })
    expect(await client.renewalWindow('x.y')).toBeNull()
  })

  it('computes the RFC 7638 thumbprint', () => {
    // RFC 7638 section 3.1's example is RSA; this checks the P-256 member order instead.
    const a = jwkThumbprint({ kty: 'EC', crv: 'P-256', x: 'X', y: 'Y', extra: 'ignored' })
    const b = jwkThumbprint({ y: 'Y', x: 'X', crv: 'P-256', kty: 'EC' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})
