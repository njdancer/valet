// @vitest-environment node
// Where the app finds the protocol host (docs/imap.md#the-protocol-host), and that the main build
// emits it as one script that Node can run and that imports nothing but Node's own modules.

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBuilderConfig } from '../../electron-builder.config'
import { protocolHost } from '../../protocol-host-plugin'
import {
  PROTOCOL_HOST_FILE,
  PROTOCOL_HOST_PACKAGED,
  protocolHostScript,
  SFTP_HOST_FILE,
  SFTP_HOST_PACKAGED,
  sftpHostScript,
} from '../../src/main/core/protocol-host'

const APP = '/Applications/Valet.app/Contents'
const packaged = {
  packaged: true,
  resourcesPath: `${APP}/Resources`,
  mainDir: `${APP}/Resources/app.asar/out/main`,
}
const dev = {
  packaged: false,
  resourcesPath: '/repo/node_modules/electron/dist/Electron.app/Contents/Resources',
  mainDir: '/repo/apps/desktop/out/main',
}

describe('protocolHostScript', () => {
  it('finds the packaged script beside app.asar, never inside it', () => {
    expect(protocolHostScript({ ...packaged, exists: () => true })).toBe(
      `${APP}/Resources/app.asar.unpacked/out/main/protocol-host.cjs`,
    )
  })

  it('finds a development build’s script beside the main bundle', () => {
    expect(protocolHostScript({ ...dev, exists: () => true })).toBe(
      '/repo/apps/desktop/out/main/protocol-host.cjs',
    )
  })

  it('finds the SFTP host the same way, as its own file', () => {
    expect(sftpHostScript({ ...packaged, exists: () => true })).toBe(
      `${APP}/Resources/app.asar.unpacked/out/main/sftp-host.cjs`,
    )
    expect(sftpHostScript({ ...dev, exists: () => true })).toBe('/repo/apps/desktop/out/main/sftp-host.cjs')
    expect(sftpHostScript({ ...dev, exists: (p) => !p.endsWith('sftp-host.cjs') })).toBeNull()
  })

  it('is null when the script is missing, so protocol adapters stay unavailable', () => {
    for (const places of [packaged, dev])
      expect(protocolHostScript({ ...places, exists: () => false })).toBeNull()
  })

  it('agrees with the package: the script is unpacked from app.asar', () => {
    const config = createBuilderConfig({}, {
      bridgeBuilt: () => true,
      nodeRuntimeBuilt: () => true,
    } as never)
    expect(config.asarUnpack).toEqual([PROTOCOL_HOST_PACKAGED, SFTP_HOST_PACKAGED])
    expect(PROTOCOL_HOST_PACKAGED).toBe(`out/main/${PROTOCOL_HOST_FILE}`)
    expect(SFTP_HOST_PACKAGED).toBe(`out/main/${SFTP_HOST_FILE}`)
  })
})

describe('the main build’s protocol host', () => {
  it('emits the two hosts, each one script that Node runs, importing only node: modules', async () => {
    const emitted: { fileName: string; source: string }[] = []
    const plugin = protocolHost()
    expect(plugin.apply).toBe('build')
    const generate = plugin.generateBundle as unknown as (this: unknown) => Promise<void>
    await generate.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) })
    expect(emitted.map((f) => f.fileName)).toEqual([PROTOCOL_HOST_FILE, SFTP_HOST_FILE])
    const dir = await mkdtemp(join(tmpdir(), 'valet-host-'))
    try {
      for (const { fileName, source } of emitted) {
        const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1])
        expect(required.length).toBeGreaterThan(0)
        for (const name of required)
          expect(name, fileName).toMatch(/^node:|^(assert|buffer|crypto|events|net|path|stream|util|zlib)$/)
        const file = join(dir, fileName)
        await writeFile(file, source)
        const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
        expect(check.status, check.stderr).toBe(0)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
