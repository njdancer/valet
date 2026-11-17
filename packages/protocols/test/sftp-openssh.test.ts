// ctx.sftp against OpenSSH's own sftp-server (where the system has one: macOS always does), behind
// the fake's SSH server: the real server's REALPATH, links, renames and errors, not a fake's idea
// of them. Paths are real paths under a temporary folder.

import { readFile, symlink } from 'node:fs/promises'
import { type FakeSftp, OPENSSH_SFTP_SERVER } from '@valet/fake-sftp'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeSftp, roots, signedIn } from './sftp-helpers'

let server: FakeSftp | null = null
let close: (() => void) | null = null
afterEach(async () => {
  close?.()
  close = null
  await server?.close()
  server = null
})

async function session(purpose: 'read' | 'write' | 'irreversible') {
  server = await fakeSftp({ mode: 'openssh' })
  const s = await signedIn(server, purpose, roots(server))
  close = s.close
  return { ...s, server, p: server.path }
}

describe.runIf(OPENSSH_SFTP_SERVER !== undefined)('OpenSSH’s sftp-server', () => {
  it('lists and reads', async () => {
    const { ops, p } = await session('read')
    const listed = (await ops.run('list', [p('/docs')])) as { entries: { name: string }[] }
    expect(listed.entries.map((e) => e.name)).toEqual(['notes', 'readme.txt'])
    expect(await ops.run('read', [p('/docs/readme.txt'), { encoding: 'utf8' }])).toMatchObject({
      text: 'Hello from the NAS.\n',
    })
    // The server's own log says what it was asked: Valet's few requests, nothing else.
    const types = new Set(server?.requests.map((r) => r.type))
    expect(types.has('REALPATH')).toBe(true)
    for (const never of ['SETSTAT', 'FSETSTAT', 'SYMLINK', 'READLINK', 'EXTENDED']) expect(types.has(never)).toBe(false)
  })

  it('follows links inside the roots, and refuses links out, by its own REALPATH', async () => {
    const { ops, server, p } = await session('read')
    await symlink('readme.txt', server.at(p('/docs/inside')))
    await symlink('../private', server.at(p('/docs/out')))
    await symlink('/etc', server.at(p('/docs/etc')))
    expect(await ops.run('stat', [p('/docs/inside')])).toMatchObject({ type: 'file' })
    await expect(ops.run('read', [p('/docs/out/secret.txt')])).rejects.toMatchObject({ failure: 'not-allowed' })
    await expect(ops.run('list', [p('/docs/etc')])).rejects.toMatchObject({ failure: 'not-allowed' })
    await expect(ops.run('read', [p('/docs/etc/passwd')])).rejects.toMatchObject({ failure: 'not-allowed' })
  })

  it('creates, appends, renames and removes as the roots allow', async () => {
    const { ops, server, p } = await session('irreversible')
    await ops.run('write', [p('/inbox/a.txt'), 'one\n'])
    await ops.run('write', [p('/inbox/a.txt'), 'two\n', { mode: 'append' }])
    expect(await readFile(server.at(p('/inbox/a.txt')), 'utf8')).toBe('one\ntwo\n')
    await expect(ops.run('write', [p('/inbox/a.txt'), 'x'])).rejects.toMatchObject({ code: 'ALREADYEXISTS' })
    await ops.run('rename', [p('/inbox/a.txt'), p('/scratch/a.txt')])
    await ops.run('write', [p('/scratch/a.txt'), 'new', { mode: 'replace' }])
    expect(await readFile(server.at(p('/scratch/a.txt')), 'utf8')).toBe('new')
    await ops.run('remove', [p('/scratch/a.txt')])
    await ops.run('mkdir', [p('/scratch/d')])
    await ops.run('removeDir', [p('/scratch/d')])
    await expect(ops.run('remove', [p('/inbox/x')])).rejects.toMatchObject({ failure: 'not-allowed' })
  })

  it('won’t write through a link to a file outside', async () => {
    const { ops, server, p } = await session('irreversible')
    await symlink('../docs/readme.txt', server.at(p('/scratch/link')))
    await expect(ops.run('write', [p('/scratch/link'), 'x', { mode: 'replace' }])).rejects.toMatchObject({
      failure: 'not-allowed',
    })
    await expect(ops.run('write', [p('/scratch/link'), 'x', { mode: 'append' }])).rejects.toMatchObject({
      failure: 'not-allowed',
    })
    expect(await readFile(server.at(p('/docs/readme.txt')), 'utf8')).toBe('Hello from the NAS.\n')
    // Removing the link removes the link alone.
    await ops.run('remove', [p('/scratch/link')])
    expect(await readFile(server.at(p('/docs/readme.txt')), 'utf8')).toBe('Hello from the NAS.\n')
  })
})
