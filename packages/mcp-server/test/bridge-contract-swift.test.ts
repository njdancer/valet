// The shared bridge suite against the Swift bridge the app bundles (D60, bridges/swift). It runs
// when VALET_SWIFT_BRIDGE names the built binary, as CI's macOS job sets it; elsewhere it is skipped.

import { describe, it } from 'vitest'
import { bridgeContract } from './bridge-contract'

const binary = process.env['VALET_SWIFT_BRIDGE']

if (binary === undefined || binary === '') {
  describe.skip('the Swift stdio bridge (set VALET_SWIFT_BRIDGE to its binary)', () => {
    it('is not built here', () => {})
  })
} else {
  bridgeContract('Swift', (configPath) => ({ command: binary, args: [configPath] }))
}
