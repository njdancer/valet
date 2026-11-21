// Points the relay's names at its Fly addresses in Cloudflare DNS (docs/blind-relay.md#deploying),
// run by the deploy workflow after each deploy, never on the relay itself: a token that may edit
// dncr.me's DNS stays in GitHub, out of reach of anyone who got into the relay.
//
//   flyctl ips list -a valet-relay --json | node sync-dns.mjs <zone> <name>...
//
// CLOUDFLARE_DNS_TOKEN: a token with Zone › DNS › Edit on that zone. Each name gets an A record per
// dedicated IPv4 and an AAAA record per dedicated IPv6, DNS only (Cloudflare's proxy would end TLS,
// which the blind relay mustn't let anyone do). Shared and private addresses are left out. Records
// of those types for those names that point elsewhere are removed; nothing else in the zone is
// touched, and a CNAME at one of the names is refused rather than replaced.

import { fileURLToPath } from 'node:url'

const API = 'https://api.cloudflare.com/client/v4'

/** The relay's public addresses from `flyctl ips list --json`, by record type. */
export function flyAddresses(list) {
  const wanted = { A: [], AAAA: [] }
  for (const ip of Array.isArray(list) ? list : []) {
    const type = String(ip?.Type ?? ip?.type ?? '')
    const address = String(ip?.Address ?? ip?.address ?? '')
    if (type === 'v4' && /^\d{1,3}(\.\d{1,3}){3}$/.test(address)) wanted.A.push(address)
    else if (type === 'v6' && address.includes(':')) wanted.AAAA.push(address)
  }
  return wanted
}

async function call(fetch, token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = await res.json().catch(() => null)
  if (!res.ok || parsed?.success !== true)
    throw new Error(
      `Cloudflare ${method} ${path.split('?')[0]}: ${res.status} ${parsed?.errors?.[0]?.message ?? ''}`,
    )
  return parsed.result
}

/**
 * Makes each name's A and AAAA records exactly `wanted`. Returns what it changed, as lines.
 * @param {{ token: string, zone: string, names: string[], wanted: { A: string[], AAAA: string[] }, fetch?: typeof fetch }} options
 */
export async function syncDns({ token, zone, names, wanted, fetch = globalThis.fetch }) {
  const zones = await call(fetch, token, 'GET', `/zones?name=${encodeURIComponent(zone)}`)
  const zoneId = zones.find((z) => z.name === zone)?.id
  if (zoneId === undefined) throw new Error(`the token can't see the zone ${zone}`)
  const changes = []
  for (const name of names) {
    if (name !== zone && !name.endsWith(`.${zone}`)) throw new Error(`${name} isn't in ${zone}`)
    const records = await call(
      fetch,
      token,
      'GET',
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
    )
    if (records.some((r) => r.type === 'CNAME'))
      throw new Error(`${name} has a CNAME; remove it by hand if the relay should have this name`)
    for (const type of ['A', 'AAAA']) {
      const have = records.filter((r) => r.type === type)
      for (const record of have) {
        if (wanted[type].includes(record.content) && record.proxied !== true) continue
        await call(fetch, token, 'DELETE', `/zones/${zoneId}/dns_records/${record.id}`)
        changes.push(`removed ${type} ${name} ${record.content}`)
      }
      for (const address of wanted[type]) {
        if (have.some((r) => r.content === address && r.proxied !== true)) continue
        await call(fetch, token, 'POST', `/zones/${zoneId}/dns_records`, {
          type,
          name,
          content: address,
          proxied: false,
          ttl: 300,
          comment: 'Valet blind relay (deploy-relay.yml)',
        })
        changes.push(`added ${type} ${name} ${address}`)
      }
    }
  }
  return changes
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [zone, ...names] = process.argv.slice(2)
  const token = process.env.CLOUDFLARE_DNS_TOKEN
  if (zone === undefined || names.length === 0 || token === undefined || token === '') {
    console.error('usage: CLOUDFLARE_DNS_TOKEN=… node sync-dns.mjs <zone> <name>... < flyctl-ips.json')
    process.exit(2)
  }
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const wanted = flyAddresses(JSON.parse(input))
  if (wanted.A.length === 0 && wanted.AAAA.length === 0) {
    console.error('flyctl lists no dedicated addresses for the app: not changing DNS')
    process.exit(1)
  }
  if (wanted.A.length === 0)
    console.log('::warning::No dedicated IPv4: callers without IPv6 can’t reach the relay.')
  const changes = await syncDns({ token, zone, names, wanted })
  console.log(changes.length === 0 ? 'DNS already points at the relay' : changes.join('\n'))
}
