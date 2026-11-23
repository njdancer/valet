// @vitest-environment node
// Phones at the Mac's own address, through the real blind relay (docs/blind-relay.md#phones): the
// Mac app's PhoneChannel and broker behind the PhoneDoor, the real tunnel client ending TLS with
// the Mac's certificate, and the phone the relay suites use, speaking the iPhone app's frames over
// TLS for <macId>.<mac domain>. The relay sees only ciphertext.

import { mkdtempSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer, connect as netConnect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { TLSSocket, connect as tlsConnect } from 'node:tls'
import {
  type AuditEvent,
  type AuditRecord,
  openSealed,
  pairingAad,
  pairingCode,
  pairingOfferId,
  pairingSealKey,
  SIGNING_DOMAINS,
} from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as WsWebSocket } from 'ws'
import {
  certFor,
  lookup,
  MAC_DOMAIN,
  type Rig,
  startMac,
  startRig,
  type TestMac,
} from '../../../blind-relay/test/helpers'
import {
  AnchoredFile,
  ApprovalBroker,
  DeviceStore,
  type FileOps,
  MemoryAnchor,
  PAIRING_QR_PREFIX,
  PhoneChannel,
  PhoneInbox,
  SoftwareSigner,
  TrustedLedger,
} from '../../src/main/core/approvals'
import {
  DOOR_CLOSE,
  isPhoneRequest,
  PhoneDoor,
  routeByRequest,
} from '../../src/main/core/approvals/phone-door'
import { Phone } from '../phone'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

class MemoryFiles implements FileOps {
  readonly files = new Map<string, string>()
  async read(path: string) {
    return this.files.get(path) ?? null
  }
  async write(path: string, text: string) {
    this.files.set(path, text)
  }
}

async function until<T>(check: () => T | null | undefined | false, ms = 5_000): Promise<T> {
  const where = new Error('timed out').stack
  const deadline = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out ${where}`)
    await delay(20)
  }
}

interface DoorMac {
  readonly devices: DeviceStore
  readonly broker: ApprovalBroker
  readonly channel: PhoneChannel
  readonly door: PhoneDoor
  readonly tunnel: TestMac
  readonly origin: string
  readonly agreementKey: string
  readonly events: string[]
  /** Frames the channel sent that no door took (would have gone to the Worker relay). */
  readonly unrouted: string[]
}

async function startDoorMac(rig: Rig): Promise<DoorMac> {
  const signer = new SoftwareSigner(() => true)
  const keys = await signer.keys()
  const ledger = await TrustedLedger.open(
    new AnchoredFile('/t.json', 'trusted', new MemoryAnchor(), new MemoryFiles()),
  )
  const devices = new DeviceStore(ledger, keys)
  const origin = `https://${devices.macId}.${MAC_DOMAIN}`
  const events: string[] = []
  const unrouted: string[] = []
  let channel: PhoneChannel | null = null
  const broker = await ApprovalBroker.open({
    ledger,
    devices,
    signer,
    audit: { append: async (e: AuditEvent) => ({ event: e }) as unknown as AuditRecord },
    handlers: {
      'tool-enable': { apply: async () => undefined },
      'device-pair': { apply: async () => undefined },
    },
    outbox: { send: (id, m) => channel?.send(id, m) },
  })
  const inbox = new PhoneInbox(broker, devices, {
    pauseRemote: async () => undefined,
    lockdown: async () => undefined,
    revokeClient: async () => undefined,
    revokeDevice: async () => undefined,
  })
  const door = new PhoneDoor({
    devices,
    origin: () => origin,
    onEvent: (event) => {
      events.push(event.type === 'device-online' ? `online ${event.online}` : event.type)
      channel?.handle(event)
    },
  })
  cleanup.push(() => door.stop())
  channel = await PhoneChannel.open({
    devices,
    keys,
    channel: signer.channel,
    relayOrigin: () => origin,
    link: {
      send: (frame) => {
        const sent = door.send(frame)
        if (!sent) unrouted.push(frame.type)
        return sent
      },
    },
    receive: (from, text) => inbox.receive(from, text),
    approvePairing: async (pair) => {
      const asked = await broker.request('device-pair', { ...pair, platform: 'ios' }, { kind: 'person' })
      return asked.ok && (await broker.approveOnMac(asked.requestId)).ok
    },
    paired: async () => undefined,
    macName: 'Test Mac',
    status: () => ({
      at: new Date().toISOString(),
      safety: 'running',
      sites: [],
      agents: [],
      devices: [],
      recent: [],
    }),
    statePath: join(mkdtempSync(join(tmpdir(), 'door-')), 'phone-channel.json'),
  })
  const binding = (await signer.sign(SIGNING_DOMAINS.relayBinding, keys.transportKey, 'bind')) as string
  const tunnel = startMac(rig, (socket) => routeByRequest(socket, (s) => door.accept(s), null), {
    keys: {
      macId: devices.macId,
      transportKey: keys.transportKey,
      transportPrivate: undefined as never,
      binding: { approvalKey: keys.approvalKey, signature: binding },
    },
    signer: { publicKey: keys.transportKey, sign: (p) => signer.channel.signTransport(p) },
  })
  cleanup.push(() => tunnel.client.stop())
  await tunnel.online()
  return { devices, broker, channel, door, tunnel, origin, agreementKey: keys.agreementKey, events, unrouted }
}

