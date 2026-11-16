import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { devHelperPath, HELPER_APPS } from '../../src/main/core/native-helpers'

const BUILD = '/repo/swift-bridge/.build'

describe('development helper paths', () => {
  it('prefers the signed app bundle for the helpers that keep secrets', () => {
    const present = new Set([
      `${BUILD}/apps/Debug/Valet Approver.app/Contents/MacOS/valet-approver`,
      `${BUILD}/debug/valet-approver`,
    ])
    expect(devHelperPath('valet-approver', BUILD, (p) => present.has(p))).toBe(
      `${BUILD}/apps/Debug/Valet Approver.app/Contents/MacOS/valet-approver`,
    )
  })

  it('falls back to the plain binary, and to nothing', () => {
    const present = new Set([`${BUILD}/debug/valet-keychain`, `${BUILD}/debug/valet-messages-helper`])
    expect(devHelperPath('valet-keychain', BUILD, (p) => present.has(p))).toBe(`${BUILD}/debug/valet-keychain`)
    expect(devHelperPath('valet-messages-helper', BUILD, (p) => present.has(p))).toBe(
      `${BUILD}/debug/valet-messages-helper`,
    )
    expect(devHelperPath('valet-approver', BUILD, () => false)).toBeNull()
  })

  it('matches the bundles the helpers project builds', async () => {
    const spec = await readFile(join(import.meta.dirname, '../../../../swift-bridge/apps/project.yml'), 'utf8')
    for (const [executable, bundle] of Object.entries(HELPER_APPS)) {
      const product = bundle.replace(/\.app$/, '')
      expect(spec).toContain(`PRODUCT_NAME: ${product}`)
      expect(spec).toContain(`EXECUTABLE_NAME: ${executable}`)
      expect(spec).toContain(`CFBundleExecutable: ${executable}`)
    }
    // Both helpers share one access group, so the approver and the Keychain helper see one store.
    expect(spec.match(/keychain-access-groups: \["\$\(AppIdentifierPrefix\)me\.dncr\.valet\.dev\.keys"\]/g)).toHaveLength(2)
  })
})
