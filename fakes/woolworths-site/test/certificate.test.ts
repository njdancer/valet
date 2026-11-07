import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateTestCertificate, type Spawner, spawnProcess, subjectAltNames } from '../src/certificate'
import { startExfilSink } from '../src/exfil-sink'
import { startFakeWoolworths } from '../src/server'

const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0

let tempRoot = ''
beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'fake-cert-test-'))
})
afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

describe('subjectAltNames', () => {
  it('makes a DNS entry per hostname and an IP entry per IPv4 address', () => {
    expect(subjectAltNames(['www.woolworths.test', 'evil.test', '127.0.0.1'])).toBe(
      'DNS:www.woolworths.test,DNS:evil.test,IP:127.0.0.1',
    )
  })

  it('accepts a single-label host', () => {
    expect(subjectAltNames(['localhost'])).toBe('DNS:localhost')
  })

  it('refuses no hosts', () => {
    expect(() => subjectAltNames([])).toThrow('at least one host is required')
  })

  it('refuses a host that would smuggle another name into the openssl argument', () => {
    expect(() => subjectAltNames(['evil.test,DNS:www.woolworths.com.au'])).toThrow('invalid certificate host')
    expect(() => subjectAltNames(['evil.test/CN=bank'])).toThrow('invalid certificate host')
    expect(() => subjectAltNames(['*.woolworths.test'])).toThrow('invalid certificate host')
    expect(() => subjectAltNames(['evil test'])).toThrow('invalid certificate host')
    expect(() => subjectAltNames(['999.0.0.1'])).toThrow('invalid certificate host')
    expect(() => subjectAltNames(['-leading.test'])).toThrow('invalid certificate host')
  })
})

