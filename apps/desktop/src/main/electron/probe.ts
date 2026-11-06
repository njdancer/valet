// A stand-in for core v3's AuthPage.fetch and cookieNames, over the auth partition's session, for
// drivers whose auth page doesn't implement them yet (browser-electron on core-v3). It keeps their
// contract: GET only, the auth partition's own cookies, the manifest's navigation origins only, no
// script in any page. Remove it once SurfaceAuthPage has both.

import type { AuthProbe } from '@siteadapter/auth-flow'
import { cookiesForDomains, partitionName } from '@siteadapter/browser-electron'
import { type AdapterManifest, type FetchResult, SiteAdapterError, urlOriginAllowed } from '@siteadapter/core'
import { net, session } from 'electron'

const MAX_BODY = 1024 * 1024
const TIMEOUT_MS = 15_000

export function partitionProbe(manifest: AdapterManifest): AuthProbe {
  const auth = () => session.fromPartition(partitionName('auth', manifest.id))
  return {
    fetch(url) {
      if (!urlOriginAllowed(url, manifest.navigation)) {
        return Promise.reject(new SiteAdapterError('probe', 'host-not-allowed'))
      }
      return new Promise<FetchResult>((resolve, reject) => {
        const request = net.request({
          url,
          method: 'GET',
          session: auth(),
          useSessionCookies: true,
          redirect: 'manual',
        })
        request.setHeader('accept', 'application/json')
        const timer = setTimeout(() => {
          request.abort()
          reject(new SiteAdapterError('probe', 'timed-out'))
        }, TIMEOUT_MS)
        request.on('redirect', () => {
          clearTimeout(timer)
          request.abort()
          // A redirect is an answer about the session (usually "log in"), never followed.
          resolve({ status: 302, contentType: null, body: null })
        })
        request.on('response', (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk) => {
            size += chunk.length
            if (size <= MAX_BODY) chunks.push(chunk)
          })
          response.on('end', () => {
            clearTimeout(timer)
            const header = response.headers['content-type']
            const contentType = (Array.isArray(header) ? header[0] : header) ?? null
            const text = Buffer.concat(chunks).toString('utf8')
            let body: unknown = text.length === 0 ? null : text
            if (contentType?.includes('json')) {
              try {
                body = JSON.parse(text)
              } catch {
                // Left as text; the probe reads that as the wrong shape.
              }
            }
            resolve({ status: response.statusCode, contentType, body })
          })
        })
        request.on('error', () => {
          clearTimeout(timer)
          reject(new SiteAdapterError('probe', 'unavailable'))
        })
        request.end()
      })
    },
    async cookieNames(domains) {
      const cookies = await auth().cookies.get({})
      return [
        ...new Set(
          cookiesForDomains(
            cookies.map((c) => ({ ...c, sameSite: c.sameSite })),
            domains,
          ).map((c) => c.name),
        ),
      ]
    },
  }
}
