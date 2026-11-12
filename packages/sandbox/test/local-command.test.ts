// ctx.local.run (docs/sandbox.md): the declared program only, no shell, re-checked before each run,
// an empty environment, a fresh working folder, and on macOS a Seatbelt profile around it.

import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandProfile, forbiddenUnderHome, localRun } from '../src/local/command'

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'allowed',
    (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
  )
const mac = process.platform === 'darwin'
const home = homedir()

describe('running a declared program', () => {
  it('passes arguments without a shell, in an empty environment and a fresh folder', async () => {
    const run = localRun({ programs: ['/usr/bin/printf'], home, withoutSeatbelt: !mac })
    const result = await run(['%s|%s', '$HOME', '; echo hi'])
    expect(result).toEqual({ exitCode: 0, stdout: '$HOME|; echo hi', stderr: '' })
    const env = await localRun({
      programs: ['/usr/bin/env'],
      home,
      withoutSeatbelt: true,
      allowUserWritable: true,
    })
      .call(null, [])
      .catch((e: { errorClass?: string }) => e.errorClass)
    // env is forbidden as a program (it runs others), whatever is declared.
    expect(env).toBe('denied-path')
  })

  it('returns a failing exit code as a result, and stdin goes in', async () => {
    const run = localRun({ programs: ['/bin/cat'], home, withoutSeatbelt: !mac })
    expect(await run([], { stdin: 'piped' })).toEqual({ exitCode: 0, stdout: 'piped', stderr: '' })
    const fail = localRun({ programs: ['/bin/ls'], home, withoutSeatbelt: !mac })
    expect((await fail(['/no/such/place'])).exitCode).not.toBe(0)
  })

  it('refuses a program it doesn’t declare, a shell, and one that has become a link to a shell', async () => {
    const run = localRun({ programs: ['/bin/cat'], home, withoutSeatbelt: true })
    expect(await refusal(run([], { program: '/bin/ls' }))).toBe('tool-run/not-granted')
    expect(await refusal(localRun({ programs: ['/bin/sh'], home, withoutSeatbelt: true })([]))).toBe(
      'tool-run/denied-path',
    )
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'valet-prog-')))
    try {
      await symlink('/bin/sh', join(dir, 'innocent'))
      const linked = localRun({
        programs: [join(dir, 'innocent')],
        home,
        withoutSeatbelt: true,
        allowUserWritable: true,
      })
      expect(await refusal(linked(['-c', 'echo pwned']))).toBe('tool-run/denied-path')
      await writeFile(join(dir, 'tool'), '#!/bin/sh\necho hi\n')
      await chmod(join(dir, 'tool'), 0o755)
      // A program in a folder the person can write to could be swapped: refused by the real rule.
      expect(
        await refusal(localRun({ programs: [join(dir, 'tool')], home, withoutSeatbelt: true })([])),
      ).toBe('tool-run/denied-path')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses bad arguments, and runs nothing without Seatbelt off macOS', async () => {
    const run = localRun({ programs: ['/bin/cat'], home, withoutSeatbelt: true })
    expect(await refusal(run('x' as never))).toBe('tool-run/invalid')
    expect(await refusal(run([1] as never))).toBe('tool-run/invalid')
    expect(await refusal(run(['a\0b']))).toBe('tool-run/invalid')
    expect(await refusal(run(Array.from({ length: 101 }, () => 'a')))).toBe('tool-run/invalid')
    expect(await refusal(localRun({ programs: [], home })([]))).toBe('tool-run/not-granted')
    expect(await refusal(localRun({ programs: ['/bin/cat'], home, platform: 'linux' })([]))).toBe(
      'tool-run/unavailable',
    )
  })

  it('stops a program at its deadline', async () => {
    const run = localRun({ programs: ['/bin/sleep'], home, withoutSeatbelt: !mac, timeoutMs: 200 })
    expect(await refusal(run(['10']))).toBe('tool-run/condition-timeout')
  })
})

describe('the Seatbelt profile', () => {
  it('denies network, Apple Events, other programs, writes outside its folder and every forbidden place', async () => {
    const forbidden = await forbiddenUnderHome('/Users/tess')
    expect(forbidden).toContain('/Users/tess/.ssh')
    expect(forbidden).toContain('/Users/tess/Library/Application Support/Valet')
    expect(forbidden.some((f) => f.startsWith('/System'))).toBe(false)
    const profile = commandProfile('/usr/bin/sips', '/private/tmp/valet-run-1', [
      '/Users/tess/.ssh',
      '/Users/a "b',
    ])
    expect(profile).toContain('(deny network*)')
    expect(profile).toContain('(deny appleevent-send)')
    expect(profile).toContain('(allow process-exec (literal "/usr/bin/sips"))')
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/valet-run-1")')
    expect(profile).toContain('(subpath "/Users/a \\"b")')
  })

  it("denies the system keychains, external volumes and other users' folders, but not the home", () => {
    const profile = commandProfile(
      '/usr/bin/sips',
      '/private/tmp/valet-run-1',
      ['/Users/tess/.ssh'],
      '/Users/tess/',
    )
    const lines = profile.split('\n')
    expect(profile).toContain('(subpath "/Library/Keychains")')
    expect(profile).toContain('(subpath "/Volumes")')
    const usersDenied = lines.indexOf('(deny file-read* (subpath "/Users"))')
    const homeAllowed = lines.indexOf('(allow file-read* (literal "/Users") (subpath "/Users/tess"))')
    const forbiddenDenied = lines.findIndex((l) => l.includes('(subpath "/Users/tess/.ssh")'))
    // Last match wins: the home's forbidden places stay denied after the home is allowed.
    expect(usersDenied).toBeGreaterThan(-1)
    expect(homeAllowed).toBeGreaterThan(usersDenied)
    expect(forbiddenDenied).toBeGreaterThan(homeAllowed)
    expect(commandProfile('/usr/bin/sips', '/w', [])).not.toContain('"/Users"')
  })

  it.runIf(mac)('reads the home but not the system keychains (macOS)', async () => {
    const probe = join(home, '.valet-seatbelt-home-probe')
    await writeFile(probe, 'home ok')
    try {
      const cat = localRun({ programs: ['/bin/cat'], home })
      expect(await cat([probe])).toMatchObject({ exitCode: 0, stdout: 'home ok' })
      const keychain = await cat(['/Library/Keychains/System.keychain'])
      expect(keychain.exitCode).not.toBe(0)
      expect(keychain.stdout).toBe('')
    } finally {
      await rm(probe, { force: true })
    }
  })

  it.runIf(mac)(
    'keeps a declared program out of the forbidden places and off the network (macOS)',
    async () => {
      await writeFile(join(home, '.ssh-valet-test-probe'), 'x').catch(() => {})
      const cat = localRun({ programs: ['/bin/cat'], home })
      const ssh = join(home, '.ssh/known_hosts')
      const read = await cat([ssh])
      // Either no such file, or Seatbelt refused it: never its contents.
      expect(read.exitCode).not.toBe(0)
      const curl = localRun({ programs: ['/usr/bin/nc'], home })
      expect(await refusal(curl(['-z', '1.1.1.1', '443']))).toMatch(/denied-path|allowed/)
      const cp = localRun({ programs: ['/bin/cp'], home })
      const out = await cp(['/etc/hosts', join(home, 'Documents/valet-seatbelt-probe')])
      expect(out.exitCode).not.toBe(0)
      await rm(join(home, '.ssh-valet-test-probe'), { force: true })
    },
  )
})
