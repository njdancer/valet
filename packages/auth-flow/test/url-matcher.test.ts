import { EventEmitter } from 'node:events'
import { isScreenedPattern, SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { type Timers, type WorkerFactory, type WorkerLike, WorkerUrlMatcher } from '../src/url-matcher'
import { LOGIN_PAGE, manifestWithSteps, world } from './fixtures'

/** A worker that records what it's sent and does nothing until the test makes it emit. */
class FakeWorker extends EventEmitter implements WorkerLike {
  readonly posted: unknown[] = []
  terminations = 0
  unrefs = 0

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  terminate(): Promise<number> {
    this.terminations += 1
    return Promise.resolve(1)
  }

  unref(): void {
    this.unrefs += 1
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

/** Timers that fire only when the test says so. */
class ManualTimers implements Timers {
  readonly pending = new Map<number, { callback: () => void; ms: number }>()
  private next = 0

  setTimeout(callback: () => void, ms: number): unknown {
    this.next += 1
    this.pending.set(this.next, { callback, ms })
    return this.next
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  fireAll(): void {
    const due = [...this.pending.values()]
    this.pending.clear()
    for (const timer of due) timer.callback()
  }
}

/** Lets queued promise callbacks run, so a test can emit once the matcher has posted. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function rejection(promise: Promise<unknown>): Promise<[string, string]> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(SiteAdapterError)
  return [(error as SiteAdapterError).stage, (error as SiteAdapterError).errorClass]
}

/** The polynomial shape core's screen lets through, and a query that makes it take minutes. */
const SLOW_PATTERN = '\\d*\\d*\\d*!'
const SLOW_TEXT = `/login?${'1'.repeat(2000)}`

describe('WorkerUrlMatcher with a real worker', () => {
  it('tests patterns against text, compiling each once and reusing the worker', async () => {
    const matcher = new WorkerUrlMatcher()
    try {
      expect(await matcher.test('^/account$', '/account')).toBe(true)
      expect(await matcher.test('^/account$', '/my/account')).toBe(false)
      expect(await matcher.test('step=otp', '/login?step=otp')).toBe(true)
    } finally {
      matcher.close()
    }
  })

  it('reports a pattern that does not compile as invalid', async () => {
    const matcher = new WorkerUrlMatcher()
    try {
      expect(await rejection(matcher.test('(', 'x'))).toEqual(['auth-step', 'invalid'])
    } finally {
      matcher.close()
    }
  })

  it('stops a polynomial pattern the screen lets through, within a fixed budget, without blocking this thread', async () => {
    // The premise: the screen really does let this through, so only the worker stands in the way.
    expect(isScreenedPattern(SLOW_PATTERN)).toBe(true)
    const matcher = new WorkerUrlMatcher({ timeoutMs: 200 })
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 10)
    const started = Date.now()
    try {
      expect(await rejection(matcher.test(SLOW_PATTERN, SLOW_TEXT))).toEqual(['auth-step', 'invalid'])
      expect(Date.now() - started).toBeLessThan(3_000)
      // This thread kept running while the pattern backtracked.
      expect(ticks).toBeGreaterThan(5)
      // The stuck worker is gone; the next test gets a fresh one.
      expect(await matcher.test('^/login', SLOW_TEXT)).toBe(true)
    } finally {
      clearInterval(ticker)
      matcher.close()
    }
  })
})

describe('runAuthFlow with the default matcher', () => {
  it('ends a flow whose urlRegex backtracks on a long adapter-chosen query as invalid, in bounded time', async () => {
    const w = world()
    // No injected matcher: the flow starts its own worker and closes it.
    w.input.urlMatcher = undefined
    const slowUrl = `${LOGIN_PAGE}?${'1'.repeat(2000)}`
    w.page.site[slowUrl] = {}
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: slowUrl },
      { op: 'waitFor', condition: { urlRegex: SLOW_PATTERN }, timeoutMs: 10_000 },
    ])
    const started = Date.now()
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(w.audit.events.at(-1)).toMatchObject({ type: 'login-finished', errorClass: 'invalid' })
  })

  it('matches an honest pattern in the worker', async () => {
    const w = world()
    w.input.urlMatcher = undefined
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { urlRegex: '^/$' }, timeoutMs: 1000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('leaves a matcher it was given open, for its owner to close', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { urlRegex: '^/$' }, timeoutMs: 1000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.urlMatcher.tests).toEqual([{ pattern: '^/$', text: '/' }])
    expect(w.urlMatcher.closed).toBe(false)
  })
})

