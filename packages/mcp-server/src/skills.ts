// Skills served over MCP (the io.modelcontextprotocol/skills extension, SEP-2640). A spike: one
// fixed test skill, read-only, so that we can see which clients load skills from a connector.
//
// Each file of a skill is a resource at skill://<name>/<path>, read with resources/read. The
// extension's own methods, skills/list and skills/get, give each skill's frontmatter and a manifest
// of its files (uri, sha256 digest, size). SKILL.md's text is built from the same frontmatter
// object the methods return, so the two can't drift apart.

import { createHash } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'

/** How long a client may treat a listing as fresh: the overview's own example, 5 minutes. */
export const SKILLS_TTL_MS = 300_000

/** Agent Skills naming: lowercase letters, digits and single hyphens, at most 64. */
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillFile {
  /** Relative to the skill's root, for example `references/check.md`. */
  readonly path: string
  readonly mimeType: string
  readonly text: string
}

export interface Skill {
  readonly frontmatter: { readonly name: string; readonly description: string }
  /** SKILL.md's body, after the frontmatter. */
  readonly body: string
  /** Supporting files, besides SKILL.md. */
  readonly files: readonly SkillFile[]
}

/** The phrase the test skill's files carry, so a check can tell it read the real thing. */
export const TEST_SKILL_PHRASE = 'valet-skills-spike-ok'

export const TEST_SKILL: Skill = {
  frontmatter: {
    name: 'valet-skills-test',
    description:
      'Test skill served by Valet to check whether an MCP client loads skills from a connector. Use only when asked to test Valet skills.',
  },
  body: [
    '# Valet skills test',
    '',
    'This skill exists only to test that MCP skills served by Valet reach the agent.',
    '',
    `If you can read this, reply with the check phrase \`${TEST_SKILL_PHRASE}\` and say which client you are.`,
    '',
    'For the second half of the check, read [references/check.md](references/check.md).',
    '',
  ].join('\n'),
  files: [
    {
      path: 'references/check.md',
      mimeType: 'text/markdown',
      text: `# Supporting file\n\nRelative references resolve. Check phrase: ${TEST_SKILL_PHRASE}-ref\n`,
    },
  ],
}

/** Quotes a YAML scalar as a JSON string, which is valid YAML. */
function yamlLine(key: string, value: string): string {
  return `${key}: ${JSON.stringify(value)}`
}

export function skillMarkdown(skill: Skill): string {
  const { name, description } = skill.frontmatter
  return ['---', yamlLine('name', name), yamlLine('description', description), '---', '', skill.body].join(
    '\n',
  )
}

interface ServedFile {
  readonly uri: string
  readonly name: string
  readonly mimeType: string
  readonly text: string
  readonly digest: string
  readonly size: number
}

interface ServedSkill {
  readonly uri: string
  readonly frontmatter: Skill['frontmatter']
  readonly files: readonly ServedFile[]
}

function served(skill: Skill): ServedSkill {
  const { name } = skill.frontmatter
  if (!SKILL_NAME.test(name)) throw new Error(`Bad skill name: ${name}`)
  const root = `skill://${name}`
  const file = (path: string, mimeType: string, text: string): ServedFile => {
    const bytes = Buffer.from(text, 'utf8')
    return {
      uri: `${root}/${path}`,
      name: path === 'SKILL.md' ? name : `${name}/${path}`,
      mimeType,
      text,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      size: bytes.byteLength,
    }
  }
  return {
    uri: `${root}/SKILL.md`,
    frontmatter: skill.frontmatter,
    files: [
      file('SKILL.md', 'text/markdown', skillMarkdown(skill)),
      ...skill.files.map((f) => file(f.path, f.mimeType, f.text)),
    ],
  }
}

function entry(skill: ServedSkill) {
  return {
    uri: skill.uri,
    frontmatter: { ...skill.frontmatter },
    resources: skill.files.map(({ uri, digest, size }) => ({ uri, digest, size })),
  }
}

const SkillsListRequest = z.object({
  method: z.literal('skills/list'),
  params: z.object({}).passthrough().optional(),
})

const SkillsGetRequest = z.object({
  method: z.literal('skills/get'),
  // Checked by the handler, so that a missing or bad uri is invalid params, not an internal error.
  params: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Registers each skill's files as resources and answers skills/list and skills/get. Call before
 * the server connects; the capability is declared by the caller (createMcpServer).
 */
export function registerSkills(server: McpServer, skills: readonly Skill[]): void {
  const all = skills.map(served)
  const byUri = new Map(all.map((s) => [s.uri, s]))
  for (const skill of all) {
    for (const file of skill.files) {
      server.registerResource(
        file.name,
        file.uri,
        {
          mimeType: file.mimeType,
          ...(file.uri === skill.uri ? { description: skill.frontmatter.description } : {}),
        },
        () => ({ contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }] }),
      )
    }
  }
  server.server.setRequestHandler(SkillsListRequest, () => ({
    resultType: 'complete',
    skills: all.map(entry),
    ttlMs: SKILLS_TTL_MS,
    cacheScope: 'public',
  }))
  server.server.setRequestHandler(SkillsGetRequest, (request) => {
    const uri = request.params?.['uri']
    const skill = typeof uri === 'string' ? byUri.get(uri) : undefined
    if (skill === undefined) throw new McpError(ErrorCode.InvalidParams, 'Unknown skill')
    return { resultType: 'complete', skill: entry(skill), ttlMs: SKILLS_TTL_MS, cacheScope: 'public' }
  })
}
