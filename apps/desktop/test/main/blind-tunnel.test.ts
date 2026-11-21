// @vitest-environment node
// The Mac's side of the blind relay on its own: where its certificate is kept, which relay a
// development build was started with, and that the tunnel tells the listener its name and stops
// cleanly. The whole path (relay, CA, OAuth, a tool call) is in e2e/blind-relay.spec.ts.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredCertificate } from '@valet/acme'
import { MemoryKeychain } from '@valet/credentials'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BlindTunnel,
  blindRelayFromEnv,
  blindRelaySetup,
  fileCertificateStore,
  keychainCertificateStore,
  VALET_RELAY,
} from '../../src/main/core/blind-tunnel'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const stored: StoredCertificate = {
  name: 'abc.valet.test',
  directoryUrl: 'https://acme.test/directory',
  accountKeyPem: 'account key',
  accountUrl: 'https://acme.test/acct/1',
  certificateKeyPem: 'certificate key',
  certificatePem: 'certificate',
}

describe('blindRelayFromEnv', () => {
  it('needs both names, and both must be host names', () => {
    expect(blindRelayFromEnv({})).toBeNull()
    expect(blindRelayFromEnv({ VALET_BLIND_RELAY: 'relay.valet.test' })).toBeNull()
    expect(
      blindRelayFromEnv({ VALET_BLIND_RELAY: 'relay valet', VALET_BLIND_MAC_DOMAIN: 'valet.test' }),
    ).toBeNull()
    expect(
      blindRelayFromEnv({ VALET_BLIND_RELAY: 'relay.valet.test', VALET_BLIND_MAC_DOMAIN: 'https://x' }),
    ).toBeNull()
    expect(
      blindRelayFromEnv({ VALET_BLIND_RELAY: 'relay.valet.test', VALET_BLIND_MAC_DOMAIN: 'valet.test' }),
    ).toEqual({
      controlHost: 'relay.valet.test',
      macDomain: 'valet.test',
    })
  })

  it('takes a local relay and CA only in their own shapes', () => {
    const base = { VALET_BLIND_RELAY: 'relay.valet.test', VALET_BLIND_MAC_DOMAIN: 'valet.test' }
    expect(
      blindRelayFromEnv({
        ...base,
        VALET_BLIND_RELAY_CONNECT: 'wss://127.0.0.1:8443',
        VALET_ACME_DIRECTORY: 'http://127.0.0.1:14000/dir',
      }),
    ).toEqual({
      controlHost: 'relay.valet.test',
      macDomain: 'valet.test',
      connectUrl: 'wss://127.0.0.1:8443',
      acmeDirectory: 'http://127.0.0.1:14000/dir',
    })
    expect(
      blindRelayFromEnv({
        ...base,
        VALET_BLIND_RELAY_CONNECT: 'wss://evil/path',
        VALET_ACME_DIRECTORY: 'ftp://x',
      }),
    ).toEqual({ controlHost: 'relay.valet.test', macDomain: 'valet.test' })
  })
})

describe('blindRelaySetup', () => {
  const local = { VALET_BLIND_RELAY: 'relay.valet.test', VALET_BLIND_MAC_DOMAIN: 'valet.test' }
  it('a release uses Valet’s relay whatever the environment says', () => {
    expect(VALET_RELAY).toEqual({ controlHost: 'relay.valet.dncr.me', macDomain: 'valet.dncr.me' })
    expect(blindRelaySetup({}, { release: true, test: false })).toBe(VALET_RELAY)
    expect(blindRelaySetup({ ...local }, { release: true, test: false })).toBe(VALET_RELAY)
    expect(blindRelaySetup({ VALET_BLIND_RELAY: 'off' }, { release: true, test: false })).toBe(VALET_RELAY)
  })

  it('a development build uses Valet’s relay unless it names another or says off', () => {
    expect(blindRelaySetup({}, { release: false, test: false })).toBe(VALET_RELAY)
    expect(blindRelaySetup(local, { release: false, test: false })).toEqual({
      controlHost: 'relay.valet.test',
      macDomain: 'valet.test',
    })
    expect(blindRelaySetup({ VALET_BLIND_RELAY: 'off' }, { release: false, test: false })).toBeNull()
  })

  it('demo and e2e runs never reach the real relay unless told to', () => {
    expect(blindRelaySetup({}, { release: false, test: true })).toBeNull()
    expect(blindRelaySetup(local, { release: false, test: true })).toEqual({
      controlHost: 'relay.valet.test',
      macDomain: 'valet.test',
    })
  })
})

describe('certificate stores', () => {
  it('keeps the certificate in Valet’s own Keychain item, and nothing there reads as nothing', async () => {
    const keychain = new MemoryKeychain()
    const store = keychainCertificateStore(keychain, 'valet.test')
    expect(await store.load()).toBeNull()
    await store.save(stored)
    expect(await store.load()).toEqual(stored)
    expect(await keychain.info('valet.relay-certificate', 'valet.test')).toMatch(
      /certificate for remote access/,
    )
    await keychain.write('valet.relay-certificate', 'valet.test', Buffer.from('not json'), 'x')
    expect(await store.load()).toBeNull()
  })

  it('keeps it in a file only this user can read, without the helper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'valet-cert-'))
    dirs.push(dir)
    const path = join(dir, 'relay-certificate.json')
    const store = fileCertificateStore(path)
    expect(await store.load()).toBeNull()
    await store.save(stored)
    expect(await store.load()).toEqual(stored)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('BlindTunnel', () => {
  it('names the Mac’s address as not ready until there is a certificate, and stops cleanly', async () => {
    const hosts: Array<[string | null, boolean]> = []
    let changes = 0
    const tunnel = new BlindTunnel({
      // Nothing listens here: the tunnel stays connecting and the certificate waits for it.
      setup: { controlHost: 'relay.valet.test', macDomain: 'valet.test', connectUrl: 'wss://127.0.0.1:1' },
      store: { load: async () => null, save: async () => {} },
      accept: () => null,
      setHost: (host, ready) => hosts.push([host, ready]),
      changed: () => {
        changes++
      },
    })
    expect(tunnel.view).toBeNull()
    tunnel.start('abc', { publicKey: 'key', sign: async () => 'sig' }, { approvalKey: 'k', signature: 's' })
    const view = tunnel.view
    expect(view?.host).toBe('abc.valet.test')
    expect(view?.retryAt).toBeNull()
    expect(view?.relay).not.toBe('online')
    expect(hosts[0]).toEqual(['abc.valet.test', false])
    tunnel.stop()
    expect(tunnel.view).toBeNull()
    expect(hosts.at(-1)).toEqual([null, false])
    expect(changes).toBeGreaterThan(0)
    // Stopping again does nothing more.
    const count = hosts.length
    tunnel.stop()
    expect(hosts).toHaveLength(count)
  })
})
