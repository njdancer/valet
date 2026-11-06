import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApprovalStore } from '../src/approvals'

let dir: string
let path: string
const hashA = 'a'.repeat(64)
const hashB = 'b'.repeat(64)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-approvals-'))
  path = join(dir, 'approvals.json')
})

afterEach(async () => {
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

describe('ApprovalStore', () => {
  it('approves nothing before the file exists', async () => {
    const store = new ApprovalStore(path)
    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    expect(await store.approvedHashes('woolworths')).toEqual([])
  })

  it('approves exactly the hash that was approved', async () => {
    const store = new ApprovalStore(path)
    await store.approve('woolworths', hashA)

    expect(await store.isApproved('woolworths', hashA)).toBe(true)
    expect(await store.isApproved('woolworths', hashB)).toBe(false)
    expect(await store.isApproved('coles', hashA)).toBe(false)
  })

  it('persists approvals across instances', async () => {
    await new ApprovalStore(path).approve('woolworths', hashA)
    expect(await new ApprovalStore(path).isApproved('woolworths', hashA)).toBe(true)
  })

  it('does not approve a prefix or case variant of an approved hash', async () => {
    const store = new ApprovalStore(path)
    await store.approve('woolworths', hashA)

    expect(await store.isApproved('woolworths', hashA.slice(0, 63))).toBe(false)
    expect(await store.isApproved('woolworths', hashA.toUpperCase())).toBe(false)
  })

  it('keeps several approved hashes and approves each once', async () => {
    const store = new ApprovalStore(path)
    await store.approve('woolworths', hashA)
    await store.approve('woolworths', hashB)
    await store.approve('woolworths', hashA)

    expect(await store.approvedHashes('woolworths')).toEqual([hashA, hashB])
  })

  it('revokes one hash and forgets the adapter when none remain', async () => {
    const store = new ApprovalStore(path)
    await store.approve('woolworths', hashA)
    await store.approve('woolworths', hashB)
    await store.revoke('woolworths', hashA)
    expect(await store.approvedHashes('woolworths')).toEqual([hashB])

    await store.revoke('woolworths', hashB)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, approved: {} })
  })

  it('serialises concurrent approvals so none is lost', async () => {
    const store = new ApprovalStore(path)
    await Promise.all([
      store.approve('woolworths', hashA),
      store.approve('coles', hashA),
      store.approve('woolworths', hashB),
    ])

    expect(await store.approvedHashes('woolworths')).toEqual([hashA, hashB])
    expect(await store.approvedHashes('coles')).toEqual([hashA])
  })

  it('leaves no temporary files behind', async () => {
    const store = new ApprovalStore(path)
    await store.approve('woolworths', hashA)
    expect(await readdir(dir)).toEqual(['approvals.json'])
  })

  it('rejects ids that could escape a map key or path', async () => {
    const store = new ApprovalStore(path)
    await expect(store.approve('__proto__', hashA)).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(store.approve('../evil', hashA)).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(store.approve('woolworths', 'not-a-hash')).rejects.toMatchObject({ errorClass: 'invalid' })
  })

  it('fails closed on a corrupt file and refuses to overwrite it', async () => {
    await writeFile(path, '{"version":1,"approved":{"woolworths":["')
    const store = new ApprovalStore(path)

    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    await expect(store.approve('woolworths', hashA)).rejects.toMatchObject({
      stage: 'manifest',
      errorClass: 'invalid',
    })
    expect(await readFile(path, 'utf8')).toBe('{"version":1,"approved":{"woolworths":["')
  })

  it('fails closed on a file with an unexpected shape', async () => {
    await writeFile(path, JSON.stringify({ version: 1, approved: { woolworths: [hashA] }, everything: true }))
    expect(await new ApprovalStore(path).isApproved('woolworths', hashA)).toBe(false)
  })

  it('does not treat a hand-planted __proto__ entry as an approval', async () => {
    await writeFile(path, `{"version":1,"approved":{"__proto__":["${hashA}"]}}`)
    expect(await new ApprovalStore(path).isApproved('__proto__', hashA)).toBe(false)
  })

  it('fails closed when the file cannot be read', async () => {
    const store = new ApprovalStore(path)
    await store.approve('woolworths', hashA)
    await chmod(dir, 0o000)

    expect(await store.isApproved('woolworths', hashA)).toBe(false)
    await expect(store.approvedHashes('woolworths')).rejects.toMatchObject({ errorClass: 'unavailable' })
  })

  it('removes the temporary file when the rename fails', async () => {
    const target = join(dir, 'is-a-directory')
    await mkdir(join(target, 'child'), { recursive: true })
    const store = new ApprovalStore(target)

    await expect(store.approve('woolworths', hashA)).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['is-a-directory'])
  })
})