describe('generateTestCertificate with a fake spawner', () => {
  it('runs openssl req without a shell, with the SANs and paths in its temp dir', async () => {
    const calls: { command: string; args: readonly string[]; cwd: string }[] = []
    const spawn: Spawner = async (command, args, { cwd }) => {
      calls.push({ command, args, cwd })
      return { exitCode: 1 }
    }
    await expect(
      generateTestCertificate(['www.woolworths.test', 'evil.test'], { spawn, tempRoot }),
    ).rejects.toThrow('openssl exited with 1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('openssl')
    expect(calls[0]?.cwd.startsWith(join(tempRoot, 'valet-cert-'))).toBe(true)
    const args = calls[0]?.args ?? []
    expect(args.slice(0, 2)).toEqual(['req', '-x509'])
    expect(args).toContain('-nodes')
    expect(args[args.indexOf('-subj') + 1]).toBe('/CN=www.woolworths.test')
    expect(args).toContain('subjectAltName=DNS:www.woolworths.test,DNS:evil.test')
    expect(args[args.indexOf('-days') + 1]).toBe('30')
    expect(args.slice(-4)).toEqual(['-keyout', 'key.pem', '-out', 'cert.pem'])
  })

  it('passes the validity period through', async () => {
    let days = ''
    const spawn: Spawner = async (_command, args) => {
      days = args[args.indexOf('-days') + 1] ?? ''
      return { exitCode: 1 }
    }
    await expect(generateTestCertificate(['a.test'], { spawn, tempRoot, days: 2 })).rejects.toThrow()
    expect(days).toBe('2')
  })

  it('reports an openssl that cannot be started without leaking the cause', async () => {
    const spawn: Spawner = async () => {
      throw new Error('spawn openssl ENOENT /secret/path')
    }
    await expect(generateTestCertificate(['a.test'], { spawn, tempRoot })).rejects.toThrow(
      /^openssl could not be started$/,
    )
  })

  it('validates hosts before running anything', async () => {
    let ran = false
    const spawn: Spawner = async () => {
      ran = true
      return { exitCode: 0 }
    }
    await expect(generateTestCertificate(['a.test,DNS:b.test'], { spawn, tempRoot })).rejects.toThrow()
    expect(ran).toBe(false)
  })

  it('removes its temp dir whatever happens', async () => {
    const spawn: Spawner = async (_command, _args, { cwd }) => {
      await writeFile(join(cwd, 'key.pem'), 'not a key')
      await writeFile(join(cwd, 'cert.pem'), 'not a cert')
      return { exitCode: 0 }
    }
    await expect(generateTestCertificate(['a.test'], { spawn, tempRoot })).rejects.toThrow()
    expect(await readdir(tempRoot)).toEqual([])
  })
})

describe('spawnProcess', () => {
  it('rejects when the program does not exist', async () => {
    await expect(spawnProcess('definitely-not-a-real-program-xyz', [], { cwd: tempRoot })).rejects.toThrow()
  })

  it.skipIf(!hasOpenssl)('resolves with the exit code', async () => {
    expect(await spawnProcess('openssl', ['version'], { cwd: tempRoot })).toEqual({ exitCode: 0 })
    expect(
      (await spawnProcess('openssl', ['x509', '-in', 'missing.pem'], { cwd: tempRoot })).exitCode,
    ).not.toBe(0)
  })
})

describe.skipIf(!hasOpenssl)('generateTestCertificate with real openssl', () => {
  it('makes a key and a certificate for every host, with fingerprints in both formats', async () => {
    const certificate = await generateTestCertificate(['www.woolworths.test', 'evil.test', '127.0.0.1'], {
      tempRoot,
    })
    expect(certificate.key).toContain('-----BEGIN PRIVATE KEY-----')
    const x509 = new X509Certificate(certificate.cert)
    expect(x509.subjectAltName).toBe('DNS:www.woolworths.test, DNS:evil.test, IP Address:127.0.0.1')
    expect(x509.checkHost('www.woolworths.test')).toBe('www.woolworths.test')
    expect(x509.checkHost('www.woolworths.com.au')).toBeUndefined()
    expect(certificate.fingerprint).toBe(x509.fingerprint256)
    expect(certificate.chromiumFingerprint).toMatch(/^sha256\/[A-Za-z0-9+/]{43}=$/)
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('serves the fake site and the sink over HTTPS, trusted only with the generated certificate', async () => {
    const tls = await generateTestCertificate(['www.woolworths.test', 'evil.test'], { tempRoot })
    const site = await startFakeWoolworths({ tls, hostname: 'www.woolworths.test' })
    const sink = await startExfilSink({ tls, hostname: 'evil.test' })
    try {
      expect(site.origin).toBe(`https://www.woolworths.test:${site.port}`)
      expect(sink.origin).toBe(`https://evil.test:${sink.port}`)

      const get = (port: number, servername: string, ca: string | undefined) =>
        new Promise<{ status: number; setCookie: string[]; body: string }>((resolve, reject) => {
          const req = httpsRequest(
            { host: '127.0.0.1', port, path: '/', servername, ca, headers: { host: servername } },
            (res) => {
              let body = ''
              res.setEncoding('utf8')
              res.on('data', (chunk: string) => {
                body += chunk
              })
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie'] ?? [], body }),
              )
            },
          )
          req.on('error', reject)
          req.end()
        })

      const home = await get(site.port, 'www.woolworths.test', tls.cert)
      expect(home.status).toBe(200)
      // Over HTTPS the session cookie is Secure too.
      expect(home.setCookie[0]).toMatch(/; HttpOnly; Secure$/)
      expect((await get(sink.port, 'evil.test', tls.cert)).status).toBe(200)
      expect(sink.requests[0]?.host).toBe('evil.test')

      // Without the certificate pinned, the connection is refused.
      await expect(get(site.port, 'www.woolworths.test', undefined)).rejects.toThrow()
      // And the certificate is not good for any other name.
      await expect(get(site.port, 'www.woolworths.com.au', tls.cert)).rejects.toThrow()
    } finally {
      await site.close()
      await sink.close()
    }
  })
})
