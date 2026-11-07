// An in-memory stand-in for the valet-keychain helper: a spawner that answers its four commands
// with its exit codes, so the TypeScript side runs without the Keychain.

import { KEYCHAIN_EXIT } from '../src/keychain-helper'
import { type FakeChild, scriptedSpawner } from './fake-process'

export interface FakeKeychainItem {
  secret: Buffer
  comment: string
}

export function fakeKeychain(options: { exitCode?: (args: readonly string[]) => number | undefined } = {}) {
  const items = new Map<string, FakeKeychainItem>()
  const key = (service: string, account: string) => `${service}\u0000${account}`
  const { spawner, calls } = scriptedSpawner((child: FakeChild, { args }) => {
    queueMicrotask(() => {
      const forced = options.exitCode?.(args)
      if (forced !== undefined) {
        child.finish(forced)
        return
      }
      const [command, service = '', account = '', comment = ''] = args
      const item = items.get(key(service, account))
      switch (command) {
        case 'read':
          if (item === undefined) child.finish(KEYCHAIN_EXIT.notFound, '', 'valet-keychain: not found')
          else child.finish(0, Buffer.from(item.secret))
          return
        case 'info':
          if (item === undefined) child.finish(KEYCHAIN_EXIT.notFound)
          else child.finish(0, item.comment)
          return
        case 'write':
          items.set(key(service, account), { secret: Buffer.concat(child.input), comment })
          child.finish(0)
          return
        case 'delete':
          if (item === undefined) child.finish(KEYCHAIN_EXIT.notFound)
          else {
            items.delete(key(service, account))
            child.finish(0)
          }
          return
        default:
          child.finish(KEYCHAIN_EXIT.usage)
      }
    })
  })
  return {
    spawner,
    calls,
    items,
    get: (service: string, account: string) => items.get(key(service, account)),
  }
}