/** A phone dialling the Mac's own name through the relay, trusting only the Mac's certificate. */
function phoneFor(rig: Rig, mac: DoorMac, origin = mac.origin): Phone {
  const host = new URL(mac.origin).hostname
  const phone = new Phone(`https://${host}`, mac.devices.macId, mac.agreementKey, origin, (c) =>
    cleanup.push(c),
  )
  phone.connect = (url) => {
    const target = new URL(url)
    target.port = String(rig.port)
    // The name the phone dials, so the relay routes by it; the port is the test relay's.
    return new WsWebSocket(target.toString(), {
      ca: mac.tunnel.cert.pem,
      lookup,
    }) as unknown as WebSocket
  }
  return phone
}

async function pair(rig: Rig, mac: DoorMac): Promise<Phone> {
  const scan = mac.channel.startPairing()
  if (scan.step !== 'scan') throw new Error(scan.step)
  const offerText = Buffer.from(scan.qr.slice(PAIRING_QR_PREFIX.length), 'base64url').toString()
  const offer = JSON.parse(offerText)
  // The QR names the Mac's own address: the phone dials it, not a relay.
  expect(offer.relay).toBe(mac.origin)
  const offerId = pairingOfferId(offer.secret)
  expect(offer.macAgreementKey).toBe(mac.agreementKey)
  const phone = phoneFor(rig, mac, offer.relay)
  const key = pairingSealKey(offer.secret, offer.macId)
  await phone.dial(() => undefined)
  const reply = phone.sendPairingReply(offer, offerId, key, 'Test iPhone')
  const challenge = await until(() => phone.frames.find((f) => f['type'] === 'pairing-challenge'))
  const code = pairingCode(offer.secret, offer.macId, offerText, reply, challenge['macNonce'] as string)
  await until(() => mac.channel.pairing.step === 'confirm')
  expect(await mac.channel.confirmPairing(code)).toMatchObject({ step: 'paired' })
  const result = await until(() => phone.frames.find((f) => f['type'] === 'pairing-result'))
  const opened = JSON.parse(
    openSealed(key, result['sealed'] as never, pairingAad('result', offerId)) as string,
  )
  expect(opened.outcome).toBe('paired')
  await until(() => phone.socket?.readyState === WebSocket.CLOSED)
  return phone
}

function closeCode(phone: Phone): Promise<number> {
  return new Promise((resolve) => {
    const socket = phone.socket as unknown as WsWebSocket
    if (socket.readyState === socket.CLOSED) return resolve(-1)
    socket.once('close', (code) => resolve(code))
  })
}

