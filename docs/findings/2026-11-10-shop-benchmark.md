# How long a thirty-item shop takes

2026-11-10. Finding 12 of the [whole-project review](2026-11-10-whole-project-review.md): the MVP
is done when Nick prefers Valet to his existing grocery skill, and nothing timed a whole shop.

## How it was measured

`packages/runtime/test/shop-benchmark.test.ts` runs the real tool host and the real Woolworths
adapter, one call after another as the server's instructions ask, against canned site answers on a
virtual clock that the rate budget moves forward. The times are what pacing alone costs: the 10 s
gap between requests and its jitter of up to half as much again
([D28](../plan.md#d28-rate-budget-defaults), answered). Network time, the login, and the agent's
own thinking between calls come on top. The test asserts the calls, the requests, and the bare and
average times below, so a change to the pacing or to what a tool sends changes the test and this
page together. The longest times are the request count at 15 s each.

## The numbers

Thirty items, then one `get_cart` to check the result.

| How the agent shops                                | Calls | Requests | Bare 10 s gap | With jitter, average | With jitter, longest |
| -------------------------------------------------- | ----- | -------- | ------------- | -------------------- | -------------------- |
| `search_products` then `add_to_cart` for each item | 61    | 122      | 20 min        | 25 min               | 30 min               |
| `add_to_cart` only, stockcodes already known       | 31    | 92       | 15 min        | 19 min               | 23 min               |
| `set_cart_quantity` only, stockcodes already known | 31    | 62       | 10 min        | 13 min               | 15 min               |

What each call sends:

- `search_products`: one request.
- `add_to_cart`: three. The login probe, a read of the trolley (the site stores absolute
  quantities, so an add has to know what is there), and the write.
- `set_cart_quantity` and `remove_from_cart`: two. The probe and the write.
- `get_cart`: two. The probe and the read.

## What it shows

1. **The plan's estimate holds, at its upper end.** D28 expected "roughly 15–30 minutes" for a
   shop of about 30 tool calls. A search and an add for each of thirty items is 61 calls and
   25 minutes on average. It is a background job, not something to wait on.
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

## Built alongside this

The gap's jitter, which D28 asked for and the runtime did not have: each wait is now the gap plus
up to half as much again, drawn afresh, never less than the gap.

## Assumptions

- Nick has not been asked about any of this. The jitter follows D28 as he accepted it.
- The canned answers stand in for the site, so a tool that needs more requests against the live
  site than against the fixtures would take longer. Session 3 of the
  [M2 runbook](../m2-runbook.md) is where that would show.
