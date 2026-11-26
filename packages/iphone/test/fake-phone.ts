// A pretend usbmuxd with one pretend iPhone behind it: lockdownd and SpringBoard's service, without
// TLS (the session says it doesn't want it). Enough to run the real client code end to end.

import { mkdtempSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encodeXml, isDict, PlistReal, type PlistValue } from '../src/plist'

export interface FakePhone {
  readonly socketPath: string
  iconState: PlistValue[]
  locked: boolean
  readonly written: PlistValue[][]
  /** Sends an Attached event to every listener. */
  attach(): void
  close(): Promise<void>
}

const UDID = '00008110-000A1B2C3D4E5F60'
const SB_PORT = 49_152

function muxFrame(message: Record<string, PlistValue>, tag: number): Buffer {
  const body = Buffer.from(encodeXml(message))
  const header = Buffer.alloc(16)
  header.writeUInt32LE(16 + body.length, 0)
  header.writeUInt32LE(1, 4)
  header.writeUInt32LE(8, 8)
  header.writeUInt32LE(tag, 12)
  return Buffer.concat([header, body])
}

function frame(message: PlistValue): Buffer {
  const body = Buffer.from(encodeXml(message))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** Calls `on` with each whole 4-byte-framed plist. */
function framed(socket: Socket, on: (value: PlistValue) => void, initial: Buffer = Buffer.alloc(0)): void {
  let buf = initial
  const drain = () => {
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0)
      if (buf.length < 4 + n) return
      const body = buf.subarray(4, 4 + n)
      buf = buf.subarray(4 + n)
      on(decode(body))
    }
  }
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    drain()
  })
  drain()
}

export function startFakePhone(iconState: PlistValue[]): Promise<FakePhone> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-usbmuxd-'))
  const socketPath = join(dir, 'usbmuxd')
  const listeners = new Set<Socket>()
  const phone: FakePhone = {
    socketPath,
    iconState,
    locked: false,
    written: [],
    attach() {
      for (const l of listeners)
        l.write(
          muxFrame(
            {
              MessageType: 'Attached',
              DeviceID: 7,
              Properties: { SerialNumber: UDID, ConnectionType: 'USB' },
            },
            0,
          ),
        )
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const l of listeners) l.destroy()
        server.close(() => resolve())
      }),
  }

  const lockdown = (socket: Socket, rest: Buffer) =>
    framed(
      socket,
      (msg) => {
        if (!isDict(msg)) return
        switch (msg['Request']) {
          case 'QueryType':
            socket.write(frame({ Type: 'com.apple.mobile.lockdown' }))
            return
          case 'StartSession':
            socket.write(
              frame(
                phone.locked ? { Error: 'PasswordProtected' } : { SessionID: 's1', EnableSessionSSL: false },
              ),
            )
            return
          case 'GetValue':
            socket.write(
              frame({
                Value: { DeviceName: 'Test iPhone', ProductType: 'iPhone14,2', ProductVersion: '26.1' },
              }),
            )
            return
          case 'StartService':
            socket.write(frame({ Port: SB_PORT, Service: msg['Service'] as string }))
            return
          default:
            return
        }
      },
      rest,
    )

  const springboard = (socket: Socket, rest: Buffer) =>
    framed(
      socket,
      (msg) => {
        if (!isDict(msg)) return
        switch (msg['command']) {
          case 'getIconState':
            socket.write(frame(phone.iconState))
            return
          case 'setIconState':
            phone.written.push(msg['iconState'] as PlistValue[])
            phone.iconState = msg['iconState'] as PlistValue[]
            return
          case 'getIconPNGData':
            socket.write(frame({ pngData: new Uint8Array(Buffer.from(`png:${String(msg['bundleId'])}`)) }))
            return
          case 'getHomeScreenWallpaperPNGData':
            socket.write(frame({ pngData: new Uint8Array(Buffer.from('wallpaper')) }))
            return
          case 'getHomeScreenIconMetrics':
            socket.write(
              frame({ homeScreenIconColumns: 4, homeScreenIconRows: 6, homeScreenIconDockMaxCount: 4 }),
            )
            return
          default:
            return
        }
      },
      rest,
    )

  const server: Server = createServer((socket) => {
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 16) return
      const n = buf.readUInt32LE(0)
      if (buf.length < n) return
      const tag = buf.readUInt32LE(12)
      const msg = decode(buf.subarray(16, n))
      const rest = buf.subarray(n)
      buf = Buffer.alloc(0)
      if (!isDict(msg)) return
      switch (msg['MessageType']) {
        case 'ListDevices':
          socket.write(
            muxFrame(
              {
                DeviceList: [
                  {
                    DeviceID: 7,
                    MessageType: 'Attached',
                    Properties: { SerialNumber: UDID, ConnectionType: 'USB' },
                  },
                ],
              },
              tag,
            ),
          )
          return
        case 'Listen':
          listeners.add(socket)
          socket.on('close', () => listeners.delete(socket))
          socket.write(muxFrame({ MessageType: 'Result', Number: 0 }, tag))
          return
        case 'ReadPairRecord': {
          const record = encodeXml({
            HostCertificate: new Uint8Array([1]),
            HostPrivateKey: new Uint8Array([2]),
            HostID: 'HOST',
            SystemBUID: 'BUID',
          })
          socket.write(muxFrame({ PairRecordData: new Uint8Array(Buffer.from(record)) }, tag))
          return
        }
        case 'Connect': {
          socket.off('data', onData)
          const port = msg['PortNumber'] as number
          const host = ((port & 0xff) << 8) | (port >> 8)
          socket.write(muxFrame({ MessageType: 'Result', Number: 0 }, tag))
          if (host === 62078) lockdown(socket, rest)
          else if (host === SB_PORT) springboard(socket, rest)
          return
        }
        default:
          return
      }
    }
    socket.on('data', onData)
  })
  return new Promise((resolve) => server.listen(socketPath, () => resolve(phone)))
}

export const FAKE_UDID = UDID

const app = (id: string, name: string) => ({ bundleIdentifier: id, displayIdentifier: id, displayName: name })

/** A small home screen: a dock, a page with a widget, an app and a folder, and a second page. */
export function sampleState(): PlistValue[] {
  return [
    [app('com.apple.mobilephone', 'Phone'), app('com.apple.mobilesafari', 'Safari')],
    [
      {
        iconType: 'custom',
        gridSize: 'medium',
        displayIdentifier: 'W-1',
        elements: [{ containerBundleIdentifier: 'com.apple.weather', kind: 'Forecast' }],
        opaqueSetting: new PlistReal(1.5),
      },
      app('com.apple.mobilemail', 'Mail'),
      {
        displayName: 'Social',
        listType: 'folder',
        iconLists: [[app('com.apple.MobileSMS', 'Messages'), app('com.x.app', 'X')]],
      },
    ],
    [app('com.apple.Maps', 'Maps'), app('com.apple.camera', 'Camera')],
  ]
}
