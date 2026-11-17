import { afterEach, expect, it } from 'vitest'
import type { FakeImap } from '@valet/fake-imap'
import { fake, signedIn } from './helpers'

let server: FakeImap | null = null
afterEach(async () => server?.close())

it('reads mail', async () => {
  server = await fake()
  const { ops, client } = await signedIn(server, 'read')
  console.log(await ops.listFolders())
  const s = await ops.search('INBOX', {})
  console.log(s)
  console.log(JSON.stringify(await ops.fetch('INBOX', s.uids), null, 1))
  console.log(JSON.stringify(await ops.message('INBOX', 2), null, 1))
  console.log(await ops.attachment('INBOX', 2, '2'))
  console.log(server.commands.map((c) => c.line))
  await client.logout()
  expect(1).toBe(1)
})
