// @vitest-environment node
// Where each kind of build gets the Mac's approval keys and the ledger's anchor: a packaged app
// never signs in software, and a dev build's software keys survive a restart.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAnchor, macApprovalKeys, softwareKeysAt } from '../../src/main/core/approvals'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'valet-keys-'))
  dirs.push(d)
  return d
}

const base = (d: string) => ({
  approverPath: null,
  keychain: null,
  anchorService: 'valet-dev.anchor',
  devKeysPath: join(d, 'data', 'keys.json'),
  devAnchorPath: join(d, 'anchor.json'),
  devPresent: () => true,
})

describe('macApprovalKeys', () => {
  it('never signs in software in a packaged app: without the helper, nothing can sign', async () => {
    const d = dir()
    const keys = await macApprovalKeys({ ...base(d), packaged: true })
    expect(keys.kind).toBe('secure-enclave')
    await expect(keys.signer.keys()).rejects.toThrow()
    // And with no Keychain, the anchor can't be read: the ledger opens locked down.
    await expect(keys.anchor.read('trusted')).rejects.toThrow()
  })

  it('keeps a dev build’s software keys across launches, in a file only the owner reads', async () => {
    const d = dir()
    const first = await macApprovalKeys({ ...base(d), packaged: false })
    const second = await macApprovalKeys({ ...base(d), packaged: false })
    expect(first.kind).toBe('software')
    expect((await first.signer.keys()).approvalKey).toBe((await second.signer.keys()).approvalKey)
    expect(statSync(join(d, 'data', 'keys.json')).mode & 0o777).toBe(0o600)
  })

  it('falls back to software keys in a dev build whose helper can’t reach the Secure Enclave', async () => {
    const d = dir()
    const lines: string[] = []
    const keys = await macApprovalKeys({
      ...base(d),
      packaged: false,
      approverPath: join(d, 'no-such-helper'),
      log: (line) => lines.push(line),
    })
    expect(keys.kind).toBe('software')
    expect(lines.join('\n')).toContain('signing in software')
  })

  it('asks the dev build’s stand-in for Touch ID before each signature', async () => {
    const d = dir()
    const asked: string[] = []
    const keys = await macApprovalKeys({
      ...base(d),
      packaged: false,
      devPresent: (reason) => {
        asked.push(reason)
        return false
      },
    })
    const signed = await (
      keys.signer as unknown as {
        sign(domain: string, payload: string, reason: string): Promise<string | null>
      }
    ).sign('valet/approval-decision/v1', '{}', 'resume Valet (request 0000)')
    expect(signed).toBeNull()
    expect(asked).toEqual(['resume Valet (request 0000)'])
  })
})

describe('FileAnchor and softwareKeysAt', () => {
  it('stores anchors by name, and forgets them all', async () => {
    const d = dir()
    const anchor = new FileAnchor(join(d, 'anchor.json'))
    expect(await anchor.read('trusted')).toBeNull()
    const state = { generation: 1, sha256: 'a'.repeat(64), next: null }
    await anchor.write('trusted', state)
    expect(await anchor.read('trusted')).toEqual(state)
    expect(await anchor.read('other')).toBeNull()
    await anchor.forget()
    expect(await anchor.read('trusted')).toBeNull()
  })

  it('refuses a damaged key file rather than make a new identity over it', async () => {
    const d = dir()
    const path = join(d, 'keys.json')
    await softwareKeysAt(path)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, '{"approval":"x"}')
    await expect(softwareKeysAt(path)).rejects.toThrow()
  })
})
