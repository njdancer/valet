import { describe, expect, it } from 'vitest'
import {
  DEMO_ONEPASSWORD_ACCOUNT,
  DEMO_SERVICE_ACCOUNT_TOKEN,
  DEMO_SHOP_ITEM_ID,
  DEMO_VAULTS,
  DesktopAuth,
  decodeBase32,
  demoOnePassword,
  FAKE_OP_PATH,
  FakeOnePassword,
  type FakeOnePasswordOptions,
  fakeOpSpawner,
  fakeSdk,
  parseReference,
  type publicState,
  runOp,
  startKeyholdApp,
  totp,
} from '../src'

const LOGIN = { username: 'shopper@example.test', password: 'shop-test-password' }
const P = DEMO_VAULTS.personal.id
const SHOP = `op://${P}/${DEMO_SHOP_ITEM_ID}`

function make(
  overrides: Partial<FakeOnePasswordOptions> = {},
  now = () => Date.parse('2026-11-11T00:00:00Z'),
) {
  return new FakeOnePassword(demoOnePassword(LOGIN, { now, ...overrides }))
}

async function approved(fake: FakeOnePassword) {
  fake.autoApprove = true
  return fakeSdk(fake).createClient({
    auth: new DesktopAuth(DEMO_ONEPASSWORD_ACCOUNT.name),
    integrationName: 'valet',
    integrationVersion: '0.0.0',
  })
}

describe('totp', () => {
  it('matches RFC 6238’s SHA-1 test vectors', () => {
    // The RFC's key is ASCII "12345678901234567890"; its 8-digit codes, cut to 6.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    expect(totp(secret, 59_000, { digits: 8 })).toBe('94287082')
    expect(totp(secret, 1_111_111_109_000, { digits: 8 })).toBe('07081804')
    expect(totp(secret, 2_000_000_000_000)).toBe('279037')
  })

  it('refuses a secret that isn’t base32', () => {
    expect(decodeBase32('')).toBeNull()
    expect(decodeBase32('not base32!')).toBeNull()
    expect(() => totp('1111', 0)).toThrow('not a base32 secret')
    expect(decodeBase32('jbsw y3dp ===')?.toString()).toBe('Hello')
  })
})

describe('secret references', () => {
  it('parses vault, item, optional section, field and attribute', () => {
    expect(parseReference(`${SHOP}/password`)).toEqual({
      vault: P,
      item: DEMO_SHOP_ITEM_ID,
      section: null,
      field: 'password',
      attribute: null,
    })
    expect(parseReference('op://v/i/s/one-time password?attribute=totp')).toMatchObject({
      section: 's',
      attribute: 'totp',
    })
    for (const bad of [
      'v/i/f',
      'op://v/i',
      'op://v//f',
      'op://v/i/f?x=1',
      'op://v/i/f?attribute=a?b',
      'op://a/b/c/d/e',
    ]) {
      expect(() => parseReference(bad), bad).toThrow()
    }
  })
})

