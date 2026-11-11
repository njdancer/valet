// A small, paced, read-only look at candidate practice sites from a macOS runner: status, bot
// protection headers, cookie names (never values) and the inputs of each form. Run by
// .github/workflows/site-probe.yml. No account is used.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const PAGES = [
  'https://en.wikipedia.org/wiki/Special:UserLogin',
  'https://en.wikipedia.org/w/api.php?action=query&meta=userinfo&format=json',
  'https://auth.wikimedia.org/enwiki/wiki/Special:UserLogin',
  'https://finance.yahoo.com/quote/AAPL/',
  'https://www.coles.com.au/',
  'https://www.allbirds.com/cart.js',
  'https://www.gymshark.com/cart.js',
]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const url of PAGES) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, redirect: 'manual' })
    const text = await res.text()
    const h = res.headers
    const cookies = (h.getSetCookie?.() ?? []).map((c) => c.split('=')[0])
    console.log(`\n=== ${url}\nstatus ${res.status} type ${h.get('content-type')} server ${h.get('server')} cf-ray ${h.has('cf-ray')} location ${h.get('location')}`)
    console.log(`cookies ${cookies.join(',')}  length ${text.length}  title ${(/<title>([^<]*)/i.exec(text) ?? [])[1]?.trim()}`)
    for (const form of text.match(/<form[\s\S]*?<\/form>/gi) ?? []) {
      const open = /<form[^>]*>/i.exec(form)?.[0]
      console.log(`  form ${open?.replace(/\s+/g, ' ').slice(0, 200)}`)
      for (const el of form.match(/<(input|button|select|textarea)[^>]*>/gi) ?? []) {
        console.log(`    ${el.replace(/value="[^"]{20,}"/, 'value="…"').replace(/\s+/g, ' ').slice(0, 220)}`)
      }
    }
    if ((h.get('content-type') ?? '').includes('json')) console.log(`  json ${text.slice(0, 400)}`)
    if (/challenge|captcha|just a moment|access denied/i.test(text)) console.log('  NOTE: challenge/captcha words present')
  } catch (e) {
    console.log(`\n=== ${url}\nERROR ${e}`)
  }
  await sleep(4000)
}
