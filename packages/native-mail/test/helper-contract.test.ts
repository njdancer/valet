// The reader helper itself (swift-bridge, MailAccess.swift) against the made-up Mail library, the
// same questions MailStore asks the in-process files. CI's swift-bridge job builds the debug helper
// and sets VALET_SWIFT_MESSAGES_HELPER; elsewhere this suite is skipped.

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectMailFiles } from '../src/direct-files'
import { HelperMailFiles, MailFilesError } from '../src/files'
import { MailStore } from '../src/store'
import { ALLOWED, buildLibrary } from './fixture-library'

const HELPER = process.env['VALET_SWIFT_MESSAGES_HELPER']

describe.skipIf(HELPER === undefined || HELPER === '')('valet-messages-helper: Mail', () => {
  let dir: string
  let helper: ChildProcess
  let files: HelperMailFiles
  let direct: DirectMailFiles

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'valet-mail-contract-'))
    const paths = buildLibrary(dir)
    symlinkSync(join(dir, 'Accounts4.sqlite'), join(paths.mailDir, 'V10', 'link.emlx'))
    const socketPath = join(dir, 'helper.sock')
    helper = spawn(
      HELPER as string,
      [
        'serve',
        'contract.messages-helper',
        '--socket',
        socketPath,
        '--mail-dir',
        paths.mailDir,
        '--accounts-db',
        paths.accountsDb,
      ],
      { stdio: 'ignore' },
    )
    for (let i = 0; i < 100; i++) {
      if ((await fs.lstat(socketPath).catch(() => null))?.isSocket()) break
      await new Promise((r) => setTimeout(r, 50))
    }
    files = new HelperMailFiles({ socketPath })
    direct = new DirectMailFiles(paths)
  })

  afterAll(() => {
    helper?.kill()
    rmSync(dir, { recursive: true, force: true })
  })

  const store = (f: HelperMailFiles | DirectMailFiles): MailStore =>
    new MailStore(f, { allowedAccounts: () => new Set([ALLOWED, 'local']) })

  it('answers MailStore exactly as the in-process files do', async () => {
    const viaHelper = store(files)
    const inProcess = store(direct)
    expect(await viaHelper.accounts()).toEqual(await inProcess.accounts())
    for (const query of [
      {},
      { from: 'ada' },
      { to: 'ada@' },
      { hasAttachment: true },
      { since: '2025-11-21T07:00:00Z' },
    ]) {
      expect(await viaHelper.search(query)).toEqual(await inProcess.search(query))
    }
    for (const id of [7, 8, 9, 12, 13, 1234])
      expect(await viaHelper.read(id)).toEqual(await inProcess.read(id))
    expect(await viaHelper.thread(8)).toEqual(await inProcess.thread(8))
  })

  it('refuses writes, other tables and paths outside the library', async () => {
    for (const sql of [
      'DELETE FROM messages',
      'SELECT * FROM sqlite_master',
      'SELECT 1; SELECT 2',
      "ATTACH '/tmp/x' AS x",
    ]) {
      await expect(files.query('envelope', sql, [])).rejects.toEqual(new MailFilesError('invalid'))
    }
    await expect(files.query('accounts', 'SELECT ZPASSWORD FROM ZCREDENTIAL', [])).rejects.toEqual(
      new MailFilesError('invalid'),
    )
    await expect(files.file('../Accounts4.sqlite')).rejects.toBeInstanceOf(MailFilesError)
    await expect(files.file('link.emlx')).rejects.toEqual(new MailFilesError('invalid'))
    await expect(files.list('..')).rejects.toEqual(new MailFilesError('invalid'))
  })

  it('answers a Spotlight question without failing on a library Spotlight hasn’t seen', async () => {
    expect(Array.isArray(await files.spotlight('zebra'))).toBe(true)
  })
})
