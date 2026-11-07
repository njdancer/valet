import { afterEach, describe, expect, it, vi } from 'vitest'
import { helperEnv, nodeSpawner, nodeTimers, runProcess } from '../src/process'
import { FakeChild, ManualTimers, scriptedSpawner } from './fake-process'

const options = { timeoutMs: 1000, maxStdoutBytes: 64, timers: new ManualTimers() }

describe('runProcess', () => {
  it('returns exit code, stdout bytes and stderr text', async () => {
    const { spawner, calls } = scriptedSpawner((child) => child.finish(3, 'out', 'err'))
    const outcome = await runProcess(spawner, 'tool', ['a', 'b'], options)
    expect(outcome).toEqual({ kind: 'exited', code: 3, stdout: Buffer.from('out'), stderr: 'err' })
    expect(calls[0]?.command).toBe('tool')
    expect(calls[0]?.args).toEqual(['a', 'b'])
  })

  it('concatenates stdout chunks and zeroes the chunks it copied from', async () => {
    const first = Buffer.from('ab')
    const second = Buffer.from('cd')
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', first)
        child.stdout.emit('data', second)
        child.emit('close', 0)
      })
    })
    const outcome = await runProcess(spawner, 'tool', [], options)
    expect(outcome.kind === 'exited' && outcome.stdout.toString()).toBe('abcd')
    expect([...first, ...second].every((byte) => byte === 0)).toBe(true)
  })

  it('reports a missing binary when the error event says ENOENT', async () => {
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })),
      )
    })
    expect(await runProcess(spawner, 'op', [], options)).toEqual({ kind: 'missing' })
  })

  it('reports a missing binary when the spawner throws ENOENT', async () => {
    const spawner = () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    }
    expect(await runProcess(spawner, 'op', [], options)).toEqual({ kind: 'missing' })
  })

  it('reports failure when the spawner throws anything else', async () => {
    const spawner = () => {
      throw new Error('EACCES')
    }
    expect(await runProcess(spawner, 'op', [], options)).toEqual({ kind: 'failed' })
  })

  it('reports failure for other spawn errors and ignores the close that follows', async () => {
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }))
        child.emit('close', 0)
      })
    })
    expect(await runProcess(spawner, 'op', [], options)).toEqual({ kind: 'failed' })
  })

  it('kills a hung process at the timeout and zeroes what it had written', async () => {
    const timers = new ManualTimers()
    const partial = Buffer.from('half-a-secret')
    let child: FakeChild | undefined
    const { spawner } = scriptedSpawner((c) => {
      child = c
      queueMicrotask(() => c.stdout.emit('data', partial))
    })
    const running = runProcess(spawner, 'op', [], { ...options, timers })
    await Promise.resolve()
    expect([...timers.pending.values()][0]?.ms).toBe(1000)
    timers.fireAll()
    expect(await running).toEqual({ kind: 'timed-out' })
    expect(child?.kills).toEqual(['SIGKILL'])
    expect([...partial].every((byte) => byte === 0)).toBe(true)
  })

  it('zeroes stdout that arrives after it has given up', async () => {
    const timers = new ManualTimers()
    let child: FakeChild | undefined
    const { spawner } = scriptedSpawner((c) => {
      child = c
    })
    const running = runProcess(spawner, 'op', [], { ...options, timers })
    timers.fireAll()
    await running
    const late = Buffer.from('late-secret')
    child?.stdout.emit('data', late)
    child?.emit('close', 0)
    expect([...late].every((byte) => byte === 0)).toBe(true)
  })

  it('kills a process whose output exceeds the limit and zeroes it', async () => {
    const big = Buffer.alloc(65, 0x41)
    let child: FakeChild | undefined
    const { spawner } = scriptedSpawner((c) => {
      child = c
      queueMicrotask(() => c.stdout.emit('data', big))
    })
    expect(await runProcess(spawner, 'op', [], options)).toEqual({ kind: 'failed' })
    expect(child?.kills).toEqual(['SIGKILL'])
    expect([...big].every((byte) => byte === 0)).toBe(true)
  })

  it('clears its timer once the process exits', async () => {
    const timers = new ManualTimers()
    const { spawner } = scriptedSpawner((child) => child.finish(0, 'x'))
    await runProcess(spawner, 'op', [], { ...options, timers })
    expect(timers.pending.size).toBe(0)
  })

  it('keeps only the first 8 KiB of stderr', async () => {
    const { spawner } = scriptedSpawner((child) => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.alloc(8 * 1024 - 1, 0x61))
        child.stderr.emit('data', Buffer.from('bcd'))
        child.stderr.emit('data', Buffer.from('efg'))
        child.emit('close', 1)
      })
    })
    const outcome = await runProcess(spawner, 'op', [], options)
    expect(outcome.kind === 'exited' && outcome.stderr.length).toBe(8 * 1024)
  })

  it('tolerates a child with no stdio pipes', async () => {
    const spawner = () => {
      const child = new FakeChild()
      queueMicrotask(() => child.emit('close', 0))
      return Object.assign(child, { stdout: null, stderr: null })
    }
    const outcome = await runProcess(spawner, 'op', [], options)
    expect(outcome).toEqual({ kind: 'exited', code: 0, stdout: Buffer.alloc(0), stderr: '' })
  })
})

