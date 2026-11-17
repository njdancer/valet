// Red team (2026-11-17) against smtp/client.ts with a hostile server on loopback: a STARTTLS
// injection that an earlier version believed.

import { type AddressInfo, createServer, type Server, Socket } from 'node:net'
import { TLSSocket, connect as tlsConnect } from 'node:tls'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SmtpClient } from '../src/smtp/client'

let cert: { key: string; cert: string }
beforeAll(async () => {
  cert = await generateTestCertificate(['smtp.mail.me.com'])
}, 30_000)

const servers: Server[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const k of sockets.splice(0)) k.destroy()
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)))
})

/**
 * Plain greeting and EHLO, then at STARTTLS: "220 Go ahead" plus `injected` in the same write, in
 * the clear, then real TLS. Over TLS: EHLO answered with `ehloOverTls`, MAIL FROM, RCPT, DATA ok.
 */
async function server(injected: string, ehloOverTls: string) {
  const seenOverTls: string[] = []
  const srv = createServer((socket: Socket) => {
    sockets.push(socket)
    socket.write('220 smtp.mail.me.com ESMTP\r\n')
    const onPlain = (chunk: Buffer) => {
      const text = chunk.toString('latin1')
      if (/^EHLO/i.test(text)) socket.write('250-smtp.mail.me.com\r\n250 STARTTLS\r\n')
      else if (/^STARTTLS/i.test(text)) {
        socket.off('data', onPlain)
        socket.write(`220 Go ahead\r\n${injected}`)
        const tls = new TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert })
        let inData = false
        let authStep = 0
        tls.on('data', (c: Buffer) => {
          for (const line of c
            .toString('latin1')
            .split('\r\n')
            .filter((l) => l !== '')) {
            seenOverTls.push(line)
            if (inData) {
              if (line === '.') {
                inData = false
                tls.write('250 queued\r\n')
              }
              continue
            }
            if (/^EHLO/i.test(line)) tls.write(ehloOverTls)
            else if (/^AUTH LOGIN/i.test(line)) {
              authStep = 1
              tls.write('334 VXNlcm5hbWU6\r\n')
            } else if (/^AUTH/i.test(line)) tls.write('235 ok\r\n')
            else if (authStep === 1) {
              authStep = 2
              tls.write('334 UGFzc3dvcmQ6\r\n')
            } else if (authStep === 2) {
              authStep = 0
              tls.write('235 ok\r\n')
            } else if (/^(MAIL|RCPT|RSET)/i.test(line)) tls.write('250 ok\r\n')
            else if (/^DATA/i.test(line)) {
              inData = true
              tls.write('354 go\r\n')
            } else if (/^QUIT/i.test(line)) tls.end('221 bye\r\n')
          }
        })
      }
    }
    socket.on('data', onPlain)
  })
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return { port: (srv.address() as AddressInfo).port, seenOverTls }
}

async function open(port: number) {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = new Socket()
    s.connect(port, '127.0.0.1', () => resolve(s))
    s.once('error', reject)
  })
  return SmtpClient.open(socket, {
    secure: false,
    commandTimeoutMs: 3000,
    upgrade: (plain) =>
      new Promise((resolve, reject) => {
        const tls = tlsConnect({ socket: plain as Socket, servername: 'smtp.mail.me.com', ca: cert.cert })
        tls.once('secureConnect', () => resolve(tls))
        tls.once('error', reject)
      }),
  })
}

describe('STARTTLS injection via an unfinished multi-line reply', () => {
  it('refuses continuation lines injected in the clear after the STARTTLS reply', async () => {
    // Complete continuation lines would sit unfinished, then join the first EHLO reply over TLS.
    const s = await server(
      '250-injected\r\n250-SIZE 1\r\n250-AUTH LOGIN\r\n',
      '250-smtp.mail.me.com\r\n250 8BITMIME\r\n',
    )
    await expect(open(s.port)).rejects.toMatchObject({ failure: 'malformed' })
    expect(s.seenOverTls).toEqual([])
  })

  it('control: a complete injected reply is refused', async () => {
    const s = await server('250 AUTH PLAIN\r\n', '250-smtp.mail.me.com\r\n250 AUTH PLAIN\r\n')
    await expect(open(s.port)).rejects.toMatchObject({ failure: 'malformed' })
  })
})
