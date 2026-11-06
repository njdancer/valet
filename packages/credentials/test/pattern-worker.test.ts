import { EventEmitter } from 'node:events'
import { CredentialError, SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { type WorkerFactory, type WorkerLike, WorkerPatternMatcher } from '../src/pattern-worker'
import { ManualTimers } from './fake-process'

/** A worker that does nothing until the test makes it emit. */
class FakeWorker extends EventEmitter implements WorkerLike {
  terminations = 0

  terminate(): Promise<number> {
    this.terminations += 1
    return Promise.resolve(1)
  }
}

function fakeFactory(): { factory: WorkerFactory; workers: FakeWorker[] } {
  const workers: FakeWorker[] = []
  const factory: WorkerFactory = () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  }
  return { factory, workers }
}

async function invalid(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SiteAdapterError)
  expect([(error as SiteAdapterError).stage, (error as SiteAdapterError).errorClass]).toEqual([
    'otp',
    'invalid',
  ])
}

describe('WorkerPatternMatcher with a real worker', () => {
  it('returns the first capture, or the whole match, or null for each text', async () => {
    const matcher = new WorkerPatternMatcher()
    expect(await matcher.captures('code (\\d+)', ['code 123', 'nothing', 'code 9'])).toEqual([
      '123',
      null,
      '9',
    ])
    expect(await matcher.captures('\\d{3}', ['abc 456 def'])).toEqual(['456'])
  })

  it('reports a pattern that does not compile as invalid', async () => {
    await invalid(new WorkerPatternMatcher().captures('(', ['text']))
  })

  it('terminates a catastrophic pattern at the deadline', async () => {
    const started = Date.now()
    const matcher = new WorkerPatternMatcher({ timeoutMs: 100 })
    await invalid(matcher.captures('^(a+)+$', [`${'a'.repeat(60)}!`]))
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('WorkerPatternMatcher with a fake worker', () => {
  it('passes the pattern and a copy of the texts to the worker', async () => {
    let seen: unknown
    const worker = new FakeWorker()
    const factory: WorkerFactory = (_source, data) => {
      seen = data
      queueMicrotask(() => worker.emit('message', ['1234']))
      return worker
    }
    const texts = ['code 1234']
    const matcher = new WorkerPatternMatcher({ createWorker: factory, timers: new ManualTimers() })
    expect(await matcher.captures('(\\d+)', texts)).toEqual(['1234'])
    expect(seen).toEqual({ pattern: '(\\d+)', texts: ['code 1234'] })
    expect((seen as { texts: unknown }).texts).not.toBe(texts)
  })

  it('terminates the worker and clears the deadline once it answers', async () => {
    const timers = new ManualTimers()
    const { factory, workers } = fakeFactory()
    const running = new WorkerPatternMatcher({ createWorker: factory, timers }).captures('x', ['x'])
    workers[0]?.emit('message', ['x'])
    expect(await running).toEqual(['x'])
    expect(workers[0]?.terminations).toBe(1)
    expect(timers.pending.size).toBe(0)
  })

  it('refuses an answer that is not one capture per text', async () => {
    const answers: unknown[] = ['failed', ['x', 'y'], [1], null, { 0: 'x', length: 1 }]
    for (const answer of answers) {
      const { factory, workers } = fakeFactory()
      const running = new WorkerPatternMatcher({
        createWorker: factory,
        timers: new ManualTimers(),
      }).captures('x', ['x'])
      workers[0]?.emit('message', answer)
      await invalid(running)
    }
  })

  it('reports a worker error as invalid', async () => {
    const { factory, workers } = fakeFactory()
    const running = new WorkerPatternMatcher({ createWorker: factory, timers: new ManualTimers() }).captures(
      'x',
      ['x'],
    )
    workers[0]?.emit('error', new Error('ERR_WORKER_OUT_OF_MEMORY'))
    await invalid(running)
  })

  it('reports a worker that exits without answering as invalid, and ignores what follows', async () => {
    const { factory, workers } = fakeFactory()
    const running = new WorkerPatternMatcher({ createWorker: factory, timers: new ManualTimers() }).captures(
      'x',
      ['x'],
    )
    workers[0]?.emit('exit', 1)
    workers[0]?.emit('message', ['x'])
    await invalid(running)
    expect(workers[0]?.terminations).toBe(1)
  })

  it('terminates the worker at the deadline', async () => {
    const timers = new ManualTimers()
    const { factory, workers } = fakeFactory()
    const running = new WorkerPatternMatcher({ createWorker: factory, timers, timeoutMs: 250 }).captures(
      'x',
      ['x'],
    )
    expect([...timers.pending.values()][0]?.ms).toBe(250)
    timers.fireAll()
    await invalid(running)
    expect(workers[0]?.terminations).toBe(1)
  })

  it('tolerates a terminate that rejects', async () => {
    const worker = new FakeWorker()
    worker.terminate = () => Promise.reject(new Error('already gone'))
    const factory: WorkerFactory = () => {
      queueMicrotask(() => worker.emit('message', ['x']))
      return worker
    }
    const matcher = new WorkerPatternMatcher({ createWorker: factory, timers: new ManualTimers() })
    expect(await matcher.captures('x', ['x'])).toEqual(['x'])
  })

  it('reports a worker that cannot start as unavailable', async () => {
    const factory: WorkerFactory = () => {
      throw new Error('ERR_WORKER_INIT_FAILED')
    }
    const matcher = new WorkerPatternMatcher({ createWorker: factory, timers: new ManualTimers() })
    const error = await matcher.captures('x', ['x']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CredentialError)
    expect((error as CredentialError).failure).toBe('unavailable')
  })
})
