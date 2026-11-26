// Talking to an iPhone plugged in to this Mac, the way Finder and Xcode do: usbmuxd (the Mac's USB
// multiplexer, /var/run/usbmuxd), then lockdownd on the phone with the pair record the Mac already
// holds, then SpringBoard's own service for the home screen. Nothing to install: macOS ships usbmuxd,
// and the pair record exists once the person has tapped "Trust" on the phone.
//
// The home screen service is the one libimobiledevice (sbservices) and pymobiledevice3 use. It is
// not a supported Apple API; reading is safe, writing is done only on the person's approval.

import { connect, type Socket } from 'node:net'
import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import { decode, encodeXml, isDict, type PlistValue } from './plist'

export const USBMUXD_SOCKET = '/var/run/usbmuxd'
const LOCKDOWN_PORT = 62078
const LABEL = 'valet'
export const SPRINGBOARD_SERVICE = 'com.apple.springboardservices'

export class DeviceError extends Error {
  constructor(
    /** What went wrong, for Valet to put in words. */
    readonly code:
      | 'no-usbmuxd'
      | 'not-attached'
      | 'not-paired'
      | 'locked'
      | 'refused'
      | 'protocol'
      | 'timeout'
      | 'closed',
    message: string,
  ) {
    super(message)
  }
}

/** Bytes in, whole messages out. */
class Reader {
  private chunks: Buffer[] = []
  private size = 0
  private waiting: (() => void) | null = null
  private ended: Error | null = null

  constructor(private readonly socket: Socket | TLSSocket) {
    socket.on('data', this.onData)
    socket.on('error', (error) => this.end(error))
    socket.on('close', () => this.end(new DeviceError('closed', 'The phone closed the connection.')))
  }

  private readonly onData = (chunk: Buffer): void => {
    this.chunks.push(chunk)
    this.size += chunk.length
    this.waiting?.()
  }

  private end(error: Error): void {
    if (this.ended === null) this.ended = error
    this.waiting?.()
  }

  /** Stops reading and returns whatever came in beyond what was read: for a TLS upgrade. */
  detach(): Buffer {
    this.socket.off('data', this.onData)
    const rest = Buffer.concat(this.chunks)
    this.chunks = []
    this.size = 0
    return rest
  }

  async take(n: number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs
    while (this.size < n) {
      if (this.ended !== null) throw this.ended
      const left = deadline - Date.now()
      if (left <= 0) throw new DeviceError('timeout', 'The phone took too long to answer.')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left)
        this.waiting = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.waiting = null
    }
    const all = Buffer.concat(this.chunks)
    this.chunks = all.length > n ? [all.subarray(n)] : []
    this.size = all.length - n
    return all.subarray(0, n)
  }
}

function openUnix(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', () =>
      reject(new DeviceError('no-usbmuxd', 'This Mac’s USB service for iPhones isn’t answering.')),
    )
  })
}

// ---------- usbmuxd ----------

export interface AttachedDevice {
  readonly deviceId: number
  readonly udid: string
  readonly connection: string
}

export interface PairRecord {
  readonly hostCertificate: Uint8Array
  readonly hostPrivateKey: Uint8Array
  readonly hostId: string
  readonly systemBuid: string
}

/** One message to usbmuxd and its answer, on a fresh socket that can then become a tunnel. */
class Mux {
  private tag = 1
  readonly reader: Reader

  private constructor(readonly socket: Socket) {
    this.reader = new Reader(socket)
  }

  static async open(path: string): Promise<Mux> {
    return new Mux(await openUnix(path))
  }

  send(message: Record<string, PlistValue>): void {
    const body = Buffer.from(
      encodeXml({ ClientVersionString: LABEL, ProgName: LABEL, kLibUSBMuxVersion: 3, ...message }),
      'utf8',
    )
    const header = Buffer.alloc(16)
    header.writeUInt32LE(16 + body.length, 0)
    header.writeUInt32LE(1, 4) // version
    header.writeUInt32LE(8, 8) // plist message
    header.writeUInt32LE(this.tag++, 12)
    this.socket.write(Buffer.concat([header, body]))
  }

