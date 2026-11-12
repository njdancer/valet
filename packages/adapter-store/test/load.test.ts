import { tmpdir } from 'node:os'
import { createAdapter as wikipedia } from '@valet/adapter-wikipedia'
import { createAdapter as woolworths } from '@valet/adapter-woolworths'
import { createAdapter as yahooFinance } from '@valet/adapter-yahoo-finance'
import { type AdapterDefinition, bundleHash, canonicalJson, PackageError, packageOf } from '@valet/core'
import { inMemoryToolProcess } from '@valet/runtime/in-context'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LoadError, loadPackage } from '../src/load'
import { builtinPackage, libraryPrelude, MANIFESTS, sourcesOf } from './builtins'

const OWN: Readonly<Record<string, () => AdapterDefinition>> = {
  woolworths: () => woolworths(),
  'yahoo-finance': () => yahooFinance(),
  wikipedia: () => wikipedia(),
}

async function runtime() {
  return { prelude: await libraryPrelude(), start: inMemoryToolProcess() }
}

describe('loadPackage with the built-in adapters', () => {
  it.each(Object.keys(MANIFESTS))('loads %s with the hash it had before packages', async (id) => {
    const loaded = await loadPackage(builtinPackage(id), await runtime())
    const before = bundleHash({ ...sourcesOf(id), ':manifest.json': canonicalJson(MANIFESTS[id]?.()) })
    expect(loaded.adapterHash).toBe(before)
    expect(loaded.manifest.id).toBe(id)
    expect(Object.keys(loaded.definition.tools).sort()).toEqual(Object.keys(OWN[id]?.().tools ?? {}).sort())
  })

  it.each(Object.keys(MANIFESTS))('derives %s schemas that list as the adapter’s own do', async (id) => {
    const loaded = await loadPackage(builtinPackage(id), await runtime())
    const own = OWN[id]?.().tools ?? {}
    for (const [name, tool] of Object.entries(loaded.definition.tools)) {
      const real = own[name]
      if (real === undefined) throw new Error(name)
      expect(tool.input).toBeInstanceOf(z.ZodObject)
      // `additionalProperties: {}` and no additionalProperties mean the same: anything goes.
      expect(open(z.toJSONSchema(tool.input, { io: 'input', target: 'draft-7' }))).toEqual(
        open(z.toJSONSchema(real.input, { io: 'input', target: 'draft-7' })),
      )
      expect(open(z.toJSONSchema(tool.output, { io: 'output', target: 'draft-7' }))).toEqual(
        open(z.toJSONSchema(real.output, { io: 'output', target: 'draft-7' })),
      )
    }
  })

  it('checks input against the derived schema as the adapter would', async () => {
    const loaded = await loadPackage(builtinPackage('woolworths'), await runtime())
    const search = loaded.definition.tools['search_products']
    expect(search?.input.safeParse({ query: 'milk' }).success).toBe(true)
    expect(search?.input.safeParse({ query: 'milk', pageSize: 10_000 }).success).toBe(false)
    expect(search?.input.safeParse({ query: 'milk', extra: 1 }).success).toBe(
      OWN['woolworths']?.().tools['search_products']?.input.safeParse({ query: 'milk', extra: 1 }).success,
    )
  })

  it('never runs a package tool in this process', async () => {
    const loaded = await loadPackage(builtinPackage('wikipedia'), await runtime())
    const [tool] = Object.values(loaded.definition.tools)
    await expect(tool?.run({} as never, {})).rejects.toMatchObject({
      stage: 'tool-run',
      errorClass: 'internal',
    })
  })
})

describe('loadPackage refusals', () => {
  const manifest = MANIFESTS['wikipedia']?.()
  if (manifest === undefined) throw new Error('manifest')
  const sources = sourcesOf('wikipedia')

  it('refuses a package that breaks a rule before compiling', async () => {
    await expect(
      loadPackage({ ...builtinPackage('wikipedia'), 'src/a.js': '' }, await runtime()),
    ).rejects.toBeInstanceOf(PackageError)
  })

  it.each([
    ['a Node built-in', "import { readFileSync } from 'node:fs'\nexport const x = readFileSync"],
    ['electron', "import { app } from 'electron'\nexport const x = app"],
    ['an npm package', "import x from 'left-pad'\nexport { x }"],
    ['a file outside src', "import x from '../test/a'\nexport { x }"],
    ['an absolute path', "import x from '/etc/passwd'\nexport { x }"],
    ['a data URL', "import x from 'data:text/javascript,export default 1'\nexport { x }"],
    ['a zod subpath', "import x from 'zod/v4/core'\nexport { x }"],
    ['a require', "export const x = require('fs')"],
  ])('refuses an import of %s', async (_name, code) => {
    const files = packageOf(manifest, { ...sources, 'src/evil.ts': code, 'test/a.ts': 'export default 1' })
    files['src/tools.ts'] = `${files['src/tools.ts']}\nexport * from './evil'\n`
    const error = await loadPackage(files, await runtime()).catch((e) => e)
    expect(error).toBeInstanceOf(LoadError)
    expect((error as LoadError).stage).toBe('compile')
  })

  it('refuses a tool that is declared but not implemented, or implemented but not declared', async () => {
    const extra = { ...manifest, tools: [...manifest.tools, { ...manifest.tools[0], name: 'missing_tool' }] }
    await expect(loadPackage(packageOf(extra as never, sources), await runtime())).rejects.toMatchObject({
      stage: 'schema',
    })
    const fewer = { ...manifest, tools: manifest.tools.slice(1) }
    await expect(loadPackage(packageOf(fewer as never, sources), await runtime())).rejects.toMatchObject({
      stage: 'schema',
    })
  })

  it('refuses a script that never answers describe', async () => {
    const files = packageOf(manifest, { ...sources })
    files['src/tools.ts'] = 'export const tools = (() => { while (true) {} })()'
    const quiet = { prelude: await libraryPrelude(), start: hangingProcess(), describeTimeoutMs: 50 }
    await expect(loadPackage(files, quiet)).rejects.toMatchObject({ stage: 'describe' })
  })

  it('refuses a schema the main process should not convert', async () => {
    const files = packageOf(manifest, { ...sources })
    const name = manifest.tools[0]?.name ?? ''
    files['src/tools.ts'] = [
      "import { z } from 'zod'",
      "import { tools as real } from './tools-real'",
      `const loop = z.object({ get next() { return loop.optional() } })`,
      `export const tools = { ...real, ${name}: { ...real['${name}'], input: z.object({ a: loop }) } }`,
    ].join('\n')
    files['src/tools-real.ts'] = sources['src/tools.ts'] ?? ''
    const error = await loadPackage(files, await runtime()).catch((e) => e)
    expect(error).toMatchObject({ stage: 'schema' })
  })

  it('compiles the same files to the same script', async () => {
    const one = await loadPackage(builtinPackage('yahoo-finance'), await runtime())
    const two = await loadPackage(builtinPackage('yahoo-finance'), await runtime())
    expect(one.script).toBe(two.script)
    // Nothing about where it was compiled ends up in it.
    expect(one.script).not.toContain(tmpdir())
  })
})

function open(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(open)
  if (schema === null || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' && JSON.stringify(value) === '{}') continue
    // The main process never sees patterns; the tool process enforces them (schemas.ts).
    if (key === 'pattern') continue
    out[key] = open(value)
  }
  return out
}

/** A process that takes messages and never answers. */
function hangingProcess() {
  return () => ({ send: () => {}, onMessage: () => {}, onExit: () => {}, kill: () => {} })
}
