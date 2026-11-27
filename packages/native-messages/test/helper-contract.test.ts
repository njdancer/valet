// The reader helper itself (swift-bridge, MessagesAccess.swift) against the made-up Messages and
// Contacts folders: the same questions MessagesStore asks the in-process files, which must come back
// the same. CI's swift-bridge job builds the helper and sets VALET_SWIFT_MESSAGES_HELPER; elsewhere
// this suite is skipped.

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectMessagesFiles } from '../src/direct-files'
import { HelperMessagesFiles, type MessagesFiles, MessagesFilesError } from '../src/files'
import { MessagesOtpReader } from '../src/otp'
import { MessagesStore } from '../src/store'
import { ADA, BANK, BOB, buildFixture, GROUP, PHOTO, SECRET_CHAT } from './fixture'

const HELPER = process.env['VALET_SWIFT_MESSAGES_HELPER']

describe.skipIf(HELPER === undefined || HELPER === '')('valet-messages-helper: Messages', () => {
  let dir: string
  let helper: ChildProcess
  let files: HelperMessagesFiles
  let direct: DirectMessagesFiles

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'valet-messages-contract-'))
    const paths = buildFixture(dir)
    symlinkSync(join(paths.messagesDir, 'chat.db'), join(paths.messagesDir, 'Attachments', 'link.db'))
    const socketPath = join(dir, 'helper.sock')
    helper = spawn(
      HELPER as string,
      [
        'serve',
        'contract.messages-helper',
        '--socket',
        socketPath,
        '--messages-dir',
        paths.messagesDir,
        '--address-book-dir',
        paths.addressBookDir,
      ],
      { stdio: 'ignore' },
    )
    for (let i = 0; i < 100; i++) {
      if ((await fs.lstat(socketPath).catch(() => null))?.isSocket()) break
      await new Promise((r) => setTimeout(r, 50))
    }
    files = new HelperMessagesFiles({ socketPath })
    direct = new DirectMessagesFiles(paths)
  })

  afterAll(() => {
    helper?.kill()
    rmSync(dir, { recursive: true, force: true })
  })

  const store = (f: MessagesFiles, hideCodes = true): MessagesStore =>
    new MessagesStore(f, { hidden: () => new Set([SECRET_CHAT]), hideCodes: () => hideCodes })

  it('answers MessagesStore exactly as the in-process files do', async () => {
    const viaHelper = store(files)
    const inProcess = store(direct)
    expect(await files.info()).toEqual(await direct.info())
    expect(await viaHelper.chats()).toEqual(await inProcess.chats())
    expect(await viaHelper.chats({ text: 'bob' })).toEqual(await inProcess.chats({ text: 'bob' }))
    expect(await viaHelper.allChats()).toEqual(await inProcess.allChats())
    for (const chatId of [ADA, BOB, GROUP, BANK])
      expect(await viaHelper.conversation(chatId)).toEqual(await inProcess.conversation(chatId))
    expect(await viaHelper.conversation(ADA, { before: 3, limit: 1 })).toEqual(
      await inProcess.conversation(ADA, { before: 3, limit: 1 }),
    )
    for (const query of [
      {},
      { text: 'running late' },
      { from: 'ada' },
      { fromMe: true },
      { hasAttachment: true },
      { since: '2026-11-22T00:00:00Z' },
    ])
      expect(await viaHelper.search(query)).toEqual(await inProcess.search(query))
    // The archived text (attributedBody) comes through the helper's message_text().
    expect((await viaHelper.search({ text: 'running late' })).messages.map((m) => m.id)).toEqual([3])
    expect(await store(files, false).search({ text: '482913' })).toEqual(
      await store(direct, false).search({ text: '482913' }),
    )
    expect((await viaHelper.attachment(4, 1)).data).toEqual(PHOTO)
    expect(await viaHelper.attachment(4, 2)).toEqual(await inProcess.attachment(4, 2))
    const since = Date.parse('2026-11-25T00:00:00Z')
    expect(await viaHelper.recentFrom(BANK, ['SMS', 'RCS'], since)).toEqual(
      await inProcess.recentFrom(BANK, ['SMS', 'RCS'], since),
    )
    expect(await viaHelper.recentFrom(BANK, ['SMS'], since, { chars: 10 })).toEqual(
      await inProcess.recentFrom(BANK, ['SMS'], since, { chars: 10 }),
    )
    // Valet's own sign-in code lookup, through the helper as the app reads it.
    const now = () => new Date('2026-11-25T03:05:00Z')
    const query = { sender: BANK, pattern: 'code is (\\d{6})', maxAgeSeconds: 600 }
    const notBefore = new Date('2026-11-25T02:59:00Z')
    const code = await new MessagesOtpReader({ files, now }).latest(query, notBefore)
    expect(code.reveal((plaintext) => plaintext)).toBe('482913')
    await expect(
      new MessagesOtpReader({ files, now }).latest({ ...query, sender: '72346' }, notBefore),
    ).rejects.toMatchObject({ failure: 'not-found' })
  })

  it('refuses writes, other tables and files outside Attachments', async () => {
    for (const sql of [
      'DELETE FROM message',
      'SELECT * FROM sqlite_master',
      'SELECT value FROM kvtable',
      'SELECT 1; SELECT 2',
      "ATTACH '/tmp/x' AS x",
      'UPDATE message SET text = 1',
    ])
      await expect(files.query('chat', sql, [])).rejects.toEqual(new MessagesFilesError('invalid'))
    await expect(files.query('contacts', 'SELECT ZTEXT FROM ZABCDNOTE', [], 'main')).rejects.toEqual(
      new MessagesFilesError('invalid'),
    )
    await expect(files.query('contacts', 'SELECT ZNOTE FROM ZABCDRECORD', [], 'main')).resolves.toBeDefined()
    await expect(files.query('contacts', 'SELECT 1 FROM ZABCDRECORD', [])).rejects.toEqual(
      new MessagesFilesError('invalid'),
    )
    await expect(files.query('contacts', 'SELECT 1 FROM ZABCDRECORD', [], '../x')).rejects.toEqual(
      new MessagesFilesError('invalid'),
    )
    await expect(files.query('contacts', 'SELECT 1 FROM ZABCDRECORD', [], 'NOPE')).rejects.toEqual(
      new MessagesFilesError('not-found'),
    )
    await expect(files.file('../chat.db')).rejects.toEqual(new MessagesFilesError('invalid'))
    await expect(files.file('../outside.txt')).rejects.toEqual(new MessagesFilesError('invalid'))
    await expect(files.file('link.db')).rejects.toEqual(new MessagesFilesError('invalid'))
    await expect(files.file('ab/01/missing.png')).rejects.toEqual(new MessagesFilesError('not-found'))
  })
})