  async receive(timeoutMs = 10_000): Promise<Record<string, PlistValue>> {
    const header = await this.reader.take(16, timeoutMs)
    const length = header.readUInt32LE(0)
    if (length < 16 || length > 16 * 1024 * 1024)
      throw new DeviceError('protocol', 'usbmuxd sent a bad message.')
    const body = await this.reader.take(length - 16, timeoutMs)
    const value = decode(body)
    if (!isDict(value)) throw new DeviceError('protocol', 'usbmuxd sent a bad message.')
    return value
  }

  close(): void {
    this.socket.destroy()
  }
}

export interface DeviceDeps {
  readonly socketPath?: string
}

export async function listDevices(deps: DeviceDeps = {}): Promise<AttachedDevice[]> {
  const mux = await Mux.open(deps.socketPath ?? USBMUXD_SOCKET)
  try {
    mux.send({ MessageType: 'ListDevices' })
    const reply = await mux.receive()
    const list = Array.isArray(reply['DeviceList']) ? reply['DeviceList'] : []
    return list.flatMap((entry) => (isDict(entry) ? attached(entry) : []))
  } finally {
    mux.close()
  }
}

function attached(entry: Record<string, PlistValue>): AttachedDevice[] {
  const props = isDict(entry['Properties']) ? entry['Properties'] : {}
  const id = entry['DeviceID']
  const udid = props['SerialNumber']
  if (typeof id !== 'number' || typeof udid !== 'string') return []
  return [{ deviceId: id, udid, connection: String(props['ConnectionType'] ?? 'USB') }]
}

/** Calls back as phones come and go, until stop() is called. Reconnects if usbmuxd restarts. */
export function watchDevices(
  onChange: (
    event: { kind: 'attached'; device: AttachedDevice } | { kind: 'detached'; deviceId: number },
  ) => void,
  deps: DeviceDeps & { readonly retryMs?: number } = {},
): { stop(): void } {
  let stopped = false
  let current: Mux | null = null
  const loop = async () => {
    while (!stopped) {
      try {
        const mux = await Mux.open(deps.socketPath ?? USBMUXD_SOCKET)
        current = mux
        mux.send({ MessageType: 'Listen' })
        for (;;) {
          const message = await mux.receive(24 * 3600_000)
          if (message['MessageType'] === 'Attached')
            for (const device of attached(message)) onChange({ kind: 'attached', device })
          else if (message['MessageType'] === 'Detached' && typeof message['DeviceID'] === 'number')
            onChange({ kind: 'detached', deviceId: message['DeviceID'] })
        }
      } catch {
        current?.close()
        current = null
        if (stopped) return
        await new Promise((r) => setTimeout(r, deps.retryMs ?? 5000))
      }
    }
  }
  void loop()
  return {
    stop() {
      stopped = true
      current?.close()
    },
  }
}

export async function readPairRecord(udid: string, deps: DeviceDeps = {}): Promise<PairRecord> {
  const mux = await Mux.open(deps.socketPath ?? USBMUXD_SOCKET)
  try {
    mux.send({ MessageType: 'ReadPairRecord', PairRecordID: udid })
    const reply = await mux.receive()
    const data = reply['PairRecordData']
    if (!(data instanceof Uint8Array))
      throw new DeviceError('not-paired', 'This Mac isn’t trusted by the phone yet: unlock it and tap Trust.')
    const record = decode(data)
    if (!isDict(record)) throw new DeviceError('not-paired', 'The pair record is unreadable.')
    const cert = record['HostCertificate']
    const key = record['HostPrivateKey']
    const hostId = record['HostID']
    const buid = record['SystemBUID']
    if (
      !(cert instanceof Uint8Array) ||
      !(key instanceof Uint8Array) ||
      typeof hostId !== 'string' ||
      typeof buid !== 'string'
    )
      throw new DeviceError('not-paired', 'The pair record is incomplete.')
    return { hostCertificate: cert, hostPrivateKey: key, hostId, systemBuid: buid }
  } finally {
    mux.close()
  }
}

