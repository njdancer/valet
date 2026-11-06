import { describe, expect, it } from 'vitest'
import { onStreamEnd } from '../src/stream-end'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) text += decoder.decode(chunk)
  return text
}

describe('onStreamEnd', () => {
  it('passes every chunk through and reports the end once', async () => {
    let ends = 0
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('data: a\n\n'))
        controller.enqueue(bytes('data: b\n\n'))
        controller.close()
      },
    })

    const text = await readAll(
      onStreamEnd(source, () => {
        ends++
      }),
    )

    expect(text).toBe('data: a\n\ndata: b\n\n')
    expect(ends).toBe(1)
  })

  it('reports a stream that fails, such as a connection reset', async () => {
    let ends = 0
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('ECONNRESET'))
      },
    })
    const watched = onStreamEnd(source, () => {
      ends++
    })

    await expect(readAll(watched)).rejects.toThrow('ECONNRESET')
    expect(ends).toBe(1)
  })

  it('reports a stream its reader cancels, and cancels the source', async () => {
    let ends = 0
    let sourceCancelled = false
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {})
      },
      cancel() {
        sourceCancelled = true
      },
    })
    const reader = onStreamEnd(source, () => {
      ends++
    }).getReader()

    const read = reader.read()
    await reader.cancel()

    expect(await read).toEqual({ done: true, value: undefined })
    expect(sourceCancelled).toBe(true)
    expect(ends).toBe(1)
  })
})
