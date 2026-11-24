// The reader helper itself (swift-bridge, EventKitAccess.swift) over its socket. CI's swift-bridge
// job builds the debug helper and sets VALET_SWIFT_MESSAGES_HELPER; elsewhere this is skipped. The
// runner has no Calendar or Reminders access, and this suite never asks macOS for it or writes
// anything: it checks the helper answers, refuses what it should, and reads nothing without access.

import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventKitError, HelperEventKit } from '../src/helper'

const HELPER = process.env['VALET_SWIFT_MESSAGES_HELPER']
const ACCESS = ['full', 'write-only', 'denied', 'restricted', 'not-determined']

function raw(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let data = ''
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
    })
    socket.on('close', () => resolve(data.trim()))
    socket.on('error', reject)
  })
}

describe.skipIf(HELPER === undefined || HELPER === '')(
  'valet-messages-helper: Calendar and Reminders',
  () => {
    let dir: string
    let helper: ChildProcess
    let socketPath: string
    let kit: HelperEventKit

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'valet-eventkit-contract-'))
      socketPath = join(dir, 'helper.sock')
      helper = spawn(HELPER as string, ['serve', 'contract.messages-helper', '--socket', socketPath], {
        stdio: 'ignore',
      })
      for (let i = 0; i < 100; i++) {
        if ((await fs.lstat(socketPath).catch(() => null))?.isSocket()) break
        await new Promise((r) => setTimeout(r, 50))
      }
      kit = new HelperEventKit({ socketPath })
    })

    afterAll(() => {
      helper?.kill()
      rmSync(dir, { recursive: true, force: true })
    })

    it('says what access macOS gives it', async () => {
      expect(ACCESS).toContain(await kit.access('events'))
      expect(ACCESS).toContain(await kit.access('reminders'))
    })

    it('reads nothing without full access', async () => {
      for (const kind of ['events', 'reminders'] as const) {
        if ((await kit.access(kind)) === 'full') continue
        await expect(kit.calendars(kind)).rejects.toEqual(new EventKitError('denied'))
      }
      if ((await kit.access('events')) !== 'full')
        await expect(kit.events({ calendars: ['X'], startMs: 0, endMs: 86_400_000 })).rejects.toEqual(
          new EventKitError('denied'),
        )
    })

    it('refuses unknown questions and keys', async () => {
      for (const line of [
        '{"v":1,"op":"eventkit.delete","kind":"events"}',
        '{"v":1,"op":"eventkit.status","kind":"contacts"}',
        '{"v":1,"op":"eventkit.status","kind":"events","extra":true}',
        '{"v":1,"op":"eventkit.events","calendars":["X"],"startMs":0,"endMs":99999999999999}',
        '{"v":1,"op":"eventkit.saveEvent","calendar":"X","id":"E","attendees":["a@b.c"]}',
      ])
        expect(JSON.parse(await raw(socketPath, line))).toEqual({ error: 'invalid' })
    })

    it('still answers Mail’s questions beside these', async () => {
      const answer = JSON.parse(await raw(socketPath, '{"v":1,"op":"mail.info"}'))
      expect(typeof answer).toBe('object')
    })
  },
)
