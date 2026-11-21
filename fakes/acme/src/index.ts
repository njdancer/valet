// A fake ACME CA (RFC 8555) for tests that need to run anywhere, beside the Pebble run on CI. It
// checks what a real CA checks for this client's one job: JWS signatures and nonces, TLS-ALPN-01
// by actually connecting (RFC 8737: the acme-tls/1 ALPN, the name, the critical acmeIdentifier
// extension), the CSR's key and names. It signs with its own test root and answers ACME Renewal
// Info. Knobs let a test hit the weekly rate limit, reject nonces, or move a renewal window.

import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomBytes,
  verify,
  X509Certificate,
} from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as tlsConnect } from 'node:tls'
import { ariCertId, certificate, generateP256, type KeyPair, toPem } from '@valet/acme'

export interface FakeAcmeOptions {
  /** Where TLS-ALPN-01 connects: the relay's port on 127.0.0.1, so validation goes through it. */
  readonly validationPort: number
  readonly validationHost?: string
  /** New orders allowed before `rateLimited` (orders that replace a certificate are exempt). */
  readonly newOrderLimit?: number
  /** Seconds for Retry-After on a rate limit. */
  readonly rateLimitRetryAfterS?: number
  /** Certificate lifetime. */
  readonly lifetimeMs?: number
  /** Rejects every nth nonce as bad, to exercise the client's retry. 0: never. */
  readonly rejectEveryNthNonce?: number
}

interface Account {
  readonly key: KeyObject
  readonly thumbprint: string
}

interface Order {
  readonly id: string
  readonly account: string
  readonly name: string
  readonly replaces: string | null
  status: 'pending' | 'ready' | 'processing' | 'valid' | 'invalid'
  authz: { status: 'pending' | 'valid' | 'invalid'; token: string; error?: string }
  certificate: string | null
}

export interface FakeAcme {
  readonly directoryUrl: string
  /** The test root, PEM: what a caller trusts to check an issued certificate. */
  readonly rootPem: string
  readonly orders: readonly Order[]
  /** TLS-ALPN-01 connections made, and what each found. */
  readonly validations: { name: string; ok: boolean; why: string }[]
  /** Moves a certificate's ARI window. */
  setRenewalWindow(certId: string, start: Date, end: Date): void
  setNewOrderLimit(limit: number | undefined): void
  close(): Promise<void>
}

