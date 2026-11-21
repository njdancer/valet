// The two certificate structures a Mac writes itself: the request it sends Let's Encrypt
// (PKCS #10, RFC 2986) and a self-signed certificate (RFC 5280), which TLS-ALPN-01 (RFC 8737)
// needs for its challenge and tests need as a stand-in. Keys are P-256 and signatures ECDSA with
// SHA-256, done by Node's crypto.

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto'
import {
  bitString,
  boolean,
  type Der,
  explicit,
  implicitPrimitive,
  integer,
  octetString,
  oid,
  sequence,
  set,
  time,
  tlv,
  utf8String,
} from './der'

const OID = {
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  basicConstraints: '2.5.29.19',
  extKeyUsage: '2.5.29.37',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  /** RFC 8737 section 6.1. */
  acmeIdentifier: '1.3.6.1.5.5.7.1.31',
} as const

export interface KeyPair {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
}

export function generateP256(): KeyPair {
  return generateKeyPairSync('ec', { namedCurve: 'P-256' })
}

const signatureAlgorithm = (): Der => sequence(oid(OID.ecdsaWithSha256))

function name(commonName: string): Der {
  return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))))
}

function extension(id: string, value: Der, critical = false): Der {
  return critical
    ? sequence(oid(id), boolean(true), octetString(value))
    : sequence(oid(id), octetString(value))
}

function subjectAltName(names: readonly string[]): Der {
  return extension(
    OID.subjectAltName,
    sequence(...names.map((n) => implicitPrimitive(2, Buffer.from(n, 'latin1')))),
  )
}

function signed(body: Der, key: KeyObject): Der {
  const signature = sign('sha256', body, { key, dsaEncoding: 'der' })
  return sequence(body, signatureAlgorithm(), bitString(signature))
}

function spki(key: KeyObject): Der {
  return key.export({ type: 'spki', format: 'der' })
}

/** A certificate signing request for `names`, the first as the common name. DER. */
export function certificateRequest(keys: KeyPair, names: readonly string[]): Der {
  const first = names[0]
  if (first === undefined) throw new Error('no names')
  const extensions = sequence(subjectAltName(names))
  const attributes = tlv(0xa0, sequence(oid(OID.extensionRequest), set(extensions)))
  const info = sequence(integer(Buffer.from([0])), name(first), spki(keys.publicKey), attributes)
  return signed(info, keys.privateKey)
}

export interface SelfSignedOptions {
  readonly names: readonly string[]
  readonly notBefore?: Date
  readonly notAfter?: Date
  /** RFC 8737: the SHA-256 of the key authorization, in a critical acmeIdentifier extension. */
  readonly acmeKeyAuthorization?: string
}

/** A self-signed certificate for `names`. DER. */
export function selfSignedCertificate(keys: KeyPair, options: SelfSignedOptions): Der {
  return certificate({ ...options, subjectKey: keys.publicKey, issuerKey: keys.privateKey })
}

export interface CertificateOptions extends SelfSignedOptions {
  readonly subjectKey: KeyObject
  /** Signs it. */
  readonly issuerKey: KeyObject
  /** The issuer's common name and public key, when it is not self-signed (a test CA). */
  readonly issuer?: { readonly name: string; readonly publicKey: KeyObject }
  /** A CA certificate (basicConstraints cA), for a test CA's root. */
  readonly ca?: boolean
  readonly serial?: Buffer
}

/** A certificate, for a test CA or a self-signed one. DER. */
export function certificate(options: CertificateOptions): Der {
  const first = options.names[0]
  if (first === undefined) throw new Error('no names')
  const notBefore = options.notBefore ?? new Date(Date.now() - 60_000)
  const notAfter = options.notAfter ?? new Date(notBefore.getTime() + 7 * 86_400_000)
  const serial = options.serial ?? randomBytes(16)
  serial[0] = (serial[0] as number) & 0x7f
  const extensions = [
    subjectAltName(options.names),
    extension(OID.basicConstraints, options.ca === true ? sequence(boolean(true)) : sequence(), true),
    extension(OID.subjectKeyIdentifier, octetString(keyIdentifier(options.subjectKey))),
  ]
  if (options.ca !== true) extensions.push(extension(OID.extKeyUsage, sequence(oid(OID.serverAuth))))
  if (options.issuer !== undefined)
    extensions.push(
      extension(
        OID.authorityKeyIdentifier,
        sequence(implicitPrimitive(0, keyIdentifier(options.issuer.publicKey))),
      ),
    )
  if (options.acmeKeyAuthorization !== undefined) {
    const digest = createHash('sha256').update(options.acmeKeyAuthorization, 'utf8').digest()
    extensions.push(extension(OID.acmeIdentifier, octetString(digest), true))
  }
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    signatureAlgorithm(),
    name(options.issuer?.name ?? first),
    sequence(time(notBefore), time(notAfter)),
    name(first),
    spki(options.subjectKey),
    explicit(3, sequence(...extensions)),
  )
  return signed(tbs, options.issuerKey)
}

/** RFC 5280 section 4.2.1.2, method 1: SHA-1 of the public key's bits. */
function keyIdentifier(key: KeyObject): Buffer {
  const der = spki(key)
  // The BIT STRING is the last element of the SPKI; for P-256 its 65 key bytes end the encoding.
  return createHash('sha1')
    .update(der.subarray(der.length - 65))
    .digest()
}

export function toPem(der: Der, label: 'CERTIFICATE' | 'CERTIFICATE REQUEST'): string {
  const body = der
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .replace(/\n$/, '')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export function privateKeyPem(keys: KeyPair): string {
  return keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}
