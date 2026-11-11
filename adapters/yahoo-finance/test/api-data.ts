// Constructed in the API's documented shape, with made-up values: the API answered the capture
// with 429 (docs/findings/2026-11-11-yahoo-finance.md).
export const CHART = {
  chart: {
    result: [
      {
        meta: { currency: 'AUD', symbol: 'BHP.AX', exchangeName: 'ASX', fullExchangeName: 'ASX' },
        timestamp: [1794268800, 1794355200, 1794441600],
        indicators: {
          quote: [
            {
              open: [60, 60.5, null],
              high: [61, 61.2, null],
              low: [59.5, 60.1, null],
              close: [60.4, 61, null],
              volume: [100, 200, null],
            },
          ],
          adjclose: [{ adjclose: [60.4, 61, null] }],
        },
      },
    ],
    error: null,
  },
}

export const SEARCH = {
  quotes: [
    {
      symbol: 'CBA.AX',
      shortname: 'CWLTH BANK FPO',
      longname: 'Commonwealth Bank of Australia',
      exchDisp: 'Australian',
      quoteType: 'EQUITY',
      sectorDisp: 'Financial Services',
      industryDisp: 'Banks—Diversified',
    },
    { symbol: 'CMWAY', shortname: 'Commonwealth Bank ADR', exchange: 'PNK', quoteType: 'EQUITY' },
    { shortname: 'no symbol, dropped' },
  ],
}
