// The local listener's hook with a single client, as most tests want it.

import type { Authenticate } from '../src/auth'
import { ClientTokens, localAuthenticator } from '../src/local-auth'

export const TEST_CLIENT = 'test-client'

/** localAuthenticator over a table that issues `token` to one client, `clientId`. */
export function tokenAuth(token: string, clientId = TEST_CLIENT): Authenticate {
  const tokens = new ClientTokens()
  tokens.set(clientId, token)
  return localAuthenticator(tokens)
}
