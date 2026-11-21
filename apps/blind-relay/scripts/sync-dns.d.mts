// Types for sync-dns.mjs, so its test typechecks.

export interface WantedAddresses {
  A: string[]
  AAAA: string[]
}

export declare function flyAddresses(list: unknown): WantedAddresses
export declare function syncDns(options: {
  token: string
  zone: string
  names: string[]
  wanted: WantedAddresses
  fetch?: typeof fetch
}): Promise<string[]>