describe('the fake SDK', () => {
  it('a service account reads only its own vault, by id or title, and its codes', async () => {
    const fake = make()
    const sdk = fakeSdk(fake)
    const client = await sdk.createClient({
      auth: DEMO_SERVICE_ACCOUNT_TOKEN,
      integrationName: 'valet',
      integrationVersion: '0.0.0',
    })
    expect((await client.vaults.list()).map((v) => v.title)).toEqual(['Valet'])
    const [item] = await client.items.list(DEMO_VAULTS.valet.id, {
      type: 'ByState',
      content: { active: true, archived: false },
    })
    expect(item).toMatchObject({ title: 'Woolworths', state: 'active', category: 'Login' })
    expect(item?.updatedAt).toBeInstanceOf(Date)
    expect(await client.secrets.resolve(`op://Valet/${item?.id}/username`)).toBe(LOGIN.username)
    await expect(client.secrets.resolve(`${SHOP}/password`)).rejects.toThrow('no vault matched')
    await expect(client.items.list(P)).rejects.toThrow('resource not found')
    await expect(client.items.list('Valet')).rejects.toThrow('resource not found')
    // Never a value in the call log.
    expect(JSON.stringify(fake.calls)).not.toContain(LOGIN.password)
  })

  it('words a bad, unknown, revoked or rate-limited token as the SDK does', async () => {
    const fake = make({ serviceAccountDailyLimit: 2 })
    const sdk = fakeSdk(fake)
    const config = (auth: string) => ({ auth, integrationName: 'valet', integrationVersion: '0' })
    await expect(sdk.createClient(config('nope'))).rejects.toThrow('invalid service account token')
    await expect(sdk.createClient(config('ops_unknown'))).rejects.toThrow('service account deserialization')
    const client = await sdk.createClient(config(DEMO_SERVICE_ACCOUNT_TOKEN))
    await client.vaults.list()
    await expect(client.vaults.list()).rejects.toBeInstanceOf(sdk.RateLimitExceededError)
    ;(fake.serviceAccounts[0] as { revoked?: boolean }).revoked = true
    await expect(client.vaults.list()).rejects.toBeInstanceOf(sdk.AuthExpiredError)
    await expect(sdk.createClient({ integrationName: 'valet', integrationVersion: '0' })).rejects.toThrow(
      'no authentication method',
    )
    await expect(
      sdk.createClient({ auth: 'x', integrationName: '', integrationVersion: '0' }),
    ).rejects.toThrow('integration name')
  })

  it('resolves fields, codes and each failure with the SDK’s messages', async () => {
    let now = Date.parse('2026-11-11T00:00:00Z')
    const fake = make({}, () => now)
    const client = await approved(fake)
    const streaming = `op://${P}/demostreaming0000000000000`
    expect(await client.secrets.resolve(`${SHOP}/password`)).toBe(LOGIN.password)
    expect(await client.secrets.resolve(`op://Personal/Woolworths (demo account)/username`)).toBe(
      LOGIN.username,
    )
    expect(await client.secrets.resolve(`${streaming}/one-time password?attribute=totp`)).toBe(
      totp('JBSWY3DPEHPK3PXP', now),
    )
    expect(await client.secrets.resolve(`${streaming}/one-time password`)).toMatch(/^otpauth:\/\/totp\//)
    const cases: [string, string][] = [
      ['nope', 'not prefixed'],
      ['op://a/b', 'invalid format'],
      [`op://Nowhere/x/password`, 'no vault matched'],
      [`op://${P}/nothing/password`, 'no item matched'],
      [`${SHOP}/pin`, 'field cannot be found'],
      [`${SHOP}/section/password`, 'field cannot be found'],
      [`${SHOP}/one-time password?attribute=totp`, 'field cannot be found'],
      [`${SHOP}/password?attribute=totp`, 'totp attribute'],
      [`${streaming}/one-time password?attribute=otp`, 'totp attribute'],
    ]
    for (const [reference, message] of cases) {
      await expect(client.secrets.resolve(reference), reference).rejects.toThrow(message)
    }
    fake.updateItem(DEMO_SHOP_ITEM_ID, { archived: true })
    await expect(client.secrets.resolve(`${SHOP}/password`)).rejects.toThrow('not in an active state')
    expect(
      await client.items.list(P, { type: 'ByState', content: { active: false, archived: true } }),
    ).toHaveLength(1)
    expect(() => fake.updateItem('missing', {})).toThrow('no item')
    now += 1
  })

  it('asks the person once through the desktop app, and the approval lapses as 1Password’s does', async () => {
    let now = 0
    const fake = make({}, () => now)
    const prompts: string[] = []
    fake.on('prompt', (p) => prompts.push(p.id))
    const sdk = fakeSdk(fake)
    const config = {
      auth: new DesktopAuth('Tess Tester'),
      integrationName: 'valet',
      integrationVersion: '0.0.0',
    }
    const pending = sdk.createClient(config)
    await Promise.resolve()
    expect(fake.pending()).toHaveLength(1)
    // Locked: allowing needs an unlock first.
    expect(fake.allow('prompt-1')).toBe(false)
    expect(fake.unlock('wrong')).toBe(false)
    expect(fake.unlock(DEMO_ONEPASSWORD_ACCOUNT.unlockPassword)).toBe(true)
    expect(fake.allow('prompt-1')).toBe(true)
    expect(fake.allow('prompt-1')).toBe(false)
    const client = await pending
    expect(fake.approved('valet')).toBe(true)
    // Up: a second client doesn't ask again.
    await sdk.createClient({ ...config, auth: new DesktopAuth(DEMO_ONEPASSWORD_ACCOUNT.uuid) })
    expect(prompts).toEqual(['prompt-1'])
    expect((await client.vaults.list()).map((v) => v.title)).toEqual(['Personal', 'Shared', 'Valet'])
    now += 11 * 60_000
    await expect(client.vaults.list()).rejects.toBeInstanceOf(sdk.DesktopSessionExpiredError)
    await expect(client.vaults.list()).rejects.toThrow('desktop session expired')

    // Denied, the wrong account, and the integration turned off.
    const denied = sdk.createClient(config)
    await Promise.resolve()
    fake.deny(fake.pending()[0]?.id ?? '')
    await expect(denied).rejects.toThrow('authorization denied by user')
    await expect(sdk.createClient({ ...config, auth: new DesktopAuth('Someone') })).rejects.toThrow(
      'no account',
    )
    fake.setIntegration(false)
    await expect(sdk.createClient(config)).rejects.toThrow('integration is not enabled')
    fake.setIntegration(true)
    fake.lock()
    expect(fake.locked).toBe(true)
  })
})

describe('the fake op CLI', () => {
  it('reads, lists and says --version, through the desktop app', async () => {
    const fake = make({ autoApprove: true })
    expect((await runOp(fake, ['--version'])).stdout.toString()).toMatch(/^2\.\d+\.\d+\n$/)
    const read = await runOp(fake, ['read', '--no-newline', `${SHOP}/password`])
    expect(read).toMatchObject({ code: 0, stderr: '' })
    expect(read.stdout.toString()).toBe(LOGIN.password)
    expect((await runOp(fake, ['read', `${SHOP}/username`])).stdout.toString()).toBe(`${LOGIN.username}\n`)
    const otp = await runOp(fake, [
      'read',
      `op://${P}/demostreaming0000000000000/one-time password?attribute=otp`,
    ])
    expect(otp.stdout.toString()).toMatch(/^\d{6}\n$/)
    const list = await runOp(fake, ['item', 'list', '--vault', 'Personal', '--format', 'json'])
    const items = JSON.parse(list.stdout.toString()) as {
      id: string
      title: string
      vault: { name: string }
    }[]
    expect(items.map((i) => i.title)).toEqual([
      'Woolworths (demo account)',
      'Library card',
      'Streaming service',
    ])
    expect(list.stdout.toString()).not.toContain(LOGIN.password)
    expect((await runOp(fake, ['item', 'list'])).stdout.toString()).toContain('Home Wi-Fi')
    expect(fake.calls.filter((c) => c.via === 'cli').map((c) => c.op)).toEqual([
      'read',
      'read',
      'read',
      'item list',
      'item list',
    ])
  })

  it('fails with op’s wording', async () => {
    const fake = make({ autoApprove: true })
    const err = async (args: string[]) => {
      const r = await runOp(fake, args)
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/^\[ERROR\] \d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /)
      return r.stderr
    }
    expect(await err(['read', 'op://Nowhere/x/password'])).toContain("isn't a vault")
    expect(await err(['read', `op://${P}/nothing/password`])).toContain("isn't an item")
    expect(await err(['read', `${SHOP}/pin`])).toContain("isn't a field")
    expect(await err(['read', `${SHOP}/password?attribute=otp`])).toContain('invalid attribute')
    expect(await err(['read', 'nope'])).toContain('invalid secret reference')
    expect(await err(['item', 'list', '--vault', 'Nowhere'])).toContain("isn't a vault")
    expect(await err(['item', 'list', '--vault'])).toContain('needs an argument')
    expect(await err(['vault', 'list'])).toContain('unknown command')
    expect(await err(['--bogus'])).toContain('unknown flag')
    fake.autoApprove = false
    fake.lock()
    const pending = runOp(fake, ['read', `${SHOP}/password`])
    await Promise.resolve()
    fake.deny(fake.pending()[0]?.id ?? '')
    expect((await pending).stderr).toContain('authorization prompt dismissed')
    fake.setIntegration(false)
    expect(await err(['read', `${SHOP}/password`])).toContain('connecting to desktop app')
    fake.setIntegration(true)
    expect(await err(['read', '--account', 'Someone', `${SHOP}/password`])).toContain("isn't signed in")
  })

  it('a spawner answers op and codesign for the fake’s path, and hands anything else on', async () => {
    const fake = make({ autoApprove: true })
    const run = (spawner: ReturnType<typeof fakeOpSpawner>, command: string, args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string; error?: string }>((resolve) => {
        const child = spawner(command, args)
        let out = ''
        let err = ''
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString()
        })
        child.stderr.on('data', (c: Buffer) => {
          err += c.toString()
        })
        child.on('error', (e: Error) =>
          resolve({ code: null, out, err, error: (e as NodeJS.ErrnoException).code }),
        )
        child.on('close', (code: number | null) => resolve({ code, out, err }))
      })
    const spawner = fakeOpSpawner(fake)
    expect(await run(spawner, FAKE_OP_PATH, ['read', '--no-newline', `${SHOP}/username`])).toMatchObject({
      code: 0,
      out: LOGIN.username,
    })
    expect(
      (await run(spawner, '/usr/bin/codesign', ['--verify', '--strict', '-R=x', FAKE_OP_PATH])).code,
    ).toBe(0)
    expect((await run(spawner, '/usr/bin/codesign', ['--verify', '/usr/local/bin/op'])).code).toBe(1)
    expect((await run(spawner, '/usr/bin/security', [])).error).toBe('ENOENT')
    const handed: string[] = []
    const withFallback = fakeOpSpawner(fake, {
      fallback: (command) => {
        handed.push(command)
        return spawner('/nowhere', [])
      },
    })
    await run(withFallback, '/usr/bin/security', [])
    expect(handed).toEqual(['/usr/bin/security'])
    // Killed while it waits on the person: closes with no code, and a late answer goes nowhere.
    fake.autoApprove = false
    fake.lock()
    const child = spawner(FAKE_OP_PATH, ['read', `${SHOP}/password`])
    const closed = new Promise((resolve) => child.on('close', resolve))
    expect(child.kill('SIGKILL')).toBe(true)
    expect(child.kill()).toBe(false)
    expect(await closed).toBeNull()
    child.stdin.end(Buffer.alloc(0))
    child.stdin.on('error', () => undefined)
    await Promise.resolve()
    fake.deny(fake.pending()[0]?.id ?? '')
  })
})

