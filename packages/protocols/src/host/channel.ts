// The protocol hosts' channel to Valet: file descriptor 3, newline-separated JSON both ways. The
// first message must be `boot`; every later one is handed to `handle` in order, one at a time. A
// line that isn't JSON, or anything before boot, ends the process: Valet never sends either.

import { Socket } from 'node:net'

const MAX_LINE = 4_100_000

export interface HostChannel {
  /** Sends one message to Valet. Never throws. */
  post(message: object): void
}

/**
 * Serves the channel: `onBoot` is called with the boot message (and the host replies `ready`),
 * then `handle` with each message after it. Returns the channel for replies.
 */
export function serveChannel<Boot>(
  onBoot: (boot: Boot) => void,
  handle: (message: Record<string, unknown>) => Promise<void>,
): HostChannel {
  const channel = new Socket({ fd: 3, readable: true, writable: true })
  channel.setEncoding('utf8')
  const post = (message: object) => {
    try {
      channel.write(`${JSON.stringify(message)}\n`)
    } catch {}
  }
  let booted = false
  let busy = Promise.resolve()
  let buffer = ''
  channel.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > MAX_LINE) process.exit(1)
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        process.exit(1)
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) process.exit(1)
      if (!booted) {
        if (message['t'] !== 'boot') process.exit(1)
        booted = true
        onBoot(message as unknown as Boot)
        post({ t: 'ready' })
      } else {
        busy = busy.then(() => handle(message))
      }
      index = buffer.indexOf('\n')
    }
  })
  channel.on('end', () => process.exit(0))
  channel.on('error', () => process.exit(1))
  return { post }
}
