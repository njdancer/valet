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
the test and this page together.

## The numbers

Thirty items, then one `get_cart` to check the result. "Before" is the first measurement, with a
login probe before every cart call and no read cache. "Now" is with the session read cache and the
minute a write may rest on the last probe, both described below.

| How the agent shops                                | Calls | Requests before | Before | Requests now | Now     |
| -------------------------------------------------- | ----- | --------------- | ------ | ------------ | ------- |
| `search_products` then `add_to_cart` for each item | 61    | 122             | 20 min | 73           | 12 min  |
| `add_to_cart` only, stockcodes already known       | 31    | 92              | 15 min | 39           | 6.3 min |
| `set_cart_quantity` only, stockcodes already known | 31    | 62              | 10 min | 37           | 6 min   |

What each call sends now:

- `search_products`: one request, or none when the same search was made in the last 15 minutes.
- `add_to_cart`: one, the write. The trolley it starts from is read from the site once and taken
  from the cache after that (each write's reply is the new trolley). Once a minute a write also
  makes the login probe.
- `set_cart_quantity` and `remove_from_cart`: one, plus the probe once a minute.
- `get_cart`: two, always. The probe and the site's own trolley.

## What was built after the first measurement

1. **The session read cache D28 calls for.** The manifest says which reads may be kept and for how
   long, and which write's reply is the new answer to which read. The runtime keeps nothing else,
   and forgets everything at a login, at any call that doesn't end ok, and at every write.
   D28 says "search and product detail until the session ends; the trolley until any write". Built
   tighter than that, because the person can change the same account from their own browser:
   search and product answers for 15 minutes, the trolley for 2 minutes.
2. **Fewer login probes.** A third of the first measurement's requests were probes. A write tool
   now rests on a "logged in" probe for 60 seconds. `get_cart`, any other read, and any
   irreversible tool always probe.

Neither shortens a cold call. A cart call that has to log in still probes, logs in, probes again,
reads the trolley and writes, so the timeout problem below is unchanged.

## What it shows

1. **A shop is now well inside the plan's estimate.** D28 expected "roughly 15–30 minutes". A
   search and an add for each of thirty items is 12 minutes of pacing.
2. **D28's hourly cap of 60 still can't hold a search-and-add shop**, at 73 requests. The cap is
   not built yet (it needs new manifest limits, change request C10). A cap of about 90 an hour
   would hold a shop with room for a retry or two; that choice is made with the cap.
3. **D28's cap of 4 a minute can't land for the same reason as the jitter** (next section): it
   stretches a cold call, which already runs close to the tool timeout.
4. **Fewer calls beats a shorter gap.** A saved list or past orders (`list_past_orders` is a
   stretch goal) removes the thirty searches and risks nothing with the site. Shortening the gap
   is the one change the live probe argues against.

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

Nick has not been asked about any of this. Each of these is a choice made on his behalf that he
can reverse:

- **A write rests on the last login probe for 60 seconds.** The plan has no recommendation on
  this. What it risks: if the session ends inside that minute (a password changed elsewhere, the
  site expiring it), the writes of that minute go to an anonymous trolley and are reported as
  successes, until the next probe logs in again. `get_cart` always probes and always asks the
  site, so ending a shop with it shows what is really in the cart, and nothing irreversible ever
  rests on an old probe. To take it back, set `PROBE_TRUST_SECONDS` to 0 in the adapter's
  `manifest.ts`; the thirty-item shop then takes 15 minutes instead of 12.
- **Search and product answers are reused for 15 minutes, the trolley for 2**, both shorter than
  D28's "until the session ends" and "until any write".
- **An add may start from a trolley up to 2 minutes old.** If the person changed that same line in
  their own browser meanwhile, the add overwrites it, as it already could in the 10 seconds
  between its read and its write.
- The canned answers stand in for the site, so a tool that needs more requests against the live
  site than against the fixtures would take longer. In particular the trolley update's reply is
  assumed to be the trolley; if it isn't, the adapter notices, asks the site, and an add costs two
  requests instead of one. Session 3 of the [M2 runbook](../m2-runbook.md) is where that would
  show.