describe('the fake app’s windows', () => {
  it('serves its page and acts on the person’s unlock, switch and answers', async () => {
    const fake = make()
    const app = await startKeyholdApp(fake)
    try {
      const page = await fetch(app.url)
      expect(page.status).toBe(200)
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
      const html = await page.text()
      expect(html).toContain('Keyhold')
      expect(html).not.toContain('1Password</title>')
      expect((await fetch(`${app.url}settings`)).status).toBe(200)
      expect((await fetch(app.promptUrl('prompt-9'))).status).toBe(200)
      expect((await fetch(`${app.url}nothing`)).status).toBe(404)
      expect((await fetch(app.url, { method: 'PUT' })).status).toBe(405)

      const post = (path: string, body: unknown, type = 'application/json') =>
        fetch(`${app.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': type },
          body: JSON.stringify(body),
        })
      const state = async () =>
        (await (await fetch(`${app.url}api/state`)).json()) as ReturnType<typeof publicState>
      expect(await state()).toMatchObject({ locked: true, vaults: [], account: { name: 'Tess Tester' } })
      expect((await post('api/unlock', { password: 'x' }, 'text/plain')).status).toBe(415)
      expect(await (await post('api/unlock', { password: 'x' })).json()).toEqual({ ok: false })
      expect(
        await (await post('api/unlock', { password: DEMO_ONEPASSWORD_ACCOUNT.unlockPassword })).json(),
      ).toEqual({
        ok: true,
      })
      const unlocked = await state()
      expect(unlocked.vaults.map((v) => v.title)).toEqual(['Personal', 'Shared', 'Valet'])
      expect(JSON.stringify(unlocked)).not.toContain(LOGIN.password)
      expect(JSON.stringify(unlocked)).not.toContain('JBSWY3DPEHPK3PXP')

      const pending = fake.authorizeDesktop('Tess Tester', 'valet', '0.0.0', 'sdk')
      await Promise.resolve()
      expect((await state()).prompts).toEqual([
        expect.objectContaining({ id: 'prompt-1', integration: 'valet', state: 'pending' }),
      ])
      expect(await (await post('api/prompts/prompt-1/allow', {})).json()).toEqual({ ok: true })
      await pending
      expect((await state()).approvals).toEqual(['valet'])
      const again = fake.authorizeDesktop('Tess Tester', 'op', '2', 'cli')
      again.catch(() => undefined)
      await Promise.resolve()
      await post('api/prompts/prompt-2/deny', {})
      await expect(again).rejects.toThrow('denied')

      await post('api/integration', { enabled: false })
      expect(fake.integrationEnabled).toBe(false)
      await post('api/integration', { enabled: true })
      await post('api/lock', {})
      expect(fake.locked).toBe(true)
      expect((await post('api/nothing', {})).status).toBe(404)
      expect(await (await post('api/unlock', 'not an object')).json()).toEqual({ ok: false })
      const big = await fetch(`${app.url}api/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(20_000),
      })
      expect(await big.json()).toEqual({ ok: false })
      const broken = await fetch(`${app.url}api/unlock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
      expect(await broken.json()).toEqual({ ok: false })
    } finally {
      await app.close()
    }
  })

  it('reports a port it can’t take', async () => {
    const fake = make()
    const first = await startKeyholdApp(fake)
    try {
      await expect(startKeyholdApp(fake, { port: first.port })).rejects.toThrow()
    } finally {
      await first.close()
    }
  })
})
