// What every e2e spec shares: launching the built app in demo mode against a temporary userData,
// finding its windows by the deterministic titles e2e mode gives them, an MCP client over HTTP with
// the client tokens the app wrote to client-configs/, and the scan for the demo account's secrets.
//
// Nothing here reaches a real site, 1Password, Messages or the Keychain: demo mode runs the fake
// Woolworths in the app's own process, behind a host resolver rule that maps its names (and, in e2e
// mode, the canary host) to 127.0.0.1.

import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'

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

/**
 * Launches the built app (or a copy of it at `appPath`) in demo and e2e mode on `userData`. First-run
 * setup stays closed unless `setup` asks for it (VALET_E2E_SETUP), so the other specs start on the
 * adapters page.
 */
export async function launch(
  userData: string,
  appPath = appDir,
  options: { readonly setup?: boolean } = {},
): Promise<Launched> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('VALET_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  }
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [appPath],
    env: {
      ...env,
      VALET_DEMO: '1',
      VALET_E2E: '1',
      VALET_USER_DATA: userData,
      ...(options.setup === true ? { VALET_E2E_SETUP: '1' } : {}),
    },
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

const CLIENT_CONFIGS = 'client-configs'

/** The bridge config file the app wrote for one client (D42): its URL and that client's token. */
export function clientConfig(userData: string, clientId: string): BridgeConfig {
  return JSON.parse(readFileSync(join(userData, CLIENT_CONFIGS, `${clientId}.json`), 'utf8')) as BridgeConfig
}

/** Every client token the app has written, for the secret scans. */
export function clientTokens(userData: string): string[] {
  const dir = join(userData, CLIENT_CONFIGS)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => clientConfig(userData, name.slice(0, -'.json'.length)).token)
}

export type McpClient = InstanceType<typeof Client>

/**
 * A real MCP client over Streamable HTTP, as an HTTP-native agent would connect, with its own token:
 * the client called `name` is added in the app (through the control panel's API) unless it already
 * is, and its token read from the config file the app wrote for it.
 */
export async function connectMcp(control: Page, userData: string, name = 'e2e-agent'): Promise<McpClient> {
  const listed = await control.evaluate(() => window.valet?.clients.list())
  let id = listed?.find((c) => c.name === name && c.revokedAt === null)?.id
  if (id === undefined) id = (await control.evaluate((n) => window.valet?.clients.add(n), name))?.id
  if (id === undefined) throw new Error('could not add an MCP client')
  const { url, token } = clientConfig(userData, id)
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

/**
 * Calls a tool as the server's instructions tell an agent to. A call that has to log in first is
 * answered early (D50): "logging in, call it again in N seconds". This waits and calls again, also
 * through "earlier calls are still running" while the login holds the adapter's turn, and returns
 * the first result that is neither. A call that never started a login is made once.
 */
export async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 270_000,
): Promise<ToolResult> {
  const deadline = Date.now() + timeoutMs
  let result = await callToolOnce(client, name, args, timeoutMs)
  if (!LOGGING_IN.test(result.text)) return result
  while ((LOGGING_IN.test(result.text) || BUSY.test(result.text)) && Date.now() < deadline) {
    const seconds = Number(/again in (\d+) seconds/.exec(result.text)?.[1] ?? 10)
    await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 30) * 1000))
    result = await callToolOnce(client, name, args, timeoutMs)
  }
  return result
}

const LOGGING_IN = /stage login: login-in-progress/
const BUSY = /stage tool-run: busy/

/** One call; a protocol-level error (an unknown tool, say) comes back as an error result too. */
export async function callToolOnce(
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
  // The write's C9 hints go too: only a write tool may declare them.
  const compiled =
    'name: "remove_from_cart",\n\t\t\t\ttitle: "Remove from cart",\n\t\t\t\tdescription: "Removes a product from the cart entirely.",\n\t\t\t\tsideEffect: "write",\n\t\t\t\tdestructive: true,\n\t\t\t\tidempotent: true'
  const embedded =
    "name: 'remove_from_cart',\\n        title: 'Remove from cart',\\n        description: 'Removes a product from the cart entirely.',\\n        sideEffect: 'write',\\n        // A second removal finds nothing left to remove.\\n        destructive: true,\\n        idempotent: true,"
  for (const [from, label] of [
    [compiled, 'compiled manifest'],
    [embedded, 'embedded source'],
  ] as const) {
    const at = bundle.indexOf(from)
    if (at === -1 || bundle.indexOf(from, at + 1) !== -1)
      throw new Error(`the ${label} of remove_from_cart isn't in the bundle exactly once; rebuild?`)
  }
  bundle = bundle
    .replace(compiled, compiled.slice(0, compiled.indexOf('sideEffect')).concat('sideEffect: "irreversible"'))
    .replace(
      embedded,
      embedded.slice(0, embedded.indexOf('sideEffect')).concat("sideEffect: 'irreversible',"),
    )
  writeFileSync(bundlePath, bundle)
  return dir
}

/** The demo's e2e hook in the main process (src/main/electron/demo.ts, exposeToE2e). */
interface DemoHook {
  blockAll(on: boolean): void
  trolley(): readonly { readonly stockcode: number; readonly quantity: number }[]
  wrongPassword(on: boolean): void
  passwordPosts(): number
}

/** Logs the demo account out everywhere and makes the fake refuse its password, or stop. */
export async function wrongPassword(launched: Launched, on: boolean): Promise<void> {
  await launched.app.evaluate((_electron, on) => {
    const hook = (globalThis as { __valetE2e?: DemoHook }).__valetE2e
    if (hook === undefined) throw new Error('no e2e hook: not a demo build in e2e mode')
    hook.wrongPassword(on)
  }, on)
}

/** Password form posts the fake's Auth0 has received since launch. */
export async function passwordPosts(launched: Launched): Promise<number> {
  return launched.app.evaluate(() => {
    const hook = (globalThis as { __valetE2e?: DemoHook }).__valetE2e
    if (hook === undefined) throw new Error('no e2e hook: not a demo build in e2e mode')
    return hook.passwordPosts()
  })
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

/**
 * Clicks a button that closes its own window, such as the confirmation panel's Decline or Approve.
 * The click can land and the window close before Playwright's click() returns, which then reports
 * the page as closed; that is the click working. Any other failure, or a page still open, throws.
 */
export async function clickClosing(button: Locator): Promise<void> {
  try {
    await button.click()
  } catch (error) {
    if (!button.page().isClosed()) throw error
  }
}
