// Red team (cross-kind network boundaries, 2026-11-17). STATIC ONLY: Seatbelt can't run off macOS,
// so this checks the generated text. Each `it` states what SHOULD hold.
//
// XK-4: the only network rule a raw adapter's (and the protocol host's) process gets is
// `(allow network-outbound (remote ip "localhost:PORT"))`. In SBPL `ip` is any IP protocol and
// `localhost` is either loopback, so the rule also lets the process:
//   - send UDP datagrams to 127.0.0.1:PORT and [::1]:PORT, where PORT is the tunnel's number but the
//     receiver is whatever UDP socket holds that number (an ephemeral resolver or client socket of
//     another process: mDNSResponder and friends draw from the same range);
//   - connect over TCP to [::1]:PORT, a different socket from the broker's 127.0.0.1 listener
//     (docs/adapter-kinds.md lists this one as "unverified on macOS").
// The tunnels are TCP on 127.0.0.1 only, so `(remote tcp4 "localhost:PORT")` says exactly that.
// profile.test.ts's macOS probe sends its UDP to port 53 and its IPv6 to another port, never to the
// tunnel's own number, so it can't see either.

import { describe, expect, it } from 'vitest'
import { nodeRuntimeProfile } from '../src/profile'

describe('XK-4 the tunnel rule names TCP over IPv4 only', () => {
  it('allows no UDP and no IPv6 to the tunnel’s port number', () => {
    const profile = nodeRuntimeProfile({
      nodeBinary: '/Applications/Valet.app/Contents/MacOS/valet-node',
      hostScript: '/Applications/Valet.app/Contents/Resources/runtime-host.cjs',
      tempDir: '/private/var/folders/xy/T/valet-node-abc',
      tunnelPorts: [50123],
      forbidden: [],
    })
    const network = profile.split('\n').filter((l) => l.includes('network'))
    expect(network).toEqual(['(allow network-outbound (remote tcp4 "localhost:50123"))'])
    // And the socket rule then needs AF_INET only.
    expect(profile).not.toContain('AF_INET6')
  })
})
