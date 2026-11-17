// @vitest-environment node
// The app's side of the Node runtime for raw adapters (raw-runtime.ts): where the binary is, and the
// read and write paths a manifest's files exceptions become.

import { join } from 'node:path'
import { parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { nodeRuntimeBinary, rawPaths } from '../../src/main/core/raw-runtime'

const base = {
  packaged: true,
  execPath: '/Applications/Valet.app/Contents/MacOS/Valet',
  appPath: '/Applications/Valet.app/Contents/Resources/app.asar',
  e2e: false,
  env: {},
  exists: () => true,
}

describe('nodeRuntimeBinary', () => {
  it('is Contents/MacOS/valet-node in a packaged app, when it is there', () => {
    expect(nodeRuntimeBinary(base)).toBe('/Applications/Valet.app/Contents/MacOS/valet-node')
    expect(nodeRuntimeBinary({ ...base, exists: () => false })).toBeNull()
  })

  it('takes no name from the environment in a packaged app, or outside an e2e run', () => {
    const env = { VALET_E2E_NODE_RUNTIME: '/tmp/evil-node' }
    expect(nodeRuntimeBinary({ ...base, e2e: true, env })).toBe(
      '/Applications/Valet.app/Contents/MacOS/valet-node',
    )
    expect(nodeRuntimeBinary({ ...base, packaged: false, env, appPath: '/src/valet/apps/desktop' })).toBe(
      '/src/valet/apps/desktop/.node-runtime/valet-node',
    )
    expect(nodeRuntimeBinary({ ...base, packaged: false, e2e: true, env, appPath: '/x' })).toBe(
      '/tmp/evil-node',
    )
  })

  it('is never Electron itself, nor a relative path', () => {
    expect(
      nodeRuntimeBinary({
        ...base,
        packaged: false,
        e2e: true,
        env: { VALET_E2E_NODE_RUNTIME: base.execPath },
      }),
    ).toBeNull()
    expect(
      nodeRuntimeBinary({ ...base, packaged: false, e2e: true, env: { VALET_E2E_NODE_RUNTIME: 'node' } }),
    ).toBeNull()
  })
})

describe('rawPaths', () => {
  const manifest = (exceptions: unknown[]) =>
    parseManifest({
      schemaVersion: 1,
      id: 'raw-files',
      name: 'Raw files',
      version: '0.1.0',
      description: 'A raw adapter with files.',
      runtime: 'raw',
      endpoints: ['api.example.com:443'],
      sandbox: { mode: 'sandboxed', exceptions },
      tools: [{ name: 'read', title: 'Read', description: 'Reads.', sideEffect: 'read' }],
    })

  it('expands ~ and drops a trailing wildcard, by access', () => {
    const paths = rawPaths(
      manifest([
        {
          kind: 'files',
          access: 'read',
          paths: ['~/Documents/Notes/**', '/Volumes/Archive/Notes/*'],
          purpose: 'Reads notes.',
        },
        { kind: 'files', access: 'read-write', paths: ['~/Downloads/Exports'], purpose: 'Writes exports.' },
      ]),
      '/Users/alex',
    )
    expect(paths).toEqual({
      readPaths: [join('/Users/alex', 'Documents/Notes'), '/Volumes/Archive/Notes'],
      readWritePaths: [join('/Users/alex', 'Downloads/Exports')],
    })
  })

  it('is empty without file exceptions', () => {
    expect(rawPaths(manifest([]), '/Users/alex')).toEqual({ readPaths: [], readWritePaths: [] })
  })
})
