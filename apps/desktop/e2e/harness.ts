// What every e2e spec shares: launching the built app in demo mode against a temporary userData,
// finding its windows by the deterministic titles e2e mode gives them, an MCP client over HTTP with
// the token the app wrote to bridge.json, and the scan for the demo account's secrets.
//
// Nothing here reaches a real site, 1Password, Messages or the Keychain: demo mode runs the fake
// Woolworths in the app's own process, behind a host resolver rule that maps its names (and, in e2e
// mode, the canary host) to 127.0.0.1.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'

const require = createRequire(import.meta.url)
export const electronPath = require('electron') as unknown as string
/** Electron's dist directory: every process of this worktree's Electron has it in its command line. */
export const electronDist = electronPath.slice(0, electronPath.indexOf('/Electron.app/'))
export const appDir = join(import.meta.dirname, '..')
export const repoRoot = join(appDir, '../..')

/**
 * The fake's two-factor account, which demo mode's test provider holds (src/main/core/demo.ts). The
 * values are repeated here so the scan doesn't depend on the app's own module; demoAccountMatches()
 * checks they are still the ones the app uses.
 */
export const DEMO_USERNAME = 'twofactor@example.test'
export const DEMO_PASSWORD = 'fake-password-2'
export const DEMO_OTP = '246810'

export function demoAccountMatches(): boolean {
  const source = readFileSync(join(appDir, 'src/main/core/demo.ts'), 'utf8')
  return (
    source.includes(`username: '${DEMO_USERNAME}'`) &&
    source.includes(`password: '${DEMO_PASSWORD}'`) &&
    source.includes(`otpCode: '${DEMO_OTP}'`)
  )
}

/** Window title markers e2e mode sets (README, "For the end-to-end suite"). */
export const CONTROL = '[control]'

export interface Launched {
  readonly app: ElectronApplication
  /** Everything the main process wrote to stdout and stderr, renderers' console included. */
  readonly logs: string[]
  close(): Promise<void>
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `valet-e2e-${prefix}-`))
}

/** Launches the built app (or a copy of it at `appPath`) in demo and e2e mode on `userData`. */
export async function launch(userData: string, appPath = appDir): Promise<Launched> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('VALET_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [appPath],
    env: { ...env, VALET_DEMO: '1', VALET_E2E: '1', VALET_USER_DATA: userData },
  })
  const logs: string[] = []
  app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)))
  app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)))
  app.on('console', (message) => logs.push(`[console] ${message.text()}`))
  return {
    app,
    logs,
    close: async () => {
      const pid = app.process().pid
      await Promise.race([app.close().catch(() => undefined), sleep(10_000)])
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

/** The first window whose title contains `marker`, waiting up to `timeoutMs` for it to open. */
export async function windowWithTitle(
  app: ElectronApplication,
  marker: string,
  timeoutMs = 20_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (page.isClosed()) continue
      if ((await page.title().catch(() => '')).includes(marker)) return page
    }
    await sleep(100)
  }
  throw new Error(`no window titled with ${marker} opened`)
}

/** The app's own renderer windows (app://renderer pages), not the adapter's auth and tool pages. */
export function appWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((page) => !page.isClosed() && page.url().startsWith('app://renderer/'))
}

export interface BridgeConfig {
  readonly url: string
  readonly token: string
}

export function bridgeConfig(userData: string): BridgeConfig {
  return JSON.parse(readFileSync(join(userData, 'bridge.json'), 'utf8')) as BridgeConfig
}

export type McpClient = InstanceType<typeof Client>

