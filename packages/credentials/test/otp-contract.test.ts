// One set of cases, run against both ways Valet reads Messages codes: the in-process reader
// (MessagesOtpReader) and the Messages helper (valet-messages-helper, through
// MessagesHelperOtpReader). CI builds the helper in debug, where `serve` takes a fixture database
// and a socket path, and sets VALET_SWIFT_MESSAGES_HELPER. The in-process half runs everywhere.

import { type ChildProcess, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OtpReader } from '@valet/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MessagesHelperOtpReader } from '../src/messages-helper'
import { MessagesOtpReader } from '../src/messages-otp'
import { archived } from './typedstream-fixture'

const HELPER = process.env['VALET_SWIFT_MESSAGES_HELPER']
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1)
// The helper checks the cut-off against its own clock, so the fixture is laid out around now.
const NOW = Date.now()
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000)
const appleNanos = (at: Date) => BigInt(at.getTime() - APPLE_EPOCH_MS) * 1_000_000n
const appleSeconds = (at: Date) => BigInt(Math.floor((at.getTime() - APPLE_EPOCH_MS) / 1000))

const WOOLWORTHS = { sender: 'Woolworths', pattern: 'code is (\\d{6})', maxAgeSeconds: 600 }

interface Case {
  readonly name: string
  readonly query: typeof WOOLWORTHS
  readonly notBefore: Date
  /** The code, or the failure's class name and its failure or error class. */
  readonly expected: string
}

const CASES: readonly Case[] = [
  { name: 'newest code from the sender', query: WOOLWORTHS, notBefore: minutesAgo(5), expected: '222222' },
  { name: 'nothing since the cut-off', query: WOOLWORTHS, notBefore: minutesAgo(0.5), expected: 'not-found' },
  {
    name: 'only from the exact sender',
    query: { ...WOOLWORTHS, sender: '+61 400 000 000' },
    notBefore: minutesAgo(5),
    expected: '777777',
  },
  {
    name: 'decoded from attributedBody',
    query: { ...WOOLWORTHS, sender: 'Coles' },
    notBefore: minutesAgo(5),
    expected: '444444',
  },
  {
    name: 'seconds-precision dates',
    query: { ...WOOLWORTHS, sender: 'OldBank' },
    notBefore: minutesAgo(5),
    expected: '555555',
  },
  {
    name: 'not code-shaped captures are skipped',
    query: { ...WOOLWORTHS, sender: 'Chatty', pattern: 'says (.*)' },
    notBefore: minutesAgo(5),
    expected: 'not-found',
  },
  {
    name: 'whole match without a group',
    query: { ...WOOLWORTHS, pattern: '\\d{6}' },
    notBefore: minutesAgo(5),
    expected: '222222',
  },
  {
    name: 'messages the person sent are ignored',
    query: { ...WOOLWORTHS, sender: 'Self' },
    notBefore: minutesAgo(5),
    expected: 'not-found',
  },
  {
    name: 'an unknown sender has nothing',
    query: { ...WOOLWORTHS, sender: 'Nobody' },
    notBefore: minutesAgo(5),
    expected: 'not-found',
  },
]

async function outcome(reader: OtpReader, testCase: Case): Promise<string> {
  try {
    const code = await reader.latest(testCase.query, testCase.notBefore)
    return code.reveal((plaintext) => plaintext)
  } catch (error) {
    const known = error as { failure?: string; errorClass?: string }
    return known.failure ?? known.errorClass ?? 'thrown'
  }
}

let dir: string
let dbPath: string

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'valet-otp-contract-'))
  dbPath = join(dir, 'chat.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, service TEXT NOT NULL);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, attributedBody BLOB,
      handle_id INTEGER DEFAULT 0, date INTEGER, is_from_me INTEGER DEFAULT 0
    );
    INSERT INTO handle (ROWID, id, service) VALUES (1, 'Woolworths', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (2, '+61400000000', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (3, 'Coles', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (4, 'OldBank', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (5, 'Chatty', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (6, 'Self', 'SMS');
    INSERT INTO handle (ROWID, id, service) VALUES (7, 'fake.woolworths@icloud.com', 'iMessage');
  `)
  let guid = 0
  const insert = (
    handle: number,
    date: bigint,
    text: string | null,
    body: Uint8Array | null = null,
    fromMe = 0,
  ) => {
    guid += 1
    db.prepare(
      'INSERT INTO message (guid, text, attributedBody, handle_id, date, is_from_me) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`g${guid}`, text, body, handle, date, fromMe)
  }
  insert(1, appleNanos(minutesAgo(20)), 'Your code is 000000')
  insert(1, appleNanos(minutesAgo(3)), 'Your code is 111111')
  insert(1, appleNanos(minutesAgo(2)), 'Your code is 222222')
  insert(7, appleNanos(minutesAgo(1)), 'Your code is 999999')
  insert(2, appleNanos(minutesAgo(2)), 'code is 777777')
  insert(3, appleNanos(minutesAgo(2)), null, archived(`Your code is 444444 ${'x'.repeat(300)}`, 'int16'))
  insert(4, appleSeconds(minutesAgo(2)), 'Your code is 555555')
  insert(5, appleNanos(minutesAgo(2)), 'Chatty says the spare key is under the mat')
  insert(6, appleNanos(minutesAgo(2)), 'code is 888888', null, 1)
  db.close()
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('in-process Messages reader', () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      expect(await outcome(new MessagesOtpReader({ path: dbPath }), testCase)).toBe(testCase.expected)
    })
  }
})

describe.skipIf(HELPER === undefined || HELPER === '')('valet-messages-helper', () => {
  let helper: ChildProcess
  let socketPath: string

  beforeAll(async () => {
    socketPath = join(dir, 'helper.sock')
    helper = spawn(
      HELPER as string,
      ['serve', 'contract.messages-helper', '--socket', socketPath, '--db', dbPath],
      {
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
    for (let i = 0; i < 100; i++) {
      if ((await fs.lstat(socketPath).catch(() => null))?.isSocket()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('the helper did not start listening')
  })

  afterAll(() => {
    helper?.kill()
  })

  for (const testCase of CASES) {
    it(testCase.name, async () => {
      expect(await outcome(new MessagesHelperOtpReader({ socketPath }), testCase)).toBe(testCase.expected)
    })
  }

  it('answers a malformed request with invalid, and keeps serving', async () => {
    const { createConnection } = await import('node:net')
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ path: socketPath })
      let text = ''
      socket.on('connect', () => socket.write('{"v":1,"handle":"woolworths"}\n'))
      socket.on('data', (chunk) => {
        text += chunk.toString()
      })
      socket.on('close', () => resolve(text))
      socket.on('error', reject)
    })
    expect(reply).toBe('{"error":"invalid"}\n')
    expect(await outcome(new MessagesHelperOtpReader({ socketPath }), CASES[0] as Case)).toBe('222222')
  })

  it('reports a database it cannot open as unavailable', async () => {
    const missing = join(dir, 'missing.sock')
    const other = spawn(
      HELPER as string,
      ['serve', 'contract.messages-helper', '--socket', missing, '--db', join(dir, 'nope.db')],
      {
        stdio: 'ignore',
      },
    )
    try {
      for (let i = 0; i < 100; i++) {
        if ((await fs.lstat(missing).catch(() => null))?.isSocket()) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(await outcome(new MessagesHelperOtpReader({ socketPath: missing }), CASES[0] as Case)).toBe(
        'unavailable',
      )
    } finally {
      other.kill()
    }
  })
})