describe('helperEnv', () => {
  it('passes through only what a helper needs, and fixes the locale', () => {
    const parent = {
      HOME: '/Users/p',
      USER: 'p',
      LOGNAME: 'p',
      PATH: '/opt/homebrew/bin:/usr/bin',
      TMPDIR: '/tmp/x',
      LANG: 'de_DE.UTF-8',
      OP_SERVICE_ACCOUNT_TOKEN: 'ops_canary',
      OP_CONNECT_HOST: 'https://connect.example',
      OP_CONNECT_TOKEN: 'canary',
      OP_SESSION_my: 'canary',
      OP_ACCOUNT: 'my.1password.com',
      NODE_OPTIONS: '--require /tmp/evil.js',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
    }
    expect(helperEnv(parent)).toEqual({
      HOME: '/Users/p',
      USER: 'p',
      LOGNAME: 'p',
      PATH: '/opt/homebrew/bin:/usr/bin',
      TMPDIR: '/tmp/x',
      LANG: 'C',
      LC_ALL: 'C',
    })
  })

  it('leaves out variables the parent does not have', () => {
    expect(helperEnv({ HOME: '/Users/p' })).toEqual({ HOME: '/Users/p', LANG: 'C', LC_ALL: 'C' })
  })
})

describe('nodeSpawner', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not hand 1Password credentials from its own environment to the helper', async () => {
    vi.stubEnv('OP_SERVICE_ACCOUNT_TOKEN', 'ops_canary-env-token')
    vi.stubEnv('OP_SESSION_my', 'canary-session')
    const outcome = await runProcess(
      nodeSpawner,
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
      { timeoutMs: 10_000, maxStdoutBytes: 4096, timers: nodeTimers },
    )
    expect(outcome.kind).toBe('exited')
    const names = JSON.parse(outcome.kind === 'exited' ? outcome.stdout.toString() : '[]') as string[]
    expect(names.filter((name) => name.startsWith('OP_'))).toEqual([])
    expect(names).toContain('LC_ALL')
  })

  it('runs a real process without a shell and captures its output', async () => {
    const outcome = await runProcess(
      nodeSpawner,
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("e"); process.exit(4)', '$HOME;x'],
      { timeoutMs: 10_000, maxStdoutBytes: 1024, timers: nodeTimers },
    )
    // The argument arrives verbatim: no shell expanded $HOME or split on ";".
    expect(outcome).toEqual({ kind: 'exited', code: 4, stdout: Buffer.from('$HOME;x'), stderr: 'e' })
  })

  it('reports a binary that does not exist as missing', async () => {
    const outcome = await runProcess(nodeSpawner, '/nonexistent/valet-op', [], {
      timeoutMs: 10_000,
      maxStdoutBytes: 1024,
      timers: nodeTimers,
    })
    expect(outcome).toEqual({ kind: 'missing' })
  })

  it('kills a real process that outlives the timeout', async () => {
    const outcome = await runProcess(nodeSpawner, process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 200,
      maxStdoutBytes: 1024,
      timers: nodeTimers,
    })
    expect(outcome).toEqual({ kind: 'timed-out' })
  })
})
