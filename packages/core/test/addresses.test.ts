import { BlockList, isIP } from 'node:net'
import { describe, expect, test } from 'vitest'
import {
  canonicalAddress,
  hostPort,
  ipFamily,
  isPrivateHostAddress,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
} from '../src/addresses'

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('parsing', () => {
  const samples = [
    '::',
    '::1',
    '1::',
    '::ffff:1.2.3.4',
    '::1.2.3.4',
    '1:2:3:4:5:6:1.2.3.4',
    '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7:8:',
    ':1',
    '1:::2',
    '[::1]',
    '2001:db8::1',
    'a::b::c',
    '1:2:3:4:5:6:7::',
    '::2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:1.2.3.4',
    '1.2.3.04',
    '01.2.3.4',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '0x7f.0.0.1',
    '2130706433',
    '1.2.3.4',
    '00000::1',
    '12345::1',
    'g::1',
    '',
    ' 1.2.3.4',
    'localhost',
  ]
  test.each(samples)('agrees with Node on %j', (sample) => {
    expect(ipFamily(sample)).toBe(isIP(sample))
  })

  test('agrees with Node on random IPv6 texts', () => {
    const next = rng(7)
    const alphabet = '0123456789abcdef:.'
    for (let i = 0; i < 20_000; i++) {
      const length = 1 + Math.floor(next() * 20)
      let text = ''
      for (let j = 0; j < length; j++) text += alphabet[Math.floor(next() * alphabet.length)]
      expect([text, ipFamily(text)]).toEqual([text, isIP(text)])
    }
  })

  test('refuses zone ids, which Node accepts', () => {
    expect(isIP('fe80::1%en0')).toBe(6)
    expect(ipFamily('fe80::1%en0')).toBe(0)
  })

  test('IPv4 bytes', () => {
    expect(parseIPv4('192.168.1.20')).toEqual([192, 168, 1, 20])
    expect(parseIPv6('::ffff:1.2.3.4')?.slice(10)).toEqual([255, 255, 1, 2, 3, 4])
  })
})

describe('canonicalAddress', () => {
  test.each([
    ['2001:0db8:0:0:0:0:0:1', '2001:db8::1'],
    ['fd00:0:0:1:0:0:0:1', 'fd00:0:0:1::1'],
    ['FD00::ABCD', 'fd00::abcd'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['1:0:2:3:4:5:6:7', '1:0:2:3:4:5:6:7'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['10.0.0.1', '10.0.0.1'],
  ])('%s is written %s', (input, canonical) => {
    expect(canonicalAddress(input)).toBe(canonical)
  })

  test('is null for a name', () => {
    expect(canonicalAddress('example.com')).toBeNull()
  })
})

// The broker used Node's BlockList for this rule; the pure version must agree with it everywhere.
const NODE_NOT_PUBLIC = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NODE_NOT_PUBLIC.addSubnet(net, bits, 'ipv4')

describe('isPublicAddress', () => {
  test.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2606:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['169.254.169.254', false],
    ['100.100.100.100', false],
    ['::1', false],
    ['::', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:8.8.8.8', true],
    ['::127.0.0.1', false],
    ['64:ff9b::7f00:1', false],
    ['2002:7f00:1::', false],
    ['ff02::1', false],
    ['example.com', false],
    ['', false],
  ])('%s is public: %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected)
  })

  test('agrees with the BlockList rule on random IPv4 addresses', () => {
    const next = rng(42)
    for (let i = 0; i < 50_000; i++) {
      const address = [0, 0, 0, 0].map(() => Math.floor(next() * 256)).join('.')
      expect([address, isPublicAddress(address)]).toEqual([address, !NODE_NOT_PUBLIC.check(address, 'ipv4')])
    }
  })
})

describe('isPrivateHostAddress', () => {
  test.each([
    ['192.168.1.20', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['fd12:3456::1', true],
    ['fc00::1', true],
    ['FD12::1', false],
    ['fd12:0::1', false],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['169.254.169.254', false],
    ['fe80::1', false],
    ['::1', false],
    ['::ffff:192.168.1.1', false],
    ['8.8.8.8', false],
    ['224.0.0.1', false],
    ['nas.local', false],
  ])('%s may be a private host: %s', (address, expected) => {
    expect(isPrivateHostAddress(address)).toBe(expected)
  })
})

test('hostPort brackets IPv6', () => {
  expect(hostPort('192.168.1.20', 8123)).toBe('192.168.1.20:8123')
  expect(hostPort('fd00::1', 443)).toBe('[fd00::1]:443')
})
