// Watching a response body for its end. The SDK reads each response stream itself and says nothing
// when one closes without the answer it was opened for, so the bridge reads through this copy.

/** A copy of `body` that calls `onEnd` once, when it finishes, fails or is cancelled. */
export function onStreamEnd(body: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    onEnd()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          end()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        controller.error(error)
        end()
      }
    },
    async cancel(reason) {
      end()
      await reader.cancel(reason)
    },
  })
}