const subject = {
  adapterId: 'gumleaf',
  adapterHash: 'a'.repeat(64),
  tool: 'search',
  scope: 'local' as const,
  clientId: null,
  sideEffect: 'read' as const,
}
const agent = { kind: 'agent' as const, clientId: 'local:claude', clientName: 'Claude Code' }

describe('phones at the Mac’s own address, through the blind relay', () => {
  it('pairs, delivers a card, takes its approval, and resends what waited while the phone was away', async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const mac = await startDoorMac(rig)
    const phone = await pair(rig, mac)

    // The channel: dial again, hello signed for the Mac's own origin, and the status arrives.
    await phone.dial((nonce) => phone.hello(nonce))
    expect(await until(() => phone.frames.find((f) => f['type'] === 'ready'))).toEqual({
      type: 'ready',
      macOnline: true,
    })
    expect(phone.frames[0]).toMatchObject({ type: 'challenge', relay: mac.origin })
    await until(() => phone.messages.find((m) => m['type'] === 'status'))
    expect(mac.door.online(phone.deviceId)).toBe(true)

    const asked = await mac.broker.request('tool-enable', subject, agent)
    if (!asked.ok) throw new Error(asked.reason)
    const card = await until(() => phone.messages.find((m) => m['type'] === 'approval-request'))
    await phone.send({ type: 'ack', ackSeq: card['seq'] })
    await phone.send({
      type: 'approval-decision',
      decision: phone.approve(card['requestText'] as string, mac.devices.macId),
    })
    expect(await mac.broker.wait(asked.requestId)).toMatchObject({
      outcome: 'approved',
      deviceId: phone.deviceId,
    })

    // Nothing the phone and Mac said is readable at the relay: TLS ends on the Mac.
    const relayed = Buffer.concat(mac.tunnel.received).toString('latin1')
    expect(relayed).not.toContain('envelope')
    expect(relayed).not.toContain('/v1/phone/')
    expect(relayed).not.toContain(phone.deviceId)

    // The phone goes away: a request waits, and opening the phone delivers it.
    phone.socket?.close()
    await until(() => !mac.door.online(phone.deviceId))
    const later = await mac.broker.request('tool-enable', { ...subject, tool: 'order' }, agent)
    if (!later.ok) throw new Error(later.reason)
    const before = phone.messages.length
    await phone.dial((nonce) => phone.hello(nonce))
    await until(() =>
      phone.messages
        .slice(before)
        .find((m) => m['type'] === 'approval-request' && String(m['requestText']).includes(later.requestId)),
    )
    await phone.send({ type: 'approval-decline', requestId: later.requestId, note: 'Not now' })
    expect(await mac.broker.wait(later.requestId)).toMatchObject({ outcome: 'declined', note: 'Not now' })
    // Only pushes, and envelopes for the phone while it was away (resent once it was back).
    expect([...new Set(mac.unrouted)].sort()).toEqual(['envelope', 'push'])
  }, 30_000)

  it('refuses a stranger, a signature for another origin, and junk pairing replies, all the same way', async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const mac = await startDoorMac(rig)
    const paired = await pair(rig, mac)

    const stranger = phoneFor(rig, mac)
    await stranger.dial((nonce) => stranger.hello(nonce))
    expect(await closeCode(stranger)).toBe(DOOR_CLOSE.authFailed)

    // The paired phone's own key, but signing for the Worker relay's origin: refused.
    const elsewhere = phoneFor(rig, mac, 'https://relay.example')
    Object.assign(elsewhere, {
      approval: paired.approval,
      transport: paired.transport,
      agreement: paired.agreement,
      deviceId: paired.deviceId,
    })
    await elsewhere.dial((nonce) => elsewhere.hello(nonce))
    expect(await closeCode(elsewhere)).toBe(DOOR_CLOSE.authFailed)

    const junk = phoneFor(rig, mac)
    await junk.dial(() => undefined)
    junk.socket?.send(
      JSON.stringify({
        type: 'pairing-reply',
        macId: mac.devices.macId,
        offerId: 'f'.repeat(32),
        sealed: { iv: 'a'.repeat(16), ct: 'b'.repeat(40) },
      }),
    )
    expect(await closeCode(junk)).toBe(DOOR_CLOSE.authFailed)
    expect(mac.events.filter((e) => e === 'pairing-reply')).toHaveLength(1)
  }, 30_000)

  it('refuses envelopes that claim another sender, and shuts out a phone the Mac removes', async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const mac = await startDoorMac(rig)
    const phone = await pair(rig, mac)
    await phone.dial((nonce) => phone.hello(nonce))
    await until(() => phone.frames.find((f) => f['type'] === 'ready'))
    phone.socket?.send(
      JSON.stringify({
        type: 'envelope',
        envelope: {
          v: 1,
          suite: 'hpke-auth-p256-sha256-aes256gcm',
          from: 'a'.repeat(32),
          to: mac.devices.macId,
          enc: 'e'.repeat(87),
          ct: 'c'.repeat(40),
        },
      }),
    )
    expect(await closeCode(phone)).toBe(DOOR_CLOSE.badFrame)

    await phone.dial((nonce) => phone.hello(nonce))
    await until(() => mac.door.online(phone.deviceId))
    const closed = closeCode(phone)
    mac.channel.unpair(phone.deviceId)
    await mac.devices.revoke(phone.deviceId, mac.devices.macId, new Date().toISOString())
    mac.door.devicesChanged()
    expect(await closed).toBe(DOOR_CLOSE.unregistered)
    // It can't come back.
    await phone.dial((nonce) => phone.hello(nonce))
    expect(await closeCode(phone)).toBe(DOOR_CLOSE.authFailed)
  }, 30_000)

  it('replaces an older connection from the same phone', async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const mac = await startDoorMac(rig)
    const phone = await pair(rig, mac)
    await phone.dial((nonce) => phone.hello(nonce))
    await until(() => phone.frames.find((f) => f['type'] === 'ready'))
    const first = closeCode(phone)
    const again = phoneFor(rig, mac)
    Object.assign(again, {
      approval: phone.approval,
      transport: phone.transport,
      agreement: phone.agreement,
      deviceId: phone.deviceId,
    })
    await again.dial((nonce) => again.hello(nonce))
    expect(await first).toBe(DOOR_CLOSE.replaced)
    await until(() => again.frames.find((f) => f['type'] === 'ready'))
    expect(mac.door.online(phone.deviceId)).toBe(true)
  }, 30_000)
})