async function tunnel(deviceId: number, port: number, deps: DeviceDeps): Promise<Mux> {
  const mux = await Mux.open(deps.socketPath ?? USBMUXD_SOCKET)
  mux.send({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: ((port & 0xff) << 8) | (port >> 8) })
  const reply = await mux.receive()
  if (reply['Number'] !== 0) {
    mux.close()
    throw new DeviceError('not-attached', 'The phone isn’t plugged in any more.')
  }
  return mux
}

// ---------- Framed plist channel (lockdownd and its services) ----------

export class PlistChannel {
  private constructor(
    private socket: Socket | TLSSocket,
    private reader: Reader,
  ) {}

  static over(mux: Mux): PlistChannel {
    return new PlistChannel(mux.socket, mux.reader)
  }

  send(message: Record<string, PlistValue>): void {
    const body = Buffer.from(encodeXml(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length, 0)
    this.socket.write(Buffer.concat([header, body]))
  }

  async receive(timeoutMs = 30_000): Promise<PlistValue> {
    const header = await this.reader.take(4, timeoutMs)
    const length = header.readUInt32BE(0)
    if (length > 64 * 1024 * 1024)
      throw new DeviceError('protocol', 'The phone sent a message too large to read.')
    return decode(await this.reader.take(length, timeoutMs))
  }

  async request(
    message: Record<string, PlistValue>,
    timeoutMs?: number,
  ): Promise<Record<string, PlistValue>> {
    this.send(message)
    const reply = await this.receive(timeoutMs)
    if (!isDict(reply)) throw new DeviceError('protocol', 'The phone sent an unexpected answer.')
    return reply
  }

  /** Switches the channel to TLS with the Mac's half of the pair record. */
  async startTls(pair: PairRecord): Promise<void> {
    const rest = this.reader.detach()
    if (rest.length > 0) throw new DeviceError('protocol', 'The phone sent data before TLS.')
    const plain = this.socket as Socket
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({
        socket: plain,
        cert: Buffer.from(pair.hostCertificate),
        key: Buffer.from(pair.hostPrivateKey),
        rejectUnauthorized: false,
        // Phones' pair records use old key sizes and signatures that OpenSSL 3 refuses by default.
        ciphers: 'ALL:@SECLEVEL=0',
        minVersion: 'TLSv1',
      })
      s.once('secureConnect', () => resolve(s))
      s.once('error', () => reject(new DeviceError('refused', 'The phone refused the secure connection.')))
    })
    this.socket = secure
    this.reader = new Reader(secure)
  }

  close(): void {
    this.socket.destroy()
  }
}

// ---------- lockdownd ----------

export interface DeviceInfo {
  readonly udid: string
  readonly name: string
  readonly productType: string
  readonly productVersion: string
}

function lockdownProblem(reply: Record<string, PlistValue>): DeviceError | null {
  const error = reply['Error']
  if (typeof error !== 'string') return null
  if (error === 'PasswordProtected' || error === 'DeviceLocked')
    return new DeviceError('locked', 'Unlock the phone and keep it unlocked while Valet reads it.')
  if (error === 'InvalidHostID' || error === 'PairingDialogResponsePending' || error === 'UserDeniedPairing')
    return new DeviceError('not-paired', 'Unlock the phone and tap Trust for this Mac.')
  return new DeviceError('refused', `The phone said ${error}.`)
}

/** A lockdown session: device facts, and the start of services such as SpringBoard's. */
export class Lockdown {
  private constructor(
    private readonly channel: PlistChannel,
    readonly device: AttachedDevice,
    readonly pair: PairRecord,
    private readonly deps: DeviceDeps,
  ) {}

