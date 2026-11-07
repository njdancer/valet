// Self-signed certificates for HTTPS fakes, made with the openssl CLI. The manifest schema only
// accepts https origins, so end-to-end tests serve the fake site (and the exfil sink) over TLS
// under names like www.woolworths.test, and pin the certificate in the browser driver.

import { spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SpawnResult {
  readonly exitCode: number
}

/** Runs a program without a shell. Rejects only when it can't be started at all. */
export type Spawner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<SpawnResult>

export const spawnProcess: Spawner = (command, args, { cwd }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => resolve({ exitCode: code ?? -1 }))
  })

export interface CertificateOptions {
  readonly spawn?: Spawner
  /** Where the temporary working directory is made. Defaults to the OS temp dir. */
  readonly tempRoot?: string
  readonly days?: number
}

export interface TestCertificate {
  /** PEM private key. */
  readonly key: string
  /** PEM certificate. */
  readonly cert: string
  /** SHA-256 of the DER certificate, as colon-separated hex (Node's `fingerprint256`). */
  readonly fingerprint: string
  /** The same digest as Chromium and Electron print it: `sha256/<base64>`. */
  readonly chromiumFingerprint: string
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * One subjectAltName entry per host. Hosts are checked strictly because they are spliced into an
 * openssl argument, where a comma would smuggle in an extra name.
 */
export function subjectAltNames(hosts: readonly string[]): string {
  if (hosts.length === 0) throw new Error('at least one host is required')
  return hosts
    .map((host) => {
      if (IPV4.test(host)) return `IP:${host}`
      // All-numeric names that aren't valid IPv4 are typos, not hostnames.
      if (HOSTNAME.test(host) && !/^[\d.]+$/.test(host)) return `DNS:${host}`
      throw new Error('invalid certificate host')
    })
    .join(',')
}

export async function generateTestCertificate(
  hosts: readonly string[],
  options: CertificateOptions = {},
): Promise<TestCertificate> {
  const sans = subjectAltNames(hosts)
  const run = options.spawn ?? spawnProcess
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'valet-cert-'))
  try {
    const args = [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      String(options.days ?? 30),
      '-subj',
      `/CN=${hosts[0]}`,
      '-addext',
      `subjectAltName=${sans}`,
      '-addext',
      'extendedKeyUsage=serverAuth',
      '-keyout',
      'key.pem',
      '-out',
      'cert.pem',
    ]
    let result: SpawnResult
    try {
      result = await run('openssl', args, { cwd: dir })
    } catch {
      throw new Error('openssl could not be started')
    }
    if (result.exitCode !== 0) throw new Error(`openssl exited with ${result.exitCode}`)
    const key = await readFile(join(dir, 'key.pem'), 'utf8')
    const cert = await readFile(join(dir, 'cert.pem'), 'utf8')
    const x509 = new X509Certificate(cert)
    return {
      key,
      cert,
      fingerprint: x509.fingerprint256,
      chromiumFingerprint: `sha256/${createHash('sha256').update(x509.raw).digest('base64')}`,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
