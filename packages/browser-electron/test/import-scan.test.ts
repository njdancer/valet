import { describe, expect, it } from 'vitest'
import { importedModules, importsElectron } from './import-scan'

describe('importedModules', () => {
  it('finds every way of importing a module', () => {
    const source = [
      "import { app } from 'electron'",
      'import type { Session } from "electron/main"',
      "import 'side-effect'",
      "export * from './re-export'",
      "export { a } from './named'",
      "const lazy = await import('./lazy')",
      'const cjs = require("cjs-module")',
      'const spaced = require ( "spaced" )',
      'import tpl from `template`',
      "import x = require('ts-equals')",
    ].join('\n')
    expect(importedModules(source)).toEqual([
      'electron',
      'electron/main',
      'side-effect',
      './re-export',
      './named',
      './lazy',
      'cjs-module',
      'spaced',
      'template',
      'ts-equals',
    ])
  })

  it('ignores strings that are not in an import position', () => {
    const source = [
      "const name = 'electron'",
      "console.log('import electron from electron')",
      "obj.require('electron')",
      "notimport('electron')",
    ].join('\n')
    expect(importedModules(source)).toEqual([])
  })

  it('ignores imports inside comments', () => {
    const source = [
      "// import { app } from 'electron'",
      "/* const e = require('electron') */",
      'const x = 1',
    ].join('\n')
    expect(importedModules(source)).toEqual([])
  })

  it('ignores imports inside strings and static templates', () => {
    const source = [
      `const a = "import { app } from 'electron'"`,
      "const b = `require('electron')`",
      `const c = 'from "electron"'`,
    ].join('\n')
    expect(importedModules(source)).toEqual([])
  })

  it('still finds an import inside a template expression', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template
    expect(importedModules("const t = `${await import('electron')}`")).toEqual(['electron'])
  })

  it('handles nested braces in a template expression', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under test contains a template
    expect(importedModules("const t = `${ { a: 1 }.a }`; import('after')")).toEqual(['after'])
  })

  it('is not thrown off by a quote inside a regular expression', () => {
    const source = ["const quote = /'/g", "const s = x.replace(/[\"'`]/, '')", "import('electron')"].join(
      '\n',
    )
    expect(importedModules(source)).toEqual(['electron'])
  })

  it('tells a division from a regular expression', () => {
    expect(importedModules("const half = total / 2; const r = a / b / c; import('after-division')")).toEqual([
      'after-division',
    ])
  })

  it('reads a regular expression after return, with flags and an escaped slash', () => {
    expect(importedModules("function f() { return /a\\/'b/gi }\nimport('after')")).toEqual(['after'])
  })

  it('keeps escaped characters in a specifier', () => {
    expect(importedModules("import x from 'elec\\u0074ron'")).toEqual(['elecu0074ron'])
    expect(importedModules('import x from "a\\"b"')).toEqual(['a"b'])
  })

  it('survives unterminated literals and comments', () => {
    expect(importedModules("const s = 'unterminated\nimport('next')")).toEqual(['next'])
    expect(importedModules('/* never closed')).toEqual([])
    expect(importedModules('const t = `never closed')).toEqual([])
  })
})

describe('importsElectron', () => {
  it('matches electron and its subpaths only', () => {
    expect(importsElectron("import { app } from 'electron'")).toBe(true)
    expect(importsElectron("import { app } from 'electron/main'")).toBe(true)
    expect(importsElectron("import { app } from 'electron-store'")).toBe(false)
    expect(importsElectron("import { app } from '@siteadapter/browser-electron'")).toBe(false)
  })
})