export async function startFakeAcme(options: FakeAcmeOptions): Promise<FakeAcme> {
  const root: KeyPair = generateP256()
  const rootName = 'Fake ACME Root'
  const rootDer = certificate({
    names: [rootName],
    subjectKey: root.publicKey,
    issuerKey: root.privateKey,
    ca: true,
    notAfter: new Date(Date.now() + 365 * 86_400_000),
  })
  const rootPem = toPem(rootDer, 'CERTIFICATE')
  const nonces = new Set<string>()
  let nonceCount = 0
  const accounts = new Map<string, Account>()
  const orders: Order[] = []
  const certs = new Map<string, { pem: string; certId: string; notBefore: number; notAfter: number }>()
  const windows = new Map<string, { start: Date; end: Date }>()
  const validations: FakeAcme['validations'] = []
  let base = ''
  let newOrderLimit = options.newOrderLimit

  const newNonce = () => {
    const n = randomBytes(16).toString('base64url')
    nonces.add(n)
    return n
  }

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': typeof body === 'string' ? 'application/pem-certificate-chain' : 'application/json',
      'replay-nonce': newNonce(),
      ...headers,
    })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const problem = (res: ServerResponse, status: number, type: string, detail: string, headers = {}) =>
    send(res, status, { type: `urn:ietf:params:acme:error:${type}`, detail }, headers)

  const orderJson = (o: Order) => ({
    status: o.status,
    identifiers: [{ type: 'dns', value: o.name }],
    authorizations: [`${base}/authz/${o.id}`],
    finalize: `${base}/finalize/${o.id}`,
    ...(o.certificate === null ? {} : { certificate: `${base}/cert/${o.id}` }),
  })

  const fail = (res: ServerResponse, status: number, type: string, detail: string) => {
    problem(res, status, type, detail)
    return null
  }

  async function readJws(req: IncomingMessage, res: ServerResponse, url: string) {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    let jws: { protected: string; payload: string; signature: string }
    let header: { alg: string; nonce: string; url: string; jwk?: Record<string, string>; kid?: string }
    try {
      jws = JSON.parse(Buffer.concat(chunks).toString())
      header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString())
    } catch {
      problem(res, 400, 'malformed', 'not a JWS')
      return null
    }
    if (header.alg !== 'ES256') return fail(res, 400, 'badSignatureAlgorithm', 'ES256 only')
    nonceCount++
    const reject = options.rejectEveryNthNonce ?? 0
    if (!nonces.delete(header.nonce) || (reject > 0 && nonceCount % reject === 0)) {
      problem(res, 400, 'badNonce', 'bad nonce')
      return null
    }
    if (header.url !== url) return fail(res, 401, 'unauthorized', 'url mismatch')
    let key: KeyObject
    let accountUrl: string | null = null
    if (header.jwk !== undefined) key = createPublicKey({ key: header.jwk, format: 'jwk' })
    else {
      const account = header.kid === undefined ? undefined : accounts.get(header.kid)
      if (account === undefined) return fail(res, 400, 'accountDoesNotExist', 'no account')
      key = account.key
      accountUrl = header.kid as string
    }
    const ok = verify(
      'sha256',
      Buffer.from(`${jws.protected}.${jws.payload}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(jws.signature, 'base64url'),
    )
    if (!ok) return fail(res, 403, 'unauthorized', 'bad signature')
    const payload =
      jws.payload === ''
        ? null
        : (JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) as Record<string, unknown>)
    return { key, jwk: header.jwk, accountUrl, payload }
  }

  async function validate(order: Order): Promise<void> {
    const account = accounts.get(order.account) as Account
    const expected = createHash('sha256').update(`${order.authz.token}.${account.thumbprint}`).digest()
    const why = await new Promise<string>((resolve) => {
      const socket = tlsConnect({
        host: options.validationHost ?? '127.0.0.1',
        port: options.validationPort,
        servername: order.name,
        ALPNProtocols: ['acme-tls/1'],
        rejectUnauthorized: false,
      })
      socket.setTimeout(5000, () => {
        socket.destroy()
        resolve('timeout')
      })
      socket.on('error', (e) => resolve(`connect: ${e.message}`))
      socket.on('secureConnect', () => {
        const cert = socket.getPeerX509Certificate()
        socket.end()
        if (socket.alpnProtocol !== 'acme-tls/1') return resolve('wrong alpn')
        if (cert === undefined || cert.subjectAltName !== `DNS:${order.name}`) return resolve('wrong name')
        const raw = cert.raw
        const oid = Buffer.from([0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x1f])
        const at = raw.indexOf(oid)
        // OID, BOOLEAN TRUE (critical), OCTET STRING { OCTET STRING (32) }.
        if (at < 0 || raw[at + 10] !== 0x01 || raw[at + 12] !== 0xff)
          return resolve('no critical acmeIdentifier')
        const inner = raw.subarray(at + 13 + 4, at + 13 + 4 + 32)
        resolve(inner.equals(expected) ? 'ok' : 'wrong key authorization')
      })
    })
    validations.push({ name: order.name, ok: why === 'ok', why })
    order.authz.status = why === 'ok' ? 'valid' : 'invalid'
    if (why !== 'ok') {
      order.authz.error = why
      order.status = 'invalid'
    } else order.status = 'ready'
  }

  function issue(order: Order, csr: Buffer): string | null {
    const spkiDer = csrSpki(csr)
    if (spkiDer === null) return null
    const subject = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' })
    if (!csr.includes(Buffer.from(order.name, 'latin1'))) return null
    const notBefore = Date.now() - 60_000
    const notAfter = notBefore + (options.lifetimeMs ?? 90 * 86_400_000)
    const leaf = certificate({
      names: [order.name],
      subjectKey: subject,
      issuerKey: root.privateKey,
      issuer: { name: rootName, publicKey: root.publicKey },
      notBefore: new Date(notBefore),
      notAfter: new Date(notAfter),
    })
    const pem = toPem(leaf, 'CERTIFICATE') + rootPem
    const certId = ariCertId(new X509Certificate(leaf))
    certs.set(order.id, { pem, certId, notBefore, notAfter })
    return pem
  }

  const server: Server = createServer((req, res) => {
    const url = `${base}${req.url ?? ''}`
    const path = (req.url ?? '').split('?')[0] as string
    void (async () => {
      if (path === '/directory')
        return send(res, 200, {
          newNonce: `${base}/new-nonce`,
          newAccount: `${base}/new-account`,
          newOrder: `${base}/new-order`,
          renewalInfo: `${base}/renewal-info`,
          meta: { termsOfService: `${base}/terms` },
        })
      if (path === '/new-nonce') return send(res, req.method === 'HEAD' ? 200 : 204, {})
      if (path.startsWith('/renewal-info/')) {
        const certId = path.slice('/renewal-info/'.length)
        const known = [...certs.values()].find((c) => c.certId === certId)
        if (known === undefined) return problem(res, 404, 'malformed', 'unknown certificate')
        const window = windows.get(certId) ?? {
          start: new Date(known.notAfter - (known.notAfter - known.notBefore) / 3),
          end: new Date(known.notAfter - (known.notAfter - known.notBefore) / 6),
        }
        return send(
          res,
          200,
          { suggestedWindow: { start: window.start.toISOString(), end: window.end.toISOString() } },
          { 'retry-after': '21600' },
        )
      }
      if (req.method !== 'POST') return problem(res, 405, 'malformed', 'POST only')
      const jws = await readJws(req, res, url)
      if (jws === null) return
      if (path === '/new-account') {
        const thumbprint = createHash('sha256')
          .update(
            JSON.stringify({
              crv: jws.jwk?.['crv'],
              kty: jws.jwk?.['kty'],
              x: jws.jwk?.['x'],
              y: jws.jwk?.['y'],
            }),
          )
          .digest('base64url')
        if (jws.payload?.['termsOfServiceAgreed'] !== true)
          return problem(res, 400, 'malformed', 'agree to the terms')
        const existing = [...accounts].find(([, a]) => a.thumbprint === thumbprint)
        const accountUrl = existing?.[0] ?? `${base}/account/${randomBytes(6).toString('hex')}`
        accounts.set(accountUrl, { key: jws.key, thumbprint })
        return send(res, existing === undefined ? 201 : 200, { status: 'valid' }, { location: accountUrl })
      }
      if (jws.accountUrl === null) return problem(res, 400, 'malformed', 'use kid')
      if (path === '/new-order') {
        const identifiers = jws.payload?.['identifiers'] as { type: string; value: string }[] | undefined
        const name = identifiers?.[0]?.value
        if (identifiers?.length !== 1 || name === undefined) return problem(res, 400, 'malformed', 'one name')
        const replaces =
          typeof jws.payload?.['replaces'] === 'string' ? (jws.payload['replaces'] as string) : null
        const replacing = replaces !== null && [...certs.values()].some((c) => c.certId === replaces)
        if (replaces !== null && !replacing)
          return problem(res, 409, 'alreadyReplaced', 'unknown certificate to replace')
        const counted = orders.filter((o) => o.replaces === null).length
        if (!replacing && newOrderLimit !== undefined && counted >= newOrderLimit)
          return problem(res, 429, 'rateLimited', 'too many new certificates for this domain this week', {
            'retry-after': String(options.rateLimitRetryAfterS ?? 3600),
          })
        const order: Order = {
          id: randomBytes(6).toString('hex'),
          account: jws.accountUrl,
          name,
          replaces: replacing ? replaces : null,
          status: 'pending',
          authz: { status: 'pending', token: randomBytes(32).toString('base64url') },
          certificate: null,
        }
        orders.push(order)
        return send(res, 201, orderJson(order), { location: `${base}/order/${order.id}` })
      }
      const [, kind, id] = path.split('/')
      const order = orders.find((o) => o.id === id && o.account === jws.accountUrl)
      if (order === undefined) return problem(res, 404, 'malformed', 'no such thing')
      switch (kind) {
        case 'authz':
          return send(res, 200, {
            status: order.authz.status,
            identifier: { type: 'dns', value: order.name },
            challenges: [
              {
                type: 'http-01',
                url: `${base}/nope/${order.id}`,
                token: order.authz.token,
                status: 'pending',
              },
              {
                type: 'tls-alpn-01',
                url: `${base}/chall/${order.id}`,
                token: order.authz.token,
                status: order.authz.status,
                ...(order.authz.error === undefined
                  ? {}
                  : {
                      error: {
                        type: 'urn:ietf:params:acme:error:incorrectResponse',
                        detail: order.authz.error,
                      },
                    }),
              },
            ],
          })
        case 'chall':
          setTimeout(() => void validate(order), 10)
          return send(res, 200, { type: 'tls-alpn-01', status: 'processing', token: order.authz.token })
        case 'finalize': {
          if (order.status !== 'ready') return problem(res, 403, 'orderNotReady', 'not ready')
          const csr = Buffer.from(String(jws.payload?.['csr'] ?? ''), 'base64url')
          order.status = 'processing'
          setTimeout(() => {
            const pem = issue(order, csr)
            order.status = pem === null ? 'invalid' : 'valid'
            order.certificate = pem
          }, 10)
          return send(res, 200, orderJson(order), { 'retry-after': '0' })
        }
        case 'order':
          return send(res, 200, orderJson(order))
        case 'cert':
          return order.certificate === null
            ? problem(res, 404, 'malformed', 'no cert')
            : send(res, 200, order.certificate)
        default:
          return problem(res, 404, 'malformed', 'unknown')
      }
    })().catch(() => {
      if (!res.headersSent) problem(res, 500, 'serverInternal', 'oops')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    directoryUrl: `${base}/directory`,
    rootPem,
    orders,
    validations,
    setRenewalWindow: (certId, start, end) => windows.set(certId, { start, end }),
    setNewOrderLimit: (limit) => {
      newOrderLimit = limit
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

/** The SubjectPublicKeyInfo inside a CSR: CertificationRequest { info { version, subject, spki } }. */
function csrSpki(der: Buffer): Buffer | null {
  try {
    let at = enter(der, 0) // CertificationRequest
    at = enter(der, at) // info
    at = skip(der, at) // version
    at = skip(der, at) // subject
    return der.subarray(at, skip(der, at))
  } catch {
    return null
  }
}

function header(der: Buffer, at: number): { start: number; length: number } {
  const first = der[at + 1] as number
  if (first < 0x80) return { start: at + 2, length: first }
  const count = first & 0x7f
  let length = 0
  for (let i = 0; i < count; i++) length = length * 256 + (der[at + 2 + i] as number)
  return { start: at + 2 + count, length }
}
const enter = (der: Buffer, at: number) => header(der, at).start
const skip = (der: Buffer, at: number) => {
  const h = header(der, at)
  if (h.start + h.length > der.length) throw new RangeError('short')
  return h.start + h.length
}
