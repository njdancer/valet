// Red-team probes against the network address gate and local.service.

import { describe, expect, it } from 'vitest'
import { isPublicAddress, localService } from '../../src/local/net'

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'allowed',
    (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
  )

describe('probe: isPublicAddress on tricky forms', () => {
  it('reports which forms are (mis)classified as public', () => {
    const cases = [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:127.0.0.1', // expanded IPv4-mapped loopback
      '0:0:0:0:0:ffff:7f00:0001', // expanded, hex form
      '::ffff:169.254.169.254', // cloud metadata, mapped
      '0:0:0:0:0:ffff:a9fe:a9fe', // expanded 169.254.169.254
      '64:ff9b::127.0.0.1', // NAT64 of loopback
      '::', // unspecified
    ]
    const result = Object.fromEntries(cases.map((a) => [a, isPublicAddress(a)]))
    // Record them all; any `true` for a non-public form is a gate gap.
    // These MUST be false (not public):
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::'])
      expect([a, result[a]]).toEqual([a, false])
    // Print the rest for the report.
    // eslint-disable-next-line no-console
    console.log('isPublicAddress:', JSON.stringify(result))
  })
})

describe('probe: local.service port gate', () => {
  it('cannot reach an undeclared port or a refused (own) port', async () => {
    const s = localService({ ports: [11434], refusedPorts: () => [11434] })
    expect(await refusal(s(11434, '/'))).toBe('tool-run/host-not-allowed') // own port
    expect(await refusal(s(9999, '/'))).toBe('tool-run/not-granted') // undeclared
    const open = localService({ ports: 'open', refusedPorts: () => [8080] })
    expect(await refusal(open(8080, '/'))).toBe('tool-run/host-not-allowed')
    expect(await refusal(open(80, '/'))).toBe('tool-run/invalid') // below 1024
  })
})
