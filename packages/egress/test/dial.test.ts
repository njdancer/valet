// Dialling: the broker's own DNS, pinned private certificates, and every way a connection can fail.

import { type AddressInfo, createServer, type Server, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { certificateSha256, dial, ownAddresses, systemLookup } from '../src/dial'
import { RunMeter } from '../src/meter'

let api: FakeApi
/** Accepts TCP and then says nothing: a TLS handshake there never finishes. */
let silent: Server
let silentPort: number
const held: Socket[] = []
beforeAll(async () => {
  api = await startFakeApi()
  silent = createServer((s) => void held.push(s))
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
  silentPort = (silent.address() as AddressInfo).port
})
afterAll(async () => {
  for (const s of held) s.destroy()
  await new Promise<void>((r) => silent.close(() => r()))
  await api.close()
})

/** The fake API's certificate fingerprint, as a manifest would pin it. */
function apiFingerprint(): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: '127.0.0.1', port: api.port, rejectUnauthorized: false }, () => {
      resolve(certificateSha256(s.getPeerCertificate()))
      s.destroy()
    })
    s.on('error', reject)
  })
}

const toApi = { route: () => ({ address: '127.0.0.1', port: api.port }) }

describe('dial', () => {
  it('refuses a name the system resolves to loopback', async () => {
    await expect(
      dial({ kind: 'public', host: 'localhost', port: 443 }, { lookup: systemLookup }),
    ).rejects.toMatchObject({ errorClass: 'host-not-allowed' })
  })

  it('lists this machine’s own addresses, loopback among them', () => {
    expect(ownAddresses()).toContain('127.0.0.1')
  })

  it('refuses one of this machine’s own addresses as a private host', async () => {
    await expect(
      dial(
        { kind: 'private', address: '10.0.0.5', port: 80, scheme: 'http' },
        { ownAddresses: () => ['10.0.0.5'] },
      ),
    ).rejects.toMatchObject({ errorClass: 'host-not-allowed' })
  })

  it('reaches a private host by its pinned certificate, and refuses another', async () => {
    const pin = await apiFingerprint()
    const socket = await dial(
      { kind: 'private', address: '10.0.0.5', port: 443, scheme: 'https', certSha256: pin },
      { ownAddresses: () => [], testing: toApi },
    )
    socket.destroy()
    await expect(
      dial(
        { kind: 'private', address: '10.0.0.5', port: 443, scheme: 'https', certSha256: '0'.repeat(64) },
        { ownAddresses: () => [], testing: toApi },
      ),
    ).rejects.toMatchObject({ errorClass: 'unavailable' })
  })

  it('refuses a private https host whose certificate isn’t trusted and isn’t pinned', async () => {
    await expect(
      dial(
        { kind: 'private', address: '10.0.0.5', port: 443, scheme: 'https' },
        { ownAddresses: () => [], testing: toApi },
      ),
    ).rejects.toMatchObject({ errorClass: 'unavailable' })
  })

  it('fails a refused connection as unavailable', async () => {
    const closed = createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((r) => closed.close(() => r()))
    await expect(
      dial(
        { kind: 'private', address: '10.0.0.5', port, scheme: 'http' },
        {
          ownAddresses: () => [],
          testing: { route: () => ({ address: '127.0.0.1', port }) },
        },
      ),
    ).rejects.toMatchObject({ errorClass: 'unavailable' })
  })

  it('times out a handshake that never finishes, and stops when the call ends', async () => {
    const options = {
      ownAddresses: () => [],
      testing: { route: () => ({ address: '127.0.0.1', port: silentPort }) },
    }
    const target = {
      kind: 'private',
      address: '10.0.0.5',
      port: 443,
      scheme: 'https',
      certSha256: 'a'.repeat(64),
    } as const
    await expect(dial(target, { ...options, timeoutMs: 100 })).rejects.toMatchObject({
      errorClass: 'timed-out',
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await expect(dial(target, { ...options, signal: controller.signal })).rejects.toMatchObject({
      errorClass: 'aborted',
    })
    const already = new AbortController()
    already.abort()
    await expect(dial(target, { ...options, signal: already.signal })).rejects.toMatchObject({
      errorClass: 'aborted',
    })
  })

  it('fails a name that doesn’t resolve', async () => {
    await expect(
      dial(
        { kind: 'public', host: 'nothing.invalid', port: 443 },
        { lookup: (_n, cb) => cb(new Error('ENOTFOUND'), []) },
      ),
    ).rejects.toMatchObject({ errorClass: 'unavailable' })
  })
})

describe('RunMeter', () => {
  it('counts bytes both ways and earns allowance from what it receives', () => {
    const meter = new RunMeter(1024)
    meter.spend(1000)
    expect(meter.fits(100)).toBe(false)
    meter.receive(200 * 1024)
    expect(meter.bytesDown).toBe(200 * 1024)
    expect(meter.fits(100)).toBe(true)
    expect(() => meter.spend(10_000)).toThrow(expect.objectContaining({ errorClass: 'upload-budget' }))
    expect(meter.bytesUp).toBe(1000)
  })
})
