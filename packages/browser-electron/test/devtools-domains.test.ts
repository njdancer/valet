// Pages can tell when some DevTools domains are enabled on them: Runtime.enable and
// Console.enable leave traces a bot-detection script looks for (D24). The driver attaches the
// debugger only to override the user agent and read storage, so it may send only the commands
// listed here. A new one means reading what a page can see of it, then adding it on purpose.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_DIR = join(import.meta.dirname, '..', 'src')

const ALLOWED = new Set([
  'Target.getTargetInfo',
  'Target.attachToTarget',
  'Target.setAutoAttach',
  'Target.setDiscoverTargets',
  'Emulation.setUserAgentOverride',
  'Network.setUserAgentOverride',
  'DOMStorage.enable',
  // Resumes a target paused on attach; it doesn't enable the Runtime domain.
  'Runtime.runIfWaitingForDebugger',
  // The scratch browser's network log only (watchNetwork): the Network domain runs in the browser
  // process and leaves nothing a page's script can see, unlike Runtime or Console. Never on a tool
  // or auth page.
  'Network.enable',
  'Network.getResponseBody',
])

// A quoted `Domain.method` string: how every command is named, whether passed straight to
// sendCommand or through a helper.
const COMMAND = /['"`]([A-Z][A-Za-z]+\.[a-z][A-Za-z]+)['"`]/g

// Event names the driver listens for are quoted the same way, but aren't commands.
const EVENTS = new Set([
  'Target.attachedToTarget',
  'Target.targetCreated',
  'DOMStorage.domStorageItemAdded',
  'DOMStorage.domStorageItemUpdated',
  'Network.requestWillBeSent',
  'Network.responseReceived',
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

function commandsIn(text: string): string[] {
  return [...text.matchAll(COMMAND)].map((match) => match[1] ?? '').filter((name) => !EVENTS.has(name))
}

describe('DevTools commands the driver sends', () => {
  const sent = new Set(sources(SOURCE_DIR).flatMap((file) => commandsIn(readFileSync(file, 'utf8'))))

  it('finds the commands it knows about, so the scan itself works', () => {
    expect(sent).toContain('Emulation.setUserAgentOverride')
    expect(sent).toContain('DOMStorage.enable')
  })

  it('sends nothing outside the list', () => {
    expect([...sent].filter((name) => !ALLOWED.has(name))).toEqual([])
  })

  it('never enables a domain a page can detect', () => {
    const detectable = [...sent].filter((name) =>
      /^(Runtime|Console|Debugger|Log|Profiler)\.enable$/.test(name),
    )
    expect(detectable).toEqual([])
  })

  it('would catch Runtime.enable sent through a helper', () => {
    expect(commandsIn("await send('Runtime.enable')")).toEqual(['Runtime.enable'])
  })
})
