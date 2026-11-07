import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalStore } from '../src/approvals'
import { MemoryAudit } from './fakes'

let dir: string
let path: string
let audit: MemoryAudit
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-approvals-'))
  path = join(dir, 'approvals.json')
  audit = new MemoryAudit()
})

afterEach(async () => {
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

describe('ApprovalStore', () => {
  it('approves nothing before the file exists', async () => {
    const store = new ApprovalStore(path, audit)
    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    expect(await store.approvedHashes('woolworths')).toEqual([])
  })

  it('approves exactly the hash that was approved', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')

    expect(await store.isApproved('woolworths', hashA)).toBe(true)
    expect(await store.isApproved('woolworths', hashB)).toBe(false)
    expect(await store.isApproved('coles', hashA)).toBe(false)
  })

  it('audits a first approval with no previous hash', async () => {
    await new ApprovalStore(path, audit).approve('woolworths', hashA, '1.0.0')

    expect(audit.events).toEqual([
      {
        type: 'adapter-approved',
        adapterId: 'woolworths',
        adapterHash: hashA,
        version: '1.0.0',
        previousHash: null,
      },
    ])
  })

  it('replaces the previous approval and audits the hash it replaced', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    await store.approve('woolworths', hashB, '1.1.0')

    expect(await store.approvedHashes('woolworths')).toEqual([hashB])
    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    expect(audit.events.at(-1)).toEqual({
      type: 'adapter-approved',
      adapterId: 'woolworths',
      adapterHash: hashB,
      version: '1.1.0',
      previousHash: hashA,
    })
  })

  it('does nothing, and audits nothing, when the same hash is approved again', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    await store.approve('woolworths', hashA, '1.0.0')

    expect(audit.events).toHaveLength(1)
  })

  it('does not approve when the approval cannot be audited', async () => {
    const store = new ApprovalStore(path, audit)
    audit.failNext = 'adapter-approved'

    await expect(store.approve('woolworths', hashA, '1.0.0')).rejects.toThrow()
    expect(await store.isApproved('woolworths', hashA)).toBe(false)
  })

  it('persists approvals across instances', async () => {
    await new ApprovalStore(path, audit).approve('woolworths', hashA, '1.0.0')
    expect(await new ApprovalStore(path, audit).isApproved('woolworths', hashA)).toBe(true)
  })

  it('does not approve a prefix or case variant of an approved hash', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')

    expect(await store.isApproved('woolworths', hashA.slice(0, 63))).toBe(false)
    expect(await store.isApproved('woolworths', hashA.toUpperCase())).toBe(false)
  })

  it('takes the last of several hashes in an older file as the one replaced', async () => {
    await writeFile(path, JSON.stringify({ version: 1, approved: { woolworths: [hashA, hashB] } }))
    await new ApprovalStore(path, audit).approve('woolworths', hashA, '1.0.0')

    expect(audit.events[0]).toMatchObject({ adapterHash: hashA, previousHash: hashB })
  })

  it('rejects a hash: withdraws its approval and audits the rejection', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    await store.reject('woolworths', hashA, '1.0.0')

    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, approved: {} })
    expect(audit.events.at(-1)).toEqual({
      type: 'adapter-rejected',
      adapterId: 'woolworths',
      adapterHash: hashA,
      version: '1.0.0',
    })
  })

  it('rejecting an update leaves the installed version approved', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    await store.reject('woolworths', hashB, '1.1.0')

    expect(await store.approvedHashes('woolworths')).toEqual([hashA])
    expect(audit.types()).toEqual(['adapter-approved', 'adapter-rejected'])
  })

  it('rejects without creating a file when nothing was approved', async () => {
    await new ApprovalStore(path, audit).reject('woolworths', hashA, '1.0.0')
    expect(await readdir(dir)).toEqual([])
    expect(audit.types()).toEqual(['adapter-rejected'])
  })

  it('keeps an approval whose rejection cannot be audited', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    audit.failNext = 'adapter-rejected'

    await expect(store.reject('woolworths', hashA, '1.0.0')).rejects.toThrow()
    expect(await store.isApproved('woolworths', hashA)).toBe(true)
  })

  it('serialises concurrent approvals so none is lost', async () => {
    const store = new ApprovalStore(path, audit)
    await Promise.all([
      store.approve('woolworths', hashA, '1.0.0'),
      store.approve('coles', hashA, '1.0.0'),
      store.approve('woolworths', hashB, '1.1.0'),
    ])

    expect(await store.approvedHashes('woolworths')).toEqual([hashB])
    expect(await store.approvedHashes('coles')).toEqual([hashA])
    expect(audit.events.map((e) => 'previousHash' in e && e.previousHash)).toEqual([null, null, hashA])
  })

  it('leaves no temporary files behind', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    expect(await readdir(dir)).toEqual(['approvals.json'])
  })

  it('rejects ids, hashes and versions that could escape a map key, a path or the log', async () => {
    const store = new ApprovalStore(path, audit)
    for (const [id, hash, version] of [
      ['__proto__', hashA, '1.0.0'],
      ['../evil', hashA, '1.0.0'],
      ['woolworths', 'not-a-hash', '1.0.0'],
      ['woolworths', hashA, '1.0'],
      ['woolworths', hashA, '1.0.0\n{"type":"adapter-approved"}'],
    ] as const) {
      await expect(store.approve(id, hash, version)).rejects.toMatchObject({ errorClass: 'invalid' })
      await expect(store.reject(id, hash, version)).rejects.toMatchObject({ errorClass: 'invalid' })
    }
    expect(audit.events).toEqual([])
  })

  it('fails closed on a corrupt file and refuses to overwrite it', async () => {
    await writeFile(path, '{"version":1,"approved":{"woolworths":["')
    const store = new ApprovalStore(path, audit)

    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    await expect(store.approve('woolworths', hashA, '1.0.0')).rejects.toMatchObject({
      stage: 'config',
      errorClass: 'invalid',
    })
    expect(await readFile(path, 'utf8')).toBe('{"version":1,"approved":{"woolworths":["')
    expect(audit.events).toEqual([])
  })

  it('fails closed on a file with an unexpected shape', async () => {
    await writeFile(path, JSON.stringify({ version: 1, approved: { woolworths: [hashA] }, everything: true }))
    expect(await new ApprovalStore(path, audit).isApproved('woolworths', hashA)).toBe(false)
  })

  it('does not treat a hand-planted __proto__ entry as an approval', async () => {
    await writeFile(path, `{"version":1,"approved":{"__proto__":["${hashA}"]}}`)
    expect(await new ApprovalStore(path, audit).isApproved('__proto__', hashA)).toBe(false)
  })

  it('fails closed when the file cannot be read', async () => {
    const store = new ApprovalStore(path, audit)
    await store.approve('woolworths', hashA, '1.0.0')
    await chmod(dir, 0o000)

    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    await expect(store.approvedHashes('woolworths')).rejects.toMatchObject({
      stage: 'config',
      errorClass: 'unavailable',
    })
  })

  it('refuses to write when the approvals path is not a readable file', async () => {
    const target = join(dir, 'is-a-directory')
    await mkdir(join(target, 'child'), { recursive: true })
    const store = new ApprovalStore(target, audit)

    await expect(store.approve('woolworths', hashA, '1.0.0')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['is-a-directory'])
  })
})
