#!/bin/sh
# Captures a few real Yahoo Finance pages, 4 s apart, for fixtures. Anonymous GETs only, with one
# cookie jar, as a browser would hold. Output: $OUT/<name>.html|json plus $OUT/<name>.headers.
set -u
OUT="$1"; mkdir -p "$OUT"
JAR="$OUT/../jar.txt"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
get() {
  name="$1"; url="$2"
  curl -sS -m 30 -A "$UA" -b "$JAR" -c "$JAR" -H 'Accept-Language: en-AU,en;q=0.9' \
    -H 'Referer: https://finance.yahoo.com/' -D "$OUT/$name.headers" -o "$OUT/$name.body" "$url"
  echo "$name $(head -1 "$OUT/$name.headers" | tr -d '\r') $(wc -c < "$OUT/$name.body") bytes $(grep -i '^location' "$OUT/$name.headers" | tr -d '\r')"
  sleep 4
}
Y=https://finance.yahoo.com
get quote-aapl "$Y/quote/AAPL/"
get quote-bhpax "$Y/quote/BHP.AX/"
get quote-gspc "$Y/quote/%5EGSPC/"
get quote-audusd "$Y/quote/AUDUSD%3DX/"
get quote-missing "$Y/quote/NOTAREALSYMBOLXX/"
get history-aapl "$Y/quote/AAPL/history/"
get lookup-apple "$Y/lookup/?s=apple"
get search-api-apple "https://query1.finance.yahoo.com/v1/finance/search?q=apple&quotesCount=6&newsCount=0"
get chart-api-aapl "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d"
cut -f6 "$JAR" | sort -u | tr '\n' ' '; echo
