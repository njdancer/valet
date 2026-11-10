# How long a thirty-item shop takes

2026-11-10. Finding 12 of the [whole-project review](2026-11-10-whole-project-review.md): the MVP
is done when Nick prefers Valet to his existing grocery skill, and nothing timed a whole shop.

## How it was measured

`packages/runtime/test/shop-benchmark.test.ts` runs the real tool host and the real Woolworths
adapter, one call after another as the server's instructions ask, against canned site answers on a
virtual clock that the rate budget moves forward. The times are what pacing alone costs: the 10 s
gap between requests ([D28](../plan.md#d28-rate-budget-defaults), answered). Network time, the
login, and the agent's own thinking between calls come on top. The test asserts the calls, the
requests and the time at the 10 s gap, so a change to the pacing or to what a tool sends changes
the test and this page together. The last column is arithmetic, not a test: what the same requests
would take with D28's jitter of 0 to 50% on the gap, which is not built (see below).

## The numbers

Thirty items, then one `get_cart` to check the result.

| How the agent shops                                | Calls | Requests | At the 10 s gap | With D28's jitter, if built |
| -------------------------------------------------- | ----- | -------- | --------------- | --------------------------- |
| `search_products` then `add_to_cart` for each item | 61    | 122      | 20 min          | 25 min average, 30 at most  |
| `add_to_cart` only, stockcodes already known       | 31    | 92       | 15 min          | 19 min average, 23 at most  |
| `set_cart_quantity` only, stockcodes already known | 31    | 62       | 10 min          | 13 min average, 15 at most  |

What each call sends:

- `search_products`: one request.
- `add_to_cart`: three. The login probe, a read of the trolley (the site stores absolute
  quantities, so an add has to know what is there), and the write.
- `set_cart_quantity` and `remove_from_cart`: two. The probe and the write.
- `get_cart`: two. The probe and the read.

## What it shows

1. **The plan's estimate holds.** D28 expected "roughly 15–30 minutes" for a shop of about 30
   tool calls. A search and an add for each of thirty items is 61 calls and 20 minutes, or 25 on
   average once the jitter is built. It is a background job, not something to wait on.
2. **A third of a cart shop's requests are login probes.** Every cart call probes first, because
   an anonymous visitor has a trolley too and a write to it would look like a success. Thirty adds
   make thirty probes. Trusting a probe for a short time would cut an add from three requests to
   two, at the risk that a session ending inside that time sends one write to an anonymous
   trolley. That is a trade for the adapter to declare in its manifest, so it was not made here.
3. **The read cache D28 calls for is not built, and adds would gain most from it.** D28 says to
   keep the trolley until a write, and to take the write's own answer as the new trolley. With
   that, an add needs no read of its own: thirty adds drop from 92 requests to about 62, the
   `set_cart_quantity` row. With a trusted probe as well, about 32 requests, near 7 minutes.
4. **D28's hourly cap cannot hold a shop as things are.** D28 also asks for at most 60 direct
   calls an hour and 4 a minute. Neither is built (they need new manifest limits, change request
   C10). At 122 requests, a search-and-add shop would take over two hours under the hourly cap.
   Either the cap is built after the cache and the probe change, or it is raised. D28 says to
   loosen only with evidence from M2 and M3; this is the evidence to weigh then.
5. **Fewer calls beats a shorter gap.** A saved list or past orders (`list_past_orders` is a
   stretch goal) removes the thirty searches, which is 5 to 6 minutes, and risks nothing with the
   site. Shortening the gap is the one change the live probe argues against.

## The jitter was tried, and can't land yet

D28 asks for upward-only jitter of 0 to 50% on the gap, and the runtime has none. It was built
with this benchmark and taken out again, because the desktop app's end-to-end suite failed with
it: `add_to_cart` on a cold session timed out (`timeout/timed-out`) in `journey.spec.ts` and
`update.spec.ts`.

The cause is worth more than the jitter. A cart call that has to log in first paces every step of
the login as well as its own requests, and the whole call runs under the tool timeout of 2
minutes. On `main` those two tests take 1.7 to 1.9 minutes each, a search included, so a cold
`add_to_cart` already finishes close to the limit at the bare gap. A quarter more waiting puts it
over.

So three things are tied together, and the jitter has to wait for the first:

- **A call that logs in needs more room than 2 minutes, or the login must not count against it.**
  This is [D50](../plan.md#d50-confirmation-and-hand-off-timeouts) (confirmation, hand-off and
  tool timeouts against what clients allow), which Nick hasn't answered. Its recommendation is to
  measure Claude Code's and Claude Desktop's own timeouts first. Until then a cold cart call is
  also the one most likely to outlast the client.
- **Then the jitter**, a small change to `RateBudget` with an injected draw.
- **The live site may be slower than the fake**, which could push a cold call over today. Session
  3 of the [M2 runbook](../m2-runbook.md) should time the first cart call.

## Assumptions

- Nick has not been asked about any of this.
- The canned answers stand in for the site, so a tool that needs more requests against the live
  site than against the fixtures would take longer. Session 3 of the
  [M2 runbook](../m2-runbook.md) is where that would show.
