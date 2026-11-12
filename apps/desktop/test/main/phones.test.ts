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
})
