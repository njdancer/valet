import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DirectMessagesFiles } from '../src/direct-files'
import type { MessagesFiles } from '../src/files'
import { MessagesStore } from '../src/store'
import { callMessagesTool, MESSAGES_DATA_NOTE, messagesOutputs, messagesTools } from '../src/tools'
import { ADA, BANK, buildFixture, GROUP, PHOTO, SECRET_CHAT } from './fixture'

let dir: string
let files: MessagesFiles

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'valet-messages-tools-'))
  files = new DirectMessagesFiles(buildFixture(dir))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const deps = (render?: Parameters<typeof callMessagesTool>[0]['render']) => ({
  store: new MessagesStore(files, { hidden: () => new Set([SECRET_CHAT]), hideCodes: () => true }),
  ...(render === undefined ? {} : { render }),
})

describe('Messages tools', () => {
  it('declares four read-only tools', () => {
    const tools = messagesTools()
    expect(tools.map((t) => t.declaration.name)).toEqual(['chats', 'search', 'read', 'attachment'])
    expect(tools.every((t) => t.declaration.sideEffect === 'read')).toBe(true)
    expect(tools.every((t) => t.declaration.description.includes('data'))).toBe(true)
  })

  it('answers each tool in its declared shape, with the data note', async () => {
    const calls = [
      ['chats', {}],
      ['chats', { text: 'ada', limit: 5 }],
      ['search', { text: 'sunday' }],
      ['read', { chatId: GROUP }],
      ['read', { chatId: ADA, limit: 2, maxChars: 100 }],
    ] as const
    for (const [tool, input] of calls) {
      const result = await callMessagesTool(deps(), tool, input)
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') continue
      expect(messagesOutputs[tool].safeParse(result.output).success).toBe(true)
      expect((result.output as { note: string }).note).toBe(MESSAGES_DATA_NOTE)
    }
  })

  it('refuses bad input, unknown tools and hidden conversations', async () => {
    expect(await callMessagesTool(deps(), 'send', {})).toMatchObject({
      status: 'failed',
      errorClass: 'not-found',
    })
    expect(await callMessagesTool(deps(), 'read', {})).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    expect(await callMessagesTool(deps(), 'read', { chatId: ADA, before: 1, after: 2 })).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    expect(await callMessagesTool(deps(), 'chats', { extra: 1 })).toMatchObject({ errorClass: 'invalid' })
    expect(await callMessagesTool(deps(), 'read', { chatId: SECRET_CHAT })).toMatchObject({
      status: 'failed',
      stage: 'tool-input',
      errorClass: 'not-found',
    })
    expect(await callMessagesTool(deps(), 'attachment', { messageId: 17, index: 1 })).toMatchObject({
      errorClass: 'not-found',
    })
  })

  it('hides codes in what agents read', async () => {
    const result = await callMessagesTool(deps(), 'read', { chatId: BANK })
    expect(JSON.stringify(result)).not.toContain('482913')
  })

  it('sends a photo as a picture, a card as text, and others by name', async () => {
    const drawn = Buffer.from('drawn')
    const render = async () => ({
      pictures: [{ mimeType: 'image/jpeg' as const, data: drawn }],
      pageCount: 0,
    })
    const photo = await callMessagesTool(deps(render as never), 'attachment', { messageId: 4, index: 1 })
    expect(photo).toMatchObject({
      status: 'ok',
      output: { attachment: { name: 'IMG_0001.png', sent: 'picture' } },
      content: [{ kind: 'image', mimeType: 'image/jpeg', data: drawn }],
    })
    // Nothing to draw it: a PNG goes as it is.
    const asIs = await callMessagesTool(deps(), 'attachment', { messageId: 4, index: 1 })
    expect(asIs).toMatchObject({ content: [{ kind: 'image', mimeType: 'image/png', data: PHOTO }] })
    const card = await callMessagesTool(deps(), 'attachment', { messageId: 9, index: 1 })
    expect(card).toMatchObject({ output: { attachment: { sent: null } } })
    expect(JSON.stringify(card)).toContain('Ada Example')
    const voice = await callMessagesTool(deps(), 'attachment', { messageId: 4, index: 2 })
    expect(voice).toMatchObject({ output: { attachment: { reason: 'not-downloaded', sent: null } } })
    for (const result of [photo, card, voice]) {
      if (result.status === 'ok')
        expect(messagesOutputs.attachment.safeParse(result.output).success).toBe(true)
    }
  })

  it('asks the person when the reader can’t read Messages', async () => {
    const broken: MessagesFiles = {
      info: async () => {
        throw new Error('no socket')
      },
      query: async () => [],
      file: async () => Buffer.alloc(0),
    }
    const store = new MessagesStore(broken, { hidden: () => new Set(), hideCodes: () => true })
    expect(await callMessagesTool({ store }, 'chats', {})).toEqual({ status: 'needsUser', reason: 'other' })
  })
})