/** A real MCP client over Streamable HTTP, as an HTTP-native agent would connect. */
export async function connectMcp(userData: string, name = 'e2e-agent'): Promise<McpClient> {
  const { url, token } = bridgeConfig(userData)
  const client = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

export interface ToolResult {
  readonly isError: boolean
  readonly text: string
  readonly structured: unknown
  /** The whole result as JSON, for the secret scan. */
  readonly raw: string
}

/** Calls a tool; a protocol-level error (an unknown tool, say) comes back as an error result too. */
export async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 150_000,
): Promise<ToolResult> {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    })
    const content = Array.isArray(result.content) ? result.content : []
    const text = content
      .map((part) => (part !== null && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('\n')
    return {
      isError: result.isError === true,
      text,
      structured: result.structuredContent ?? null,
      raw: JSON.stringify(result),
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { isError: true, text, structured: null, raw: text }
  }
}

/**
 * Throws if `text` holds the demo password, the demo SMS code, or `extra` values (the endpoint
 * token, say). The code is six digits, so hex digests (64 hex digits each: the audit chain's hashes)
 * are taken out before looking for it; a hash containing 246810 by chance would otherwise fail.
 */
export function secretsIn(text: string, extra: readonly string[] = []): string[] {
  const found: string[] = []
  if (text.includes(DEMO_PASSWORD)) found.push('demo password')
  if (text.replace(/[0-9a-f]{64}/gi, '').includes(DEMO_OTP)) found.push('demo SMS code')
  for (const value of extra) if (value.length > 0 && text.includes(value)) found.push('extra value')
  return found
}

/** Every app window's DOM, with every input's current value, as one string. */
export async function renderedText(app: ElectronApplication): Promise<string> {
  const parts: string[] = []
  for (const page of appWindows(app)) {
    parts.push(
      await page
        .evaluate(() => {
          const values = [...document.querySelectorAll('input, textarea, select')].map(
            (e) => (e as HTMLInputElement).value,
          )
          return `${document.documentElement.outerHTML}\n${values.join('\n')}\n${document.title}`
        })
        .catch(() => ''),
    )
  }
  return parts.join('\n')
}

/**
 * A copy of the built app whose Woolworths adapter is a changed bundle: remove_from_cart becomes
 * irreversible, in the compiled manifest and in the embedded source the hash covers alike, as a
 * rebuilt update that asks for more would be. Its hash differs, so the approval and grants made for
 * the built app don't carry to it. The copy lives under out/, which git and Biome ignore.
 */
export function changedAdapterBuild(): string {
  const dir = join(appDir, 'out/e2e-changed-adapter')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(appDir, 'out/main'), join(dir, 'out/main'), { recursive: true })
  cpSync(join(appDir, 'out/preload'), join(dir, 'out/preload'), { recursive: true })
  cpSync(join(appDir, 'out/renderer'), join(dir, 'out/renderer'), { recursive: true })
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: pkg['name'], version: pkg['version'], type: 'module', main: pkg['main'] }),
  )
  const bundlePath = join(dir, 'out/main/index.js')
  let bundle = readFileSync(bundlePath, 'utf8')
  const compiled =
    'name: "remove_from_cart",\n\t\t\t\ttitle: "Remove from cart",\n\t\t\t\tdescription: "Removes a product from the cart entirely.",\n\t\t\t\tsideEffect: "write"'
  const embedded =
    "name: 'remove_from_cart',\\n        title: 'Remove from cart',\\n        description: 'Removes a product from the cart entirely.',\\n        sideEffect: 'write',"
  for (const [from, label] of [
    [compiled, 'compiled manifest'],
    [embedded, 'embedded source'],
  ] as const) {
    const at = bundle.indexOf(from)
    if (at === -1 || bundle.indexOf(from, at + 1) !== -1)
      throw new Error(`the ${label} of remove_from_cart isn't in the bundle exactly once; rebuild?`)
  }
  bundle = bundle
    .replace(compiled, compiled.replace('sideEffect: "write"', 'sideEffect: "irreversible"'))
    .replace(embedded, embedded.replace("sideEffect: 'write'", "sideEffect: 'irreversible'"))
  writeFileSync(bundlePath, bundle)
  return dir
}

/** The demo's e2e hook in the main process (src/main/electron/demo.ts, exposeToE2e). */
interface DemoHook {
  blockAll(on: boolean): void
  trolley(): readonly { readonly stockcode: number; readonly quantity: number }[]
}

/** Makes the fake site answer every request with its Access Denied page, or stop. */
export async function blockSite(launched: Launched, on: boolean): Promise<void> {
  await launched.app.evaluate((_electron, on) => {
    const hook = (globalThis as { __valetE2e?: DemoHook }).__valetE2e
    if (hook === undefined) throw new Error('no e2e hook: not a demo build in e2e mode')
    hook.blockAll(on)
  }, on)
}

/** The demo account's trolley as the fake site holds it. */
export async function siteTrolley(
  launched: Launched,
): Promise<{ readonly stockcode: number; readonly quantity: number }[]> {
  return launched.app.evaluate(() => {
    const hook = (globalThis as { __valetE2e?: DemoHook }).__valetE2e
    if (hook === undefined) throw new Error('no e2e hook: not a demo build in e2e mode')
    return [...hook.trolley()]
  })
}

/** Kills any process still running this worktree's Electron (never another app's). */
export function killStrayElectron(): void {
  try {
    execFileSync('pkill', ['-f', electronDist], { stdio: 'ignore' })
  } catch {
    // Nothing matched.
  }
}

/** Process ids still running this worktree's Electron. */
export function strayElectron(): string[] {
  try {
    return execFileSync('pgrep', ['-f', electronDist], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}
