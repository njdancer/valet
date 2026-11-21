import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { certificateRequest, generateP256, privateKeyPem, selfSignedCertificate, toPem } from '../src'

function openssl(args: string[]): string {
  return execFileSync('openssl', args, { encoding: 'utf8' })
}

describe('selfSignedCertificate', () => {
  it('makes a certificate Node reads, for the names given, signed by the key', () => {
    const keys = generateP256()
    const der = selfSignedCertificate(keys, { names: ['a.macs.test', 'b.macs.test'] })
    const cert = new X509Certificate(der)
    expect(cert.subjectAltName).toBe('DNS:a.macs.test, DNS:b.macs.test')
    expect(cert.subject).toBe('CN=a.macs.test')
    expect(cert.verify(keys.publicKey)).toBe(true)
    expect(cert.checkHost('a.macs.test')).toBe('a.macs.test')
    expect(cert.publicKey.equals(keys.publicKey)).toBe(true)
    // TLS takes it with its key.
    createSecureContext({ key: privateKeyPem(keys), cert: toPem(der, 'CERTIFICATE') })
  })

  it('writes dates after 2049 as GeneralizedTime', () => {
    const keys = generateP256()
    const cert = new X509Certificate(
      selfSignedCertificate(keys, {
        names: ['x.test'],
        notBefore: new Date('2049-12-31T00:00:00Z'),
        notAfter: new Date('2051-01-02T03:04:05Z'),
      }),
    )
    expect(new Date(cert.validTo).toISOString()).toBe('2051-01-02T03:04:05.000Z')
    expect(new Date(cert.validFrom).toISOString()).toBe('2049-12-31T00:00:00.000Z')
  })

  it('carries the critical acmeIdentifier extension for TLS-ALPN-01', () => {
    const keys = generateP256()
    const der = selfSignedCertificate(keys, { names: ['a.macs.test'], acmeKeyAuthorization: 'token.thumb' })
    const dir = mkdtempSync(join(tmpdir(), 'alpn-'))
    writeFileSync(join(dir, 'c.der'), der)
    const text = openssl(['x509', '-inform', 'DER', '-in', join(dir, 'c.der'), '-noout', '-text'])
    expect(text).toMatch(/1\.3\.6\.1\.5\.5\.7\.1\.31: critical/)
  })
})

describe('certificateRequest', () => {
  it('makes a request openssl verifies, with the names as SANs', () => {
    const keys = generateP256()
    const pem = toPem(certificateRequest(keys, ['m.macs.test']), 'CERTIFICATE REQUEST')
    const dir = mkdtempSync(join(tmpdir(), 'csr-'))
    writeFileSync(join(dir, 'r.pem'), pem)
    const text = openssl(['req', '-in', join(dir, 'r.pem'), '-noout', '-verify', '-text'])
    expect(text).toContain('DNS:m.macs.test')
    expect(text).toMatch(/CN\s*=\s*m\.macs\.test/)
  })
})
