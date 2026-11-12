// The starter package a blank draft begins with (docs/authoring-tools.md#drafts-pr-1): a manifest
// for one read tool, its code, and one case, so the agent's first check runs and shows the shape of
// everything. It names example.com until the agent edits it.

import type { PackageFiles } from '@valet/core'

export function blankDraft(adapterId: string, name: string): PackageFiles {
  const manifest = {
    schemaVersion: 1,
    id: adapterId,
    name,
    version: '0.1.0',
    description: `Tools for ${name}. Replace this with what the adapter does.`,
    home: 'https://www.example.com/',
    navigation: ['https://www.example.com'],
    egress: ['www.example.com'],
    secrets: {},
    session: { cookieDomains: [], storage: [], probe: { kind: 'none' } },
    auth: { steps: [], frameOrigins: [] },
    requests: [{ method: 'GET', path: '/api/items/:id', purpose: 'read' }],
    tools: [
      {
        name: 'get_item',
        title: 'Get item',
        description: 'One item by its id: its name and price.',
        sideEffect: 'read',
      },
    ],
    settings: {},
    limits: {
      requestsPerRun: 5,
      minGapMs: 3000,
      requestsPerHour: 120,
      requestsPerMinute: 10,
      gapJitterPercent: 50,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    },
  }
  const tools = `// ${name}: tool code. It runs in Valet's sandbox and reaches the site only through ctx.page,
// held to manifest.json's egress and requests. Imports: zod, @valet/core, and files under src/.

import { tool, ValetError } from '@valet/core'
import { z } from 'zod'

const item = z.object({ id: z.string(), name: z.string().max(200), price: z.number().nullable() })

export const tools = {
  get_item: tool({
    input: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,40}$/) }),
    output: item,
    async run(ctx, input) {
      const response = await ctx.page.fetch(\`/api/items/\${encodeURIComponent(input.id)}\`, {
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) throw new ValetError('tool-input', 'not-found')
      if (response.status !== 200) throw new ValetError('tool-run', 'unavailable')
      const body = response.body as { id?: unknown; title?: unknown; price?: unknown } | null
      return {
        id: String(body?.id ?? input.id),
        name: typeof body?.title === 'string' ? body.title.slice(0, 200) : '',
        price: typeof body?.price === 'number' ? body.price : null,
      }
    },
  }),
}
`
  const cases = {
    cases: [
      {
        name: 'an item',
        tool: 'get_item',
        input: { id: 'abc-1' },
        fetch: [{ method: 'GET', url: '/api/items/abc-1', status: 200, body: 'fixtures/item-abc-1.json' }],
        expect: { output: { id: 'abc-1', name: 'Example item', price: 4.5 } },
      },
      {
        name: 'an item that does not exist',
        tool: 'get_item',
        input: { id: 'nope' },
        fetch: [
          { method: 'GET', url: '/api/items/nope', status: 404, body: { inline: { error: 'not found' } } },
        ],
        expect: { error: { stage: 'tool-input', errorClass: 'not-found' } },
      },
    ],
  }
  return {
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src/tools.ts': tools,
    'test/example.json': `${JSON.stringify(cases, null, 2)}\n`,
    'fixtures/item-abc-1.json': `${JSON.stringify({ id: 'abc-1', title: 'Example item', price: 4.5 }, null, 2)}\n`,
  }
}
