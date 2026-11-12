import { describe, expect, it } from 'vitest'
import {
  beginWrite,
  channelMessageSchema,
  checkAnchor,
  commitWrite,
  DEFAULT_SANDBOX,
  envelopeSchema,
  exceptionRisk,
  isPathPattern,
  macToRelaySchema,
  manifestSchema,
  RELAY_FORWARDED_PATHS,
  relayToMacSchema,
  type SandboxDeclaration,
  type SandboxException,
  sandboxDeclarationSchema,
  sandboxRisk,
  sandboxWidening,
  touchesForbiddenPath,
} from '../src'

describe('store anchors', () => {
  it('starts fresh, then moves through a two-phase write', () => {
    expect(checkAnchor(null, null)).toBe('fresh')
    const begun = beginWrite(null, 'one')
    expect(checkAnchor(null, begun)).toBe('fresh')
    expect(checkAnchor('one', begun)).toBe('advance')
    const committed = commitWrite(begun)
    expect(committed.generation).toBe(1)
    expect(checkAnchor('one', committed)).toBe('ok')
  })

  it('recovers from a crash on either side of the file write', () => {
    const one = commitWrite(beginWrite(null, 'one'))
    const begun = beginWrite(one, 'two')
    expect(checkAnchor('one', begun)).toBe('ok')
    expect(checkAnchor('two', begun)).toBe('advance')
  })

  it('refuses a rolled-back, edited or deleted file', () => {
    const one = commitWrite(beginWrite(null, 'one'))
    const two = commitWrite(beginWrite(one, 'two'))
    expect(checkAnchor('one', two)).toBe('mismatch')
    expect(checkAnchor('two!', two)).toBe('mismatch')
    expect(checkAnchor(null, two)).toBe('mismatch')
    expect(checkAnchor('two', null)).toBe('mismatch')
  })
})

describe('sandbox declarations', () => {
  it('accepts narrow paths and refuses the disk, the home folder and escapes', () => {
    expect(isPathPattern('~/Documents/Receipts/*')).toBe(true)
    expect(isPathPattern('~/Documents/Receipts/**')).toBe(true)
    expect(isPathPattern('/Volumes/Data/exports/report.csv')).toBe(true)
    for (const bad of [
      '~/*',
      '/**',
      '~',
      '/',
      'Documents/x',
      '~/a/../b',
      '~/a//b',
      '~/a/*/b',
      '~/a\\b',
      '~/a/b*',
    ]) {
      expect(isPathPattern(bad), bad).toBe(false)
    }
  })

  it('never reaches Valet, the Keychain, Messages or credential stores, even by an ancestor', () => {
    expect(touchesForbiddenPath('~/Library/Keychains/login.keychain-db')).toBe(true)
    expect(touchesForbiddenPath('~/library/messages/chat.db')).toBe(true)
    expect(touchesForbiddenPath('~/Library/**')).toBe(true)
    expect(touchesForbiddenPath('~/.ssh/*')).toBe(true)
    expect(touchesForbiddenPath('~/Documents/**')).toBe(false)
    const parsed = sandboxDeclarationSchema.safeParse({
      mode: 'sandboxed',
      exceptions: [{ kind: 'files', access: 'read', paths: ['~/Library/*'], purpose: 'x' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rates exceptions and finds what an update adds', () => {
    const read: SandboxException = {
      kind: 'files',
      access: 'read',
      paths: ['~/Documents/Receipts/*'],
      purpose: 'Receipts',
    }
    const write: SandboxException = { ...read, access: 'read-write' }
    expect(exceptionRisk(read)).toBe('medium')
    expect(exceptionRisk(write)).toBe('high')
    expect(sandboxRisk({ mode: 'unsandboxed', reason: 'Needs a native library' })).toBe('critical')
    expect(sandboxRisk(DEFAULT_SANDBOX)).toBe('low')
    const before: SandboxDeclaration = { mode: 'sandboxed', exceptions: [read] }
    const after: SandboxDeclaration = { mode: 'sandboxed', exceptions: [read, write] }
    expect(sandboxWidening(before, after).added).toEqual([write])
    expect(sandboxWidening(before, before).added).toEqual([])
    expect(sandboxWidening(before, { mode: 'unsandboxed', reason: 'x' }).becameUnsandboxed).toBe(true)
  })

  it('is optional in the manifest and leaves manifests without it unchanged', () => {
    const base = {
      schemaVersion: 1,
      id: 'example',
      name: 'Example',
      version: '1.0.0',
      description: 'An example.',
      home: 'https://www.example.com/',
      navigation: ['https://www.example.com'],
      egress: ['www.example.com'],
      tools: [{ name: 'read_page', title: 'Read page', description: 'Reads a page.', sideEffect: 'read' }],
    }
    const without = manifestSchema.safeParse(base)
    if (!without.success) throw new Error(JSON.stringify(without.error.issues))
    expect('sandbox' in without.data).toBe(false)
    const withIt = manifestSchema.parse({ ...base, sandbox: { mode: 'sandboxed', exceptions: [] } })
    expect(withIt.sandbox).toEqual({ mode: 'sandboxed', exceptions: [] })
  })
})

describe('relay frames', () => {
  it('forwards only allowed paths and headers', () => {
    const request = {
      type: 'http-request',
      id: 'r1',
      method: 'POST',
      path: '/mcp',
      query: '',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      body: '{}',
      source: '203.0.113.1',
    }
    expect(relayToMacSchema.safeParse(request).success).toBe(true)
    expect(relayToMacSchema.safeParse({ ...request, path: '/admin' }).success).toBe(false)
    expect(relayToMacSchema.safeParse({ ...request, headers: { cookie: 'a=b' } }).success).toBe(false)
    expect(RELAY_FORWARDED_PATHS).not.toContain('/authorize')
  })

  it('never lets a Mac send HTML or arbitrary headers back', () => {
    expect(
      macToRelaySchema.safeParse({
        type: 'http-response-start',
        id: 'r1',
        status: 200,
        headers: { 'set-cookie': 'a' },
      }).success,
    ).toBe(false)
    expect(
      macToRelaySchema.safeParse({ type: 'consent-view', id: 'r1', state: 'waiting', html: '<p>' }).success,
    ).toBe(false)
  })

  it('carries sealed envelopes it can route but not read', () => {
    const envelope = {
      v: 1,
      suite: 'hpke-auth-p256-sha256-aes256gcm',
      from: 'a'.repeat(32),
      to: 'b'.repeat(32),
      enc: 'A'.repeat(87),
      ct: 'ciphertext',
    }
    expect(envelopeSchema.safeParse(envelope).success).toBe(true)
    expect(envelopeSchema.safeParse({ ...envelope, plaintext: 'hi' }).success).toBe(false)
  })
})

describe('channel messages', () => {
  it('lets a phone send tightening commands and nothing that loosens', () => {
    expect(
      channelMessageSchema.safeParse({ type: 'command', seq: 1, command: { kind: 'lockdown' } }).success,
    ).toBe(true)
    expect(
      channelMessageSchema.safeParse({ type: 'command', seq: 1, command: { kind: 'resume' } }).success,
    ).toBe(false)
  })
})
