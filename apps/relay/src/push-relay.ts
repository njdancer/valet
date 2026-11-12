// One Durable Object for every push, so the APNs JWT is minted once and reused across Macs
// (Apple refuses providers that refresh it too often). It holds the key in memory only.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'
import { ApnsPushSender, NO_PUSH, type PushKind, type PushSender } from './push'

export class PushRelay extends DurableObject<Env> {
  private sender: PushSender | null = null

  override async fetch(request: Request): Promise<Response> {
    const { token, kind } = (await request.json()) as { token: string; kind: PushKind }
    if (kind !== 'needs-you' && kind !== 'alert') return Response.json({ result: 'failed' })
    this.sender ??= senderFor(this.env)
    return Response.json({ result: await this.sender.send(token, kind) })
  }
}

export function senderFor(env: Env): PushSender {
  const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = env
  if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC) return NO_PUSH
  return new ApnsPushSender({
    key: APNS_KEY,
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    topic: APNS_TOPIC,
    host: env.APNS_HOST ?? 'api.push.apple.com',
  })
}
