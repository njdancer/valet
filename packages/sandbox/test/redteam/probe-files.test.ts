// Red-team probes against ctx.local.files. Each case tries to reach content outside the declared
// patterns or a never-grantable place. Reported as the outcome string so a leak shows as the bytes.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxException } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileReach, localFiles } from '../../src/local/files'

let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'valet-home-')))
  await mkdir(join(home, 'Documents/Receipts/2026'), { recursive: true })
  await mkdir(join(home, 'Documents/Secret'), { recursive: true })
  await mkdir(join(home, '.ssh'), { recursive: true })
  await mkdir(join(home, 'Library/Application Support/Valet'), { recursive: true })
  await writeFile(join(home, 'Documents/Receipts/march.txt'), 'milk 3.10')
  await writeFile(join(home, 'Documents/Secret/diary.txt'), 'SECRET-DIARY')
  await writeFile(join(home, '.ssh/id_ed25519'), 'PRIVATE-KEY')
  await writeFile(join(home, 'Library/Application Support/Valet/approvals.json'), 'VALET-APPROVALS')
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const files = (exceptions: SandboxException[]) => localFiles(fileReach(exceptions, home), home)
const reads = (paths: string[]): SandboxException => ({ kind: 'files', access: 'read', paths, purpose: 't' })
const outcome = (p: Promise<unknown>) =>
  p.then(
    (v) => `OK:${JSON.stringify(v)}`,
    (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
  )

describe('probe: reaching outside a declared read pattern', () => {
  it('tries a batch of path tricks; none may return secret content', async () => {
    const f = files([reads(['~/Documents/Receipts/**'])])
    const tries: Record<string, string> = {}
    const paths = [
      '~/Documents/Secret/diary.txt',
      '~/.ssh/id_ed25519',
      '/etc/passwd',
      '~/Library/Application Support/Valet/approvals.json',
      '~/Documents/Receipts/../Secret/diary.txt',
      '~/Documents/Receipts/2026/../../Secret/diary.txt',
      `${home}/Documents/Secret/diary.txt`,
      '~//Documents//Secret//diary.txt',
    ]
    for (const p of paths) tries[p] = await outcome(f.read(p))
    for (const [p, r] of Object.entries(tries)) {
      expect([p, r.includes('SECRET'), r.includes('PRIVATE'), r.includes('VALET')]).toEqual([
        p,
        false,
        false,
        false,
      ])
    }
  })
})
