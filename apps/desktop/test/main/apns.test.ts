import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pushPayloadSchema } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  APNS_HOSTS,
  type ApnsPost,
  type ApnsResponse,
  ApnsSender,
  NEEDS_YOU_PAYLOAD,
  PUSH_GAP_MS,
} from '../../src/main/core/approvals/apns'

const TOKEN = 'ab'.repeat(32)
const config = { teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'me.dncr.valet' }

interface Sent {
  readonly host: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

async function setup(answer: (host: string) => ApnsResponse = () => ({ status: 200, reason: null })) {
  const dir = await mkdtemp(join(tmpdir(), 'valet-apns-'))
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  await writeFile(join(dir, 'apns.json'), JSON.stringify(config))
  await writeFile(
    join(dir, `AuthKey_${config.keyId}.p8`),
    privateKey.export({ type: 'pkcs8', format: 'pem' }),
  )
  const sent: Sent[] = []
  let now = 1_800_000_000_000
  const post: ApnsPost = async (host, path, headers, body) => {
    sent.push({ host, path, headers, body })
    return answer(host)
  }
  const sender = new ApnsSender({ dir, post, now: () => now })
  return { dir, sender, sent, publicKey, advance: (ms: number) => (now += ms) }
}

describe('ApnsSender', () => {
  it('sends nothing until apns.json is set up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'valet-apns-'))
    const sent: unknown[] = []
    const sender = new ApnsSender({
      dir,
      post: async () => {
        sent.push(1)
        return { status: 200, reason: null }
      },
    })
    await sender.setToken('phone-1', TOKEN)
    expect(await sender.configured()).toBe(false)
    expect(await sender.wake('phone-1')).toBe('not-set-up')
    expect(sent).toEqual([])
  })

  it('wakes a phone with fixed text and a provider token Apple can verify', async () => {
    const { sender, sent, publicKey } = await setup()
    expect(await sender.wake('phone-1')).toBe('no-token')
    await sender.setToken('phone-1', TOKEN)
    expect(await sender.wake('phone-1')).toBe('sent')
    expect(sent).toHaveLength(1)
    const [push] = sent
    expect(push?.host).toBe(APNS_HOSTS.production)
    expect(push?.path).toBe(`/3/device/${TOKEN}`)
    expect(push?.headers['apns-topic']).toBe('me.dncr.valet')
    expect(push?.headers['apns-push-type']).toBe('alert')
    // Nothing but the wake-up: no site, agent or request in what Apple sees.
    expect(pushPayloadSchema.parse(JSON.parse(push?.body ?? ''))).toEqual(JSON.parse(NEEDS_YOU_PAYLOAD))
    const jwt = (push?.headers.authorization ?? '').replace(/^bearer /, '')
    const [h, c, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: config.keyId,
    })
    expect(JSON.parse(Buffer.from(c ?? '', 'base64url').toString()).iss).toBe(config.teamId)
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s ?? '', 'base64url'),
      ),
    ).toBe(true)
  })

  it('wakes a phone at most once in the gap, then again', async () => {
    const { sender, sent, advance } = await setup()
    await sender.setToken('phone-1', TOKEN)
    expect(await sender.wake('phone-1')).toBe('sent')
    expect(await sender.wake('phone-1')).toBe('too-soon')
    advance(PUSH_GAP_MS)
    expect(await sender.wake('phone-1')).toBe('sent')
    expect(sent).toHaveLength(2)
  })

  it('falls back to the sandbox for an Xcode build and remembers it', async () => {
    const { sender, sent, advance, dir } = await setup((host) =>
      host === APNS_HOSTS.production
        ? { status: 400, reason: 'BadDeviceToken' }
        : { status: 200, reason: null },
    )
    await sender.setToken('phone-1', TOKEN)
    expect(await sender.wake('phone-1')).toBe('sent')
    expect(sent.map((p) => p.host)).toEqual([APNS_HOSTS.production, APNS_HOSTS.sandbox])
    advance(PUSH_GAP_MS)
    expect(await sender.wake('phone-1')).toBe('sent')
    expect(sent.map((p) => p.host).at(-1)).toBe(APNS_HOSTS.sandbox)
    expect(sent).toHaveLength(3)
    const saved = JSON.parse(await readFile(join(dir, 'push-tokens.json'), 'utf8'))
    expect(saved['phone-1']).toEqual({ token: TOKEN, environment: 'sandbox' })
  })

  it('drops a token Apple says is gone, and a removed phone’s token', async () => {
    const { sender, sent } = await setup(() => ({ status: 410, reason: 'Unregistered' }))
    await sender.setToken('phone-1', TOKEN)
    expect(await sender.wake('phone-1')).toBe('refused')
    expect(await sender.wake('phone-1')).toBe('no-token')
    await sender.setToken('phone-2', TOKEN)
    await sender.forget('phone-2')
    expect(await sender.wake('phone-2')).toBe('no-token')
    expect(sent).toHaveLength(1)
  })

  it('never throws when Apple can’t be reached', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'valet-apns-'))
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    await writeFile(join(dir, 'apns.json'), JSON.stringify(config))
    await writeFile(
      join(dir, `AuthKey_${config.keyId}.p8`),
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
    )
    const sender = new ApnsSender({
      dir,
      post: async () => {
        throw new Error('offline')
      },
    })
    await sender.setToken('phone-1', TOKEN)
    expect(await sender.wake('phone-1')).toBe('failed')
  })
})