describe('routeByRequest', () => {
  async function serve(handle: (socket: import('node:net').Socket) => void): Promise<Server> {
    const server = createServer(handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    return server
  }

  async function send(server: Server, text: string, pieces = 1): Promise<void> {
    const address = server.address() as { port: number }
    const socket = netConnect({ host: '127.0.0.1', port: address.port })
    cleanup.push(() => {
      socket.destroy()
    })
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    const step = Math.ceil(text.length / pieces)
    for (let i = 0; i < text.length; i += step) {
      socket.write(text.slice(i, i + step))
      await delay(10)
    }
  }

  it('hands each connection on whole, by its first request line, even when it arrives in pieces', async () => {
    const got: string[] = []
    const take = (who: string) => (socket: import('node:stream').Duplex) => {
      let text = ''
      socket.on('data', (c: Buffer) => {
        text += c.toString()
        if (text.endsWith('\r\n\r\n')) got.push(`${who}: ${text.split('\r\n')[0]}`)
      })
    }
    const server = await serve((socket) => routeByRequest(socket, take('phone'), take('other')))
    await send(server, 'GET /v1/phone/abc HTTP/1.1\r\nhost: x\r\n\r\n', 5)
    await send(server, 'POST /mcp HTTP/1.1\r\nhost: x\r\n\r\n', 3)
    await until(() => got.length === 2)
    expect(got.sort()).toEqual(['other: POST /mcp HTTP/1.1', 'phone: GET /v1/phone/abc HTTP/1.1'])
  })

  it('hands a connection that waits before its first request to the other side, never closing it', async () => {
    const got: string[] = []
    let closed = false
    const take = (who: string) => (socket: import('node:stream').Duplex) => {
      let text = ''
      socket.on('data', (c: Buffer) => {
        text += c.toString()
        if (text.endsWith('\r\n\r\n')) got.push(`${who}: ${text.split('\r\n')[0]}`)
      })
    }
    const server = await serve((socket) => {
      socket.once('close', () => {
        closed = true
      })
      routeByRequest(socket, take('phone'), take('other'), 100)
    })
    const address = server.address() as { port: number }
    const client = netConnect({ host: '127.0.0.1', port: address.port })
    cleanup.push(() => {
      client.destroy()
    })
    await new Promise<void>((resolve) => client.once('connect', () => resolve()))
    await delay(300)
    expect(closed).toBe(false)
    client.write('POST /register HTTP/1.1\r\nhost: x\r\n\r\n')
    await until(() => got.length === 1)
    expect(got).toEqual(['other: POST /register HTTP/1.1'])
    expect(closed).toBe(false)
  })

  it('answers a request whose body came in the same read as its head, as Python’s httpx sends it', async () => {
    // Claude's connector check writes the headers, then the body: two TLS records that can reach
    // the Mac in one read. The HTTP server must still see the head first (it answered 400).
    const cert = certFor(['mac.test'])
    let hold: Buffer[] | null = null
    const macEnd: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _e, done) {
        callerEnd.push(chunk)
        done()
      },
    })
    const callerEnd: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _e, done) {
        if (hold === null) macEnd.push(chunk)
        else hold.push(chunk)
        done()
      },
    })
    const bodies: string[] = []
    const errors: string[] = []
    const app = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString()
      })
      req.on('end', () => {
        bodies.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(401, { connection: 'close' }).end()
      })
    })
    app.on('clientError', (error: Error & { code?: string }, socket) => {
      errors.push(error.code ?? 'error')
      socket.destroy()
    })
    const mac = new TLSSocket(macEnd, {
      isServer: true,
      secureContext: cert.context,
      ALPNProtocols: ['http/1.1'],
    })
    routeByRequest(
      mac,
      () => undefined,
      (socket) => app.emit('connection', socket),
    )
    const caller = tlsConnect({
      socket: callerEnd,
      ca: cert.pem,
      servername: 'mac.test',
      ALPNProtocols: ['http/1.1'],
    })
    await new Promise<void>((resolve) => caller.once('secureConnect', () => resolve()))
    let answer = ''
    caller.on('data', (c: Buffer) => {
      answer += c.toString()
    })
    hold = []
    const body = '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
    caller.write(`POST /mcp HTTP/1.1\r\nhost: mac.test\r\ncontent-length: ${body.length}\r\n\r\n`)
    caller.write(body)
    await delay(20)
    const both = Buffer.concat(hold)
    hold = null
    macEnd.push(both)
    await until(() => answer.includes('\r\n\r\n') || errors.length > 0)
    expect(errors).toEqual([])
    expect(answer.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized')
    expect(bodies).toEqual([`POST /mcp ${body}`])
    // A `connection: close` answer closes the connection on the Mac's side, without waiting for
    // the caller to (its tunnel stream would hold the relay link's window till then).
    await until(() => mac.destroyed)
  })

  it('knows a phone’s request line and nothing else', () => {
    expect(isPhoneRequest('GET /v1/phone/0123 HTTP/1.1')).toBe(true)
    expect(isPhoneRequest('POST /v1/phone/0123 HTTP/1.1')).toBe(false)
    expect(isPhoneRequest('GET /mcp HTTP/1.1')).toBe(false)
    expect(isPhoneRequest('GET /v1/phones HTTP/1.1')).toBe(false)
  })
})
