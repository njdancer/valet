// Red-team inspection of the Seatbelt profile a `command` exception runs under. Seatbelt can't run
// on Linux, so this reasons from the generated profile text. The first pass found the profile left
// the system keychains, other users' folders and /Volumes readable; this pins the fix.

import { describe, expect, it } from 'vitest'
import { commandProfile, forbiddenUnderHome } from '../../src/local/command'

describe('probe: command Seatbelt read-deny coverage', () => {
  it("denies the home's never-grantable places, the system keychains, other users and /Volumes", async () => {
    const home = '/Users/tess'
    const forbidden = await forbiddenUnderHome(home)
    const profile = commandProfile('/bin/cat', '/private/tmp/valet-run-1', forbidden, home)

    expect(profile).toContain('(subpath "/Users/tess/.ssh")')
    expect(profile).toContain('(subpath "/Library/Keychains")')
    expect(profile).toContain('(subpath "/Volumes")')
    // Every other user's folder: /Users is denied, and only the person's own home allowed back.
    expect(profile).toContain('(deny file-read* (subpath "/Users"))')
    expect(profile).toContain('(subpath "/Users/tess"))')
    expect(profile).not.toContain('(subpath "/Users/otheruser")')
  })
})
