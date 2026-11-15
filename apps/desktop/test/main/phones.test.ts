import { describe, expect, it, vi } from 'vitest'
import { Phones, relayFromHost } from '../../src/main/core/phones'

describe('Phones', () => {
  it('takes a relay set in Settings, and says pairing needs one when it is cleared', async () => {
    const emit = vi.fn()
    const phones = new Phones({
      relay: null,
      macName: 'Mac',
      statePath: '/nonexistent/a',
      bindingPath: '/nonexistent/b',
      emit,
    })
    expect(phones.status()).toMatchObject({
      available: false,
      unavailableReason: 'no-relay',
      relayOrigin: null,
    })
    await phones.setRelay(relayFromHost('relay.example.com'))
    expect(phones.status().relayOrigin).toBe('https://relay.example.com')
    expect(emit).toHaveBeenCalledTimes(1)
    await phones.setRelay(relayFromHost('relay.example.com'))
    expect(emit).toHaveBeenCalledTimes(1)
    await phones.setRelay(null)
    expect(phones.status()).toMatchObject({ unavailableReason: 'no-relay', relayOrigin: null })
  })

  it('has no hub until the relay says so, and asks nothing of it while offline', () => {
    const phones = new Phones({
      relay: relayFromHost('relay.example.com'),
      macName: 'Mac',
      statePath: '/nonexistent/a',
      bindingPath: '/nonexistent/b',
      emit: vi.fn(),
    })
    expect(phones.status().hub).toBeNull()
    expect(phones.joinHub()).toBe(false)
    expect(phones.leaveHub()).toBe(false)
    expect(phones.hubPage('/link')).toBeNull()
  })
})
