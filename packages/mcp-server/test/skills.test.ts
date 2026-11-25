import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMcpServer } from '../src/server'
import { SKILLS_EXTENSION, SKILLS_TTL_MS, skillMarkdown, TEST_SKILL, TEST_SKILL_PHRASE } from '../src/skills'
import { FakeCaller } from './fake-caller'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((o) => o.close()))
})

async function connect() {
  const endpoint = createMcpServer(new FakeCaller([]), { name: 'valet', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await endpoint.server.connect(serverTransport)
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  open.push(client, endpoint.server)
  return client
}

const Manifest = z.object({
  uri: z.string(),
  frontmatter: z.object({ name: z.string(), description: z.string() }).passthrough(),
  resources: z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
})
const ListResult = z.object({
  resultType: z.literal('complete'),
  skills: z.array(Manifest),
  ttlMs: z.number(),
  cacheScope: z.string(),
})
const GetResult = z.object({ resultType: z.literal('complete'), skill: Manifest, ttlMs: z.number() })

const SKILL_URI = 'skill://valet-skills-test/SKILL.md'

describe('skills (SEP-2640)', () => {
  it('declares resources and the skills extension', async () => {
    const client = await connect()
    const caps = client.getServerCapabilities()
    expect(caps?.resources).toBeDefined()
    expect(caps?.extensions?.[SKILLS_EXTENSION]).toEqual({})
  })

  it('lists the test skill with a manifest whose digests and sizes match what resources/read gives', async () => {
    const client = await connect()
    const listed = await client.request({ method: 'skills/list', params: {} }, ListResult)
    expect(listed.ttlMs).toBe(SKILLS_TTL_MS)
    expect(listed.skills).toHaveLength(1)
    const skill = listed.skills[0]
    expect(skill?.uri).toBe(SKILL_URI)
    expect(skill?.frontmatter).toEqual(TEST_SKILL.frontmatter)
    expect(skill?.resources.map((r) => r.uri)).toEqual([
      SKILL_URI,
      'skill://valet-skills-test/references/check.md',
    ])
    for (const file of skill?.resources ?? []) {
      const read = await client.readResource({ uri: file.uri })
      const text = (read.contents[0] as { text: string }).text
      const bytes = Buffer.from(text, 'utf8')
      expect(bytes.byteLength).toBe(file.size)
      expect(file.digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
      expect(text).toContain(TEST_SKILL_PHRASE)
    }
  })

  it('serves SKILL.md with frontmatter matching the listing, as text/markdown', async () => {
    const client = await connect()
    const read = await client.readResource({ uri: SKILL_URI })
    expect(read.contents[0]).toMatchObject({ uri: SKILL_URI, mimeType: 'text/markdown' })
    const text = (read.contents[0] as { text: string }).text
    expect(text).toBe(skillMarkdown(TEST_SKILL))
    expect(text.startsWith('---\nname: "valet-skills-test"\ndescription: ')).toBe(true)
  })

  it('lists the skill files as plain resources too, for clients that only know resources', async () => {
    const client = await connect()
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toContain(SKILL_URI)
  })

  it('gets a skill by URI and refuses an unknown one with invalid params', async () => {
    const client = await connect()
    const got = await client.request({ method: 'skills/get', params: { uri: SKILL_URI } }, GetResult)
    expect(got.skill.uri).toBe(SKILL_URI)
    await expect(
      client.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, GetResult),
    ).rejects.toMatchObject({ code: -32602 })
    await expect(client.request({ method: 'skills/get', params: {} }, GetResult)).rejects.toMatchObject({
      code: -32602,
    })
  })
})
