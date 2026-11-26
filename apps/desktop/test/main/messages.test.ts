// @vitest-environment node
// Messages on this Mac (docs/messages.md): the switch decides whether agents see the tools, the
// hidden conversations and the codes rule hold on every call, every call is audited, and setup
// follows the reader. A made-up Messages folder; nothing touches real messages.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@valet/mcp-server'
import { type MessagesFiles, MessagesFilesError } from '@valet/native-messages'
import type { ToolCallResult } from '@valet/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DirectMessagesFiles } from '../../../../packages/native-messages/src/direct-files'
import { ADA, BANK, buildFixture, SECRET_CHAT } from '../../../../packages/native-messages/test/fixture'
import type { ReaderControl } from '../../src/main/core/mail'
import { MessagesService, MessagesSettingsStore } from '../../src/main/core/messages'

let root: string
const servers: Server[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'valet-messages-app-'))
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  rmSync(root, { recursive: true, force: true })
})

async function listening(path: string): Promise<void> {
  const server = createServer((socket) => socket.end())
  servers.push(server)
  await new Promise<void>((done) => server.listen(path, done))
}

function setup(files?: MessagesFiles) {
  const socketPath = join(root, 'helper.sock')
  const started: string[] = []
  const actions: string[] = []
  const reader: ReaderControl = {
    socketPath,
    start: async () => {
      started.push('start')
      return 'started'
    },
    openFullDiskAccess: async () => void actions.push('fda'),
    openLoginItems: async () => void actions.push('login'),
    reveal: async () => void actions.push('reveal'),
  }
  const audited: { call: ToolCall; result: ToolCallResult }[] = []
  const changes = { count: 0 }
  const service = new MessagesService({
    settings: new MessagesSettingsStore(join(root, 'messages.json')),
    reader,
    files: files ?? new DirectMessagesFiles(buildFixture(root)),
    audit: async (call, result) => void audited.push({ call, result }),
    now: () => Date.parse('2026-11-26T00:00:00Z'),
    changed: () => {
      changes.count += 1
    },
  })
  return { service, socketPath, started, actions, audited, changes }
}

const call = (tool: string, input: unknown): ToolCall =>
  ({ callId: 'c1', adapterId: 'messages', tool, input, client: 'test' }) as unknown as ToolCall

describe('MessagesService', () => {
  it('lists no tools until it is on, then all four read-only tools', async () => {
    const { service, started, changes } = setup()
    await service.load()
    expect(service.listTools()).toEqual([])
    expect(service.allTools().map((t) => t.declaration.name)).toEqual([
      'chats',
      'search',
      'read',
      'attachment',
    ])
    await service.update({ enabled: true })
    expect(started).toEqual(['start'])
    expect(changes.count).toBe(1)
    expect(service.listTools().map((t) => `${t.adapterId}.${t.declaration.name}`)).toEqual([
      'messages.chats',
      'messages.search',
      'messages.read',
      'messages.attachment',
    ])
    expect(service.listTools().every((t) => t.declaration.sideEffect === 'read')).toBe(true)
    // Hiding a conversation doesn't change the tool list.
    await service.update({ hidden: [ADA] })
    expect(changes.count).toBe(1)
  })

  it('keeps hidden conversations and codes from agents, read on every call, and audits each', async () => {
    const { service, audited } = setup()
    await service.load()
    await service.update({ enabled: true, hidden: [SECRET_CHAT] })
    const signal = new AbortController().signal
    const chats = await service.call(call('chats', {}), signal)
    expect(JSON.stringify(chats)).not.toContain(SECRET_CHAT)
    expect(await service.call(call('read', { chatId: SECRET_CHAT }), signal)).toMatchObject({
      status: 'failed',
      errorClass: 'not-found',
    })
    expect(JSON.stringify(await service.call(call('read', { chatId: BANK }), signal))).not.toContain('482913')
    // Unhiding and turning the codes rule off take effect on the next call.
    await service.update({ hidden: [], hideCodes: false })
    expect(await service.call(call('read', { chatId: SECRET_CHAT }), signal)).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(await service.call(call('read', { chatId: BANK }), signal))).toContain('482913')
    expect(audited).toHaveLength(5)
    // Off: nothing answers.
    await service.update({ enabled: false })
    expect(await service.call(call('chats', {}), signal)).toMatchObject({ status: 'failed', stage: 'config' })
    const aborted = new AbortController()
    aborted.abort()
    await service.update({ enabled: true })
    expect(await service.call(call('chats', {}), aborted.signal)).toMatchObject({ errorClass: 'aborted' })
  })

  it('follows setup: reader, Full Disk Access, then the conversations', async () => {
    let chat = false
    const fixture = new DirectMessagesFiles(buildFixture(root))
    const files: MessagesFiles = {
      info: async () => ({ ...(await fixture.info()), chat }),
      query: (...args) => fixture.query(...args),
      file: (path) => fixture.file(path),
    }
    const { service, socketPath, actions } = setup(files)
    await service.load()
    expect((await service.status()).state).toBe('off')
    await service.update({ enabled: true, hidden: [ADA] })
    expect((await service.status()).state).toBe('not-running')
    await listening(socketPath)
    expect((await service.status()).state).toBe('needs-access')
    await service.action('full-disk-access')
    await service.action('reveal-reader')
    expect(actions).toEqual(['fda', 'reveal'])
    chat = true
    const ready = await service.status()
    expect(ready.state).toBe('ready')
    expect(ready.chats.find((c) => c.id === ADA)).toMatchObject({ name: 'Ada Example', hidden: true })
    expect(ready.chats.find((c) => c.id === SECRET_CHAT)).toMatchObject({ hidden: false })
    expect(ready.chats.find((c) => c.id === 'chat123456789')?.detail).toBe('4 people')
  })

  it('says a reader from before these tools needs rebuilding', async () => {
    const old: MessagesFiles = {
      info: async () => {
        throw new MessagesFilesError('invalid')
      },
      query: async () => [],
      file: async () => Buffer.alloc(0),
    }
    const { service, socketPath } = setup(old)
    await service.load()
    await service.update({ enabled: true })
    await listening(socketPath)
    expect((await service.status()).state).toBe('no-reader')
  })

  it('reads an unreadable settings file as off', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(root, 'messages.json'), '{not json')
    const { service } = setup()
    await service.load()
    expect(service.listTools()).toEqual([])
  })
})
