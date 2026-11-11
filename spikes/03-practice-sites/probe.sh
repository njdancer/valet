#!/bin/sh
# Captures a few real responses from Yahoo Finance and Wikipedia, 3 s apart, for fixtures.
# Anonymous GETs only. Output: $OUT/<name>.json plus $OUT/<name>.headers.
set -u
OUT="$1"; mkdir -p "$OUT"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
get() {
  name="$1"; url="$2"; origin="${3:-}"
  if [ -n "$origin" ]; then
    curl -sS -m 30 -A "$UA" -H "Origin: $origin" -H "Referer: $origin/" -D "$OUT/$name.headers" -o "$OUT/$name.json" "$url"
  else
    curl -sS -m 30 -A "$UA" -D "$OUT/$name.headers" -o "$OUT/$name.json" "$url"
  fi
  echo "$name $(head -1 "$OUT/$name.headers" | tr -d '\r') $(wc -c < "$OUT/$name.json") bytes"
  grep -i '^access-control\|^content-type' "$OUT/$name.headers" | tr -d '\r' | sed 's/^/   /'
  sleep 3
}
Y=https://finance.yahoo.com
get yahoo-quote-page "$Y/quote/AAPL/"
get yahoo-search-apple "https://query1.finance.yahoo.com/v1/finance/search?q=apple&quotesCount=6&newsCount=0&enableFuzzyQuery=false" "$Y"
get yahoo-search-bhp "https://query1.finance.yahoo.com/v1/finance/search?q=bhp&quotesCount=6&newsCount=0&enableFuzzyQuery=false" "$Y"
get yahoo-chart-aapl-1d "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=5m" "$Y"
get yahoo-chart-aapl-1mo "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d" "$Y"
get yahoo-chart-bhpax-5d "https://query1.finance.yahoo.com/v8/finance/chart/BHP.AX?range=5d&interval=1d" "$Y"
get yahoo-chart-gspc-1y "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1y&interval=1wk" "$Y"
get yahoo-chart-audusd "https://query1.finance.yahoo.com/v8/finance/chart/AUDUSD=X?range=1d&interval=1h" "$Y"
get yahoo-chart-bad "https://query1.finance.yahoo.com/v8/finance/chart/NOTAREALSYMBOLXX?range=1d&interval=1d" "$Y"
get yahoo-quote-v7 "https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,MSFT" "$Y"
get yahoo-quotesummary "https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?modules=price,summaryDetail" "$Y"
W=https://en.wikipedia.org
get wiki-search "$W/w/rest.php/v1/search/page?q=kangaroo&limit=5"
get wiki-summary "$W/api/rest_v1/page/summary/Kangaroo"
get wiki-extract "$W/w/api.php?action=query&prop=extracts&explaintext=1&titles=Kangaroo&format=json&formatversion=2&redirects=1"
get wiki-missing "$W/api/rest_v1/page/summary/Thispagedoesnotexistxyzzy"
