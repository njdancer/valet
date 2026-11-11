import { z } from 'zod'

/**
 * A Yahoo symbol: letters, digits and . ^ = - (AAPL, BHP.AX, ^GSPC, AUDUSD=X, BTC-USD, ES=F),
 * upper-cased. Nothing that could reach outside one path segment.
 */
export const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[A-Za-z0-9.^=-]+$/, 'a symbol is letters, digits and . ^ = - only')
  .transform((symbol) => symbol.toUpperCase())

/** The symbol as one path segment: ^ and = are percent-encoded, as the site's own links do. */
export function symbolSegment(symbol: string): string {
  return encodeURIComponent(symbol)
}