  static async open(device: AttachedDevice, deps: DeviceDeps = {}): Promise<Lockdown> {
    const pair = await readPairRecord(device.udid, deps)
    const channel = PlistChannel.over(await tunnel(device.deviceId, LOCKDOWN_PORT, deps))
    try {
      const type = await channel.request({ Label: LABEL, Request: 'QueryType' })
      if (type['Type'] !== 'com.apple.mobile.lockdown')
        throw new DeviceError('protocol', 'Not the phone’s lockdown service.')
      const session = await channel.request({
        Label: LABEL,
        Request: 'StartSession',
        HostID: pair.hostId,
        SystemBUID: pair.systemBuid,
      })
      const problem = lockdownProblem(session)
      if (problem !== null) throw problem
      if (session['EnableSessionSSL'] === true) await channel.startTls(pair)
      return new Lockdown(channel, device, pair, deps)
    } catch (error) {
      channel.close()
      throw error
    }
  }

  async value(key?: string, domain?: string): Promise<PlistValue | undefined> {
    const reply = await this.channel.request({
      Label: LABEL,
      Request: 'GetValue',
      ...(key === undefined ? {} : { Key: key }),
      ...(domain === undefined ? {} : { Domain: domain }),
    })
    const problem = lockdownProblem(reply)
    if (problem !== null) throw problem
    return reply['Value']
  }

  async info(): Promise<DeviceInfo> {
    const all = await this.value()
    const dict = isDict(all) ? all : {}
    return {
      udid: this.device.udid,
      name: String(dict['DeviceName'] ?? 'iPhone'),
      productType: String(dict['ProductType'] ?? ''),
      productVersion: String(dict['ProductVersion'] ?? ''),
    }
  }

  async startService(name: string): Promise<PlistChannel> {
    const reply = await this.channel.request({ Label: LABEL, Request: 'StartService', Service: name })
    const problem = lockdownProblem(reply)
    if (problem !== null) throw problem
    const port = reply['Port']
    if (typeof port !== 'number') throw new DeviceError('refused', `The phone wouldn’t start ${name}.`)
    const channel = PlistChannel.over(await tunnel(this.device.deviceId, port, this.deps))
    if (reply['EnableServiceSSL'] === true) await channel.startTls(this.pair)
    return channel
  }

  close(): void {
    try {
      this.channel.send({ Label: LABEL, Request: 'StopSession' })
    } catch {
      // Closing anyway.
    }
    this.channel.close()
  }
}

// ---------- SpringBoard ----------

/** The raw home screen as SpringBoard gives it: an array of lists, the dock first. */
export type RawIconState = readonly PlistValue[]

export class SpringBoard {
  constructor(private readonly channel: PlistChannel) {}

  static async open(lockdown: Lockdown): Promise<SpringBoard> {
    return new SpringBoard(await lockdown.startService(SPRINGBOARD_SERVICE))
  }

  async iconState(): Promise<RawIconState> {
    this.channel.send({ command: 'getIconState', formatVersion: '2' })
    const reply = await this.channel.receive(60_000)
    if (!Array.isArray(reply)) throw new DeviceError('protocol', 'SpringBoard sent an unexpected layout.')
    return reply
  }

  async iconPng(bundleId: string): Promise<Uint8Array | null> {
    this.channel.send({ command: 'getIconPNGData', bundleId })
    const reply = await this.channel.receive()
    const data = isDict(reply) ? reply['pngData'] : undefined
    return data instanceof Uint8Array && data.length > 0 ? data : null
  }

  async wallpaperPng(): Promise<Uint8Array | null> {
    this.channel.send({ command: 'getHomeScreenWallpaperPNGData' })
    const reply = await this.channel.receive()
    const data = isDict(reply) ? reply['pngData'] : undefined
    return data instanceof Uint8Array && data.length > 0 ? data : null
  }

  async iconMetrics(): Promise<Record<string, PlistValue>> {
    this.channel.send({ command: 'getHomeScreenIconMetrics' })
    const reply = await this.channel.receive()
    return isDict(reply) ? reply : {}
  }

  /** Writes a whole layout. SpringBoard answers nothing; read it back to see what it kept. */
  setIconState(state: RawIconState): void {
    this.channel.send({ command: 'setIconState', iconState: state })
  }

  close(): void {
    this.channel.close()
  }
}
