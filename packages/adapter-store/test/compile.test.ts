import { describe, expect, it } from 'vitest'
import { CompileError, Compiler } from '../src/compile'

const manifest = '{}'
const ok = { 'manifest.json': manifest, 'src/tools.ts': 'export const tools = {}' }

describe('Compiler', () => {
  it('keeps compiling after a package breaks the bundler itself', async () => {
    const compiler = new Compiler()
    try {
      const nested = `export const tools = ${'('.repeat(100_000)}1${')'.repeat(100_000)}`
      await expect(compiler.compile({ ...ok, 'src/tools.ts': nested })).rejects.toBeInstanceOf(CompileError)
      await expect(compiler.compile(ok)).resolves.toContain('__valetTools')
    } finally {
      await compiler.close()
    }
  }, 60_000)

  it('abandons a compile that takes too long, then starts afresh', async () => {
    const compiler = new Compiler(undefined, 1)
    try {
      await expect(compiler.compile(ok)).rejects.toThrow(/took too long|stopped/)
    } finally {
      await compiler.close()
    }
    const patient = new Compiler()
    try {
      await expect(patient.compile(ok)).resolves.toContain('__valetTools')
    } finally {
      await patient.close()
    }
  }, 60_000)

  it('reports an ordinary compile error with where it is', async () => {
    const compiler = new Compiler()
    try {
      const error = await compiler.compile({ ...ok, 'src/tools.ts': "import './missing'" }).catch((e) => e)
      expect(error).toBeInstanceOf(CompileError)
      expect((error as CompileError).detail).toMatch(/may not import \.\/missing/)
      await expect(compiler.compile(ok)).resolves.toContain('__valetTools')
    } finally {
      await compiler.close()
    }
  }, 60_000)

  it('tries again after its files could not be read', async () => {
    const compiler = new Compiler({ browserJs: '/nonexistent/browser.js', wasm: '/nonexistent/esbuild.wasm' })
    await expect(compiler.compile(ok)).rejects.toThrow()
    await expect(compiler.compile(ok)).rejects.toThrow()
    await compiler.close()
  })
})
