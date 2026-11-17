// @vitest-environment node
// Where the app finds the protocol host (docs/imap.md#the-protocol-host), and that the main build
// emits it as one script that Node can run and that imports nothing but Node's own modules.

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBuilderConfig, NODE_RUNTIME_BUILD } from '../../electron-builder.config'
import { protocolHost } from '../../protocol-host-plugin'
import {
  NODE_RUNTIME_DEV,
  PROTOCOL_HOST_FILE,
  PROTOCOL_HOST_PACKAGED,
  protocolHostPaths,
} from '../../src/main/core/protocol-host'

const APP = '/Applications/Valet.app/Contents'
const packaged = {
  packaged: true,
  execPath: `${APP}/MacOS/Valet`,
  resourcesPath: `${APP}/Resources`,
  mainDir: `${APP}/Resources/app.asar/out/main`,
  appPath: `${APP}/Resources/app.asar`,
}
const dev = {
  packaged: false,
  execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
  mainDir: '/repo/apps/desktop/out/main',
  appPath: '/repo/apps/desktop',
}

describe('protocolHostPaths', () => {
  it('finds the packaged binary beside the app and the script beside app.asar, never inside it', () => {
    expect(protocolHostPaths({ ...packaged, exists: () => true })).toEqual({
      nodeBinary: `${APP}/MacOS/valet-node`,
      hostScript: `${APP}/Resources/app.asar.unpacked/out/main/protocol-host.cjs`,
    })
  })

  it('finds a development build’s own Node runtime and the built script', () => {
    expect(protocolHostPaths({ ...dev, exists: () => true })).toEqual({
      nodeBinary: '/repo/apps/desktop/.node-runtime/valet-node',
      hostScript: '/repo/apps/desktop/out/main/protocol-host.cjs',
    })
  })

  it('is null when either is missing, so protocol adapters stay unavailable', () => {
    for (const places of [packaged, dev]) {
      expect(protocolHostPaths({ ...places, exists: (p) => !p.endsWith('valet-node') })).toBeNull()
      expect(protocolHostPaths({ ...places, exists: (p) => !p.endsWith(PROTOCOL_HOST_FILE) })).toBeNull()
    }
  })

  it('agrees with the package: the same Node build, and the script unpacked from app.asar', () => {
    expect(NODE_RUNTIME_BUILD).toBe(NODE_RUNTIME_DEV)
    const config = createBuilderConfig({}, {
      bridgeBuilt: () => true,
      nodeRuntimeBuilt: () => true,
    } as never)
    expect(config.asarUnpack).toEqual([PROTOCOL_HOST_PACKAGED])
    expect(PROTOCOL_HOST_PACKAGED).toBe(`out/main/${PROTOCOL_HOST_FILE}`)
  })
})

describe('the main build’s protocol host', () => {
  it('emits one script that Node runs, importing only node: modules', async () => {
    const emitted: { fileName: string; source: string }[] = []
    const plugin = protocolHost()
    expect(plugin.apply).toBe('build')
    const generate = plugin.generateBundle as unknown as (this: unknown) => Promise<void>
    await generate.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) })
    expect(emitted.map((f) => f.fileName)).toEqual([PROTOCOL_HOST_FILE])
    const source = emitted[0]?.source ?? ''
    const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])
    expect(required.length).toBeGreaterThan(0)
    for (const name of required) expect(name).toMatch(/^node:/)
    const dir = await mkdtemp(join(tmpdir(), 'valet-host-'))
    try {
      const file = join(dir, PROTOCOL_HOST_FILE)
      await writeFile(file, source)
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      expect(check.status, check.stderr).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
