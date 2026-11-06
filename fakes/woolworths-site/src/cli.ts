// Runs the fake standalone for manual development: `pnpm --filter @siteadapter/fake-woolworths-site start`.
// Plain HTTP on a fixed port by default, and the auth origin on the next one; pass --port 0 for
// any free ports.

import { pathToFileURL } from 'node:url'
import type { FakeAccount } from './accounts'
import { type FakeWoolworths, type FakeWoolworthsOptions, startFakeWoolworths } from './server'

export const DEV_ACCOUNTS: readonly FakeAccount[] = [
  { username: 'shopper@example.test', password: 'fake-password-1', firstName: 'Sam' },
  {
    username: 'twofactor@example.test',
    password: 'fake-password-2',
    otpCode: '246810',
    mfa: 'sms',
    firstName: 'Tess',
  },
]

export const DEFAULT_PORT = 8417

export function parsePort(argv: readonly string[]): number {
  const index = argv.indexOf('--port')
  if (index === -1) return DEFAULT_PORT
  const port = Number(argv[index + 1])
  if (!Number.isInteger(port) || port < 0 || port > 65_534) throw new Error('--port takes 0-65534')
  return port
}

export interface CliDeps {
  readonly print: (line: string) => void
  readonly start?: (options: FakeWoolworthsOptions) => Promise<FakeWoolworths>
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<FakeWoolworths> {
  const start = deps.start ?? startFakeWoolworths
  const port = parsePort(argv)
  const site = await start({ accounts: DEV_ACCOUNTS, port, authPort: port === 0 ? 0 : port + 1 })
  deps.print(`fake Woolworths at ${site.origin}, signing in at ${site.authOrigin}`)
  for (const account of DEV_ACCOUNTS) {
    const otp = account.otpCode === undefined ? '' : `, ${account.mfa ?? 'sms'} code ${account.otpCode}`
    deps.print(`  ${account.username} / ${account.password}${otp}`)
  }
  return site
}

/* v8 ignore start */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const site = await main(process.argv.slice(2), { print: (line) => console.log(line) })
  process.once('SIGINT', () => void site.close())
  process.once('SIGTERM', () => void site.close())
}
/* v8 ignore stop */
