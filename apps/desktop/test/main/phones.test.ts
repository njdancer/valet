import { describe, expect, it, vi } from 'vitest'
import { Phones } from '../../src/main/core/phones'

describe('Phones', () => {
  it('says pairing needs the blind relay when there is none', () => {
    const phones = new Phones({
      tunnel: null,
      macName: 'Mac',
      statePath: '/nonexistent/a',
      bindingPath: '/nonexistent/b',
      emit: vi.fn(),
    })
    expect(phones.status()).toMatchObject({
      available: false,
      unavailableReason: 'no-relay',
      relayOrigin: null,
      relay: 'stopped',
    })
  })
})
