import { describe, expect, it } from 'vitest'
import { routePath } from '../src/route-path'

describe('routePath', () => {
  it('lower-cases', () => {
    expect(routePath('/API/V3/UI/Checkout/Order')).toBe('/api/v3/ui/checkout/order')
  })

  it('decodes percent-encoded unreserved characters, in either hex case', () => {
    expect(routePath('/api/v3/ui/%63heckout/order')).toBe('/api/v3/ui/checkout/order')
    expect(routePath('/api/v3/ui/%43HECKOUT/%6f%72%64%65%72')).toBe('/api/v3/ui/checkout/order')
    expect(routePath('/%41%5a%61%7a%30%39%2d%2e%5f%7e')).toBe('/azaz09-._~')
  })

  it('leaves encoded reserved characters encoded, so an encoded slash is not a separator', () => {
    expect(routePath('/api%2fv3')).toBe('/api%2fv3')
    expect(routePath('/a%3fb%23c%25')).toBe('/a%3fb%23c%25')
  })

  it('collapses repeated slashes', () => {
    expect(routePath('//api///v3//ui/checkout/order')).toBe('/api/v3/ui/checkout/order')
  })

  it('drops one trailing slash, but keeps the root', () => {
    expect(routePath('/api/v3/ui/checkout/order/')).toBe('/api/v3/ui/checkout/order')
    expect(routePath('/')).toBe('/')
  })

  it('resolves dot segments that decoding or collapsing creates', () => {
    expect(routePath('/api/x/%2E%2E/v3/ui/checkout/order')).toBe('/api/v3/ui/checkout/order')
    expect(routePath('/api/x//../v3/ui/checkout/order')).toBe('/api/v3/ui/checkout/order')
  })
})