describe('WorkerUrlMatcher with a fake worker', () => {
  it('starts one unref-ed worker on the first test and sends it the pattern and text', async () => {
    const timers = new ManualTimers()
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers })
    expect(workers).toHaveLength(0)
    const first = matcher.test('^/a', '/a')
    await settle()
    expect(workers[0]?.posted).toEqual([{ pattern: '^/a', text: '/a' }])
    expect(workers[0]?.unrefs).toBe(1)
    workers[0]?.emit('message', true)
    expect(await first).toBe(true)
    const second = matcher.test('^/a', '/b')
    await settle()
    workers[0]?.emit('message', false)
    expect(await second).toBe(false)
    expect(workers).toHaveLength(1)
    expect(timers.pending.size).toBe(0)
  })

  it('runs tests one at a time, so answers can not cross', async () => {
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
    const first = matcher.test('a', 'a')
    const second = matcher.test('b', 'c')
    await settle()
    expect(workers[0]?.posted).toEqual([{ pattern: 'a', text: 'a' }])
    workers[0]?.emit('message', true)
    expect(await first).toBe(true)
    await settle()
    expect(workers[0]?.posted).toHaveLength(2)
    workers[0]?.emit('message', false)
    expect(await second).toBe(false)
  })

  it('refuses an answer that is not a boolean', async () => {
    const answers: unknown[] = ['failed', 'true', 1, null, { matched: true }]
    for (const answer of answers) {
      const { factory, workers } = fakeFactory()
      const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
      const running = matcher.test('x', 'x')
      await settle()
      workers[0]?.emit('message', answer)
      expect(await rejection(running)).toEqual(['auth-step', 'invalid'])
    }
  })

  it('ignores a message that arrives with no test outstanding', async () => {
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
    const running = matcher.test('x', 'x')
    await settle()
    workers[0]?.emit('message', true)
    workers[0]?.emit('message', false)
    expect(await running).toBe(true)
  })

  it('terminates the worker at the deadline, ignores its late answer, and starts a fresh one next time', async () => {
    const timers = new ManualTimers()
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers, timeoutMs: 250 })
    const running = matcher.test('x', 'x')
    await settle()
    expect([...timers.pending.values()][0]?.ms).toBe(250)
    timers.fireAll()
    expect(await rejection(running)).toEqual(['auth-step', 'invalid'])
    expect(workers[0]?.terminations).toBe(1)
    const next = matcher.test('x', 'x')
    await settle()
    // The old worker's late answer and exit belong to nothing now.
    workers[0]?.emit('message', true)
    workers[0]?.emit('exit', 1)
    workers[1]?.emit('message', false)
    expect(await next).toBe(false)
    expect(workers).toHaveLength(2)
  })

  it('reports a worker error as invalid, and replaces the worker', async () => {
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
    const running = matcher.test('x', 'x')
    await settle()
    workers[0]?.emit('error', new Error('ERR_WORKER_OUT_OF_MEMORY'))
    expect(await rejection(running)).toEqual(['auth-step', 'invalid'])
    const next = matcher.test('x', 'x')
    await settle()
    workers[1]?.emit('message', true)
    expect(await next).toBe(true)
  })

  it('reports a worker that exits without answering as invalid', async () => {
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
    const running = matcher.test('x', 'x')
    await settle()
    workers[0]?.emit('exit', 1)
    workers[0]?.emit('message', true)
    expect(await rejection(running)).toEqual(['auth-step', 'invalid'])
  })

  it('reports a worker that exits between tests only by starting a new one', async () => {
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
    const first = matcher.test('x', 'x')
    await settle()
    workers[0]?.emit('message', true)
    expect(await first).toBe(true)
    workers[0]?.emit('exit', 0)
    const second = matcher.test('x', 'x')
    await settle()
    workers[1]?.emit('message', true)
    expect(await second).toBe(true)
  })

  it('rejects the outstanding test and every later one once closed', async () => {
    const timers = new ManualTimers()
    const { factory, workers } = fakeFactory()
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers })
    const running = matcher.test('x', 'x')
    await settle()
    matcher.close()
    expect(await rejection(running)).toEqual(['auth-step', 'invalid'])
    expect(workers[0]?.terminations).toBe(1)
    expect(timers.pending.size).toBe(0)
    expect(await rejection(matcher.test('x', 'x'))).toEqual(['auth-step', 'internal'])
    expect(workers).toHaveLength(1)
  })

  it('closes cleanly when it never started a worker', () => {
    const { factory, workers } = fakeFactory()
    new WorkerUrlMatcher({ createWorker: factory }).close()
    expect(workers).toHaveLength(0)
  })

  it('tolerates a terminate that rejects', async () => {
    const worker = new FakeWorker()
    worker.terminate = () => Promise.reject(new Error('already gone'))
    const matcher = new WorkerUrlMatcher({ createWorker: () => worker, timers: new ManualTimers() })
    const running = matcher.test('x', 'x')
    await settle()
    worker.emit('message', true)
    expect(await running).toBe(true)
    matcher.close()
  })

  it('reports a worker that cannot start as internal', async () => {
    const factory: WorkerFactory = () => {
      throw new Error('ERR_WORKER_INIT_FAILED')
    }
    const matcher = new WorkerUrlMatcher({ createWorker: factory, timers: new ManualTimers() })
    expect(await rejection(matcher.test('x', 'x'))).toEqual(['auth-step', 'internal'])
  })
})
