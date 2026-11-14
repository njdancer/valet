# API adapters without a browser

Status: **Designed, not built.** Nick asked for this design on 2026-11-14 as background work, after
a tester agent raised it (valet-feedback #6). Nothing here gets built until he approves it. It isn't
on the path to the first real Woolworths order, so it shouldn't take his time before that order is
done.

## The question

Every Valet adapter today drives a browser. Each call opens the adapter's `home` page in its tool
partition, and tool code reaches the site through `page.fetch` and the page. That's what Valet is
for: sites that only work in a real, signed-in browser.

Some services have an ordinary HTTP API instead. An adapter for one of them still has to open a page
first, and `page.fetch` then runs under that page's own Content-Security-Policy and CORS rules. The
workaround is to make one of the API's own JSON responses the `home` page (PRs #111 and #112). It
works, but the browser adds nothing and the workaround needs explaining.

A platform that offers an API is usually happy for agents to call it directly, so this design is
only for the cases where Valet adds something an agent calling the API itself doesn't get:

| Case                                                          | What Valet adds                                                                                                                         | In scope                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| An API that acts as the person (a personal token, an API key) | **The agent never holds the key.** Valet adds it to requests on the hosts the person approved, and keeps it out of what tool code sees. | Yes: the main reason to build this           |
| A service on the person's home network (a NAS, a home server) | **Reach.** Cloud agents can't get to it any other way.                                                                                  | Yes, as the second slice                     |
| Any of these                                                  | One approval card, audit log, declared-request list and pacing for everything an agent touches.                                         | Comes with the above                         |
| A public API with no login (Hacker News, Wikipedia's REST API)  | Only the audit log.                                                                                                                     | Allowed once built, but not a reason to build |
| OAuth APIs                                                    | Key custody too, but they need a browser sign-in and token refresh.                                                                      | Later, separately                            |
| A site with part API, part browser-only                       | One adapter. But mixing loses the real-browser fingerprint.                                                                             | No: use two adapters                         |

## What already exists

Most of the plumbing is already there. Sandbox exceptions ([sandbox.md](sandbox.md)) give tool code
`ctx.local.fetch`, an HTTPS client that runs in the main process, so no page CSP or CORS applies.
It already does several things this design needs:

- It sends https on port 443 only, to hosts a `network` exception names.
- It checks the address it connects to, so it only dials public addresses.
- It refuses `host`, `cookie`, proxy and hop-by-hop headers.
- It returns redirects without following them.
- It caps each request at 30 s and 4 MB.
- It audits each call as `local-access`.

`local-service` adds HTTP to `127.0.0.1` on a declared port.

What it doesn't do, and an API adapter needs:

| Gap                                                                                                 | Why it matters                                                                                  |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| It isn't held to the manifest's `requests` declarations, their purpose or the run's ceiling.         | A `read` tool could call a write endpoint. Browser traffic can't.                               |
| It isn't paced by the adapter's `limits`, budget or circuit breaker.                                  | Pacing is a promise Valet makes for every site.                                                 |
| A refused request isn't reported in `blocked` or audited as `request-blocked`.                       | Agents and the person can't see why a call failed (the problem #111 fixed for `page.fetch`).    |
| It can't add a secret.                                                                              | This is the main reason to build the feature.                                                   |
| The manifest still needs `home` and `navigation`, and every call opens `home` first.                 | That's the workaround.                                                                          |
| Private addresses are refused. The `private-network` approval is for authoring sessions only, 30 minutes at a time. | Home-network services can't be reached.                                                         |

So the design is mostly closing those gaps, not building a second runtime.

## The design

### The manifest

A new top-level `"runtime": "http"`. Leaving it out means `"browser"`, so stored manifests and
approved hashes don't change.

An `http` manifest:

- has **no** `home`, `navigation`, `cartUrl`, `auth`, `session.cookieDomains`, `session.storage`
  or `frameOrigins`. The schema refuses them, the same way it already refuses a no-login adapter's
  auth steps;
- keeps `egress`, `requests`, `limits`, `tools`, `settings` and `sandbox`;
- gives **every** request declaration a `host`, since there's no home host to default to;
- is always `sandboxed`. An `http` adapter can't declare `unsandboxed`;
- may declare `credentials` and `privateHosts`, below;
- has `session.probe` set to `none`, or a `fetch` probe that runs through the same client with the
  same credential as tools.

### `ctx.http.fetch`

Tool code gets `ctx.http.fetch(url, init)`, which returns `{ status, headers, body }`. `init` takes
the same fields as `ctx.local.fetch`, plus `credential`, the name of a declared credential. It runs
in the main process, through the same checks in this order:

1. The checks `ctx.local.fetch` already makes: scheme, port, public address at dial time, refused
   headers, unfollowed redirects, time and size.
2. The run's network policy steps from the security model
   ([The run's network policy](security-model.md#the-runs-network-policy)): egress hosts,
   ambiguous paths, deny segments, declarations and purpose against the tool's side effect, and the
   ceiling.
3. The adapter's pacing and circuit breaker, shared with every other run of the adapter.
4. Only then, the credential, if one is named (below).

A refusal at step 1 or 2 is reported in `blocked` with `initiator: tool`, and audited as
`request-blocked`. It is the same report the browser driver makes, so trials, the audit view and
agents read it the same way.

**One code path.** Steps 2 and 3 must use the same functions the browser driver and the guarded page
use, not a copy. Nick wants as few duplicate code paths as possible, and a second matcher would
drift from the first. If those functions are tangled up with `webRequest` today, the first job is to
pull them out into `packages/core` or `packages/runtime` as pure functions that both callers share.
Afterwards, `ctx.local.fetch` could go through the same steps too, which would close its own
declaration gap.

### Credentials

```jsonc
"credentials": {
  "github": {
    "description": "Your GitHub personal access token",
    "hosts": ["api.github.com"],
    "inject": { "header": "authorization", "format": "Bearer {value}" }
  }
}
```

Rules, each enforced in the main process:

1. **Tool code names a credential and never gets its value.** It passes
   `{ credential: "github" }`. The value is resolved just in time as a `SecretValue`, added to the
   request after steps 1 to 3 pass, and disposed when the request ends.
2. **Exact hosts only.** `hosts` are exact names (no `*.`), each on `egress`. A request to any other
   host with that credential is refused before anything is resolved. The schema refuses a
   credential host that isn't on `egress`, as it does for secret origins and navigation.
3. **Headers only, never the URL.** URLs end up in logs, `blocked` reports and `Referer` headers,
   so there's no query-parameter injection. An API that only takes a key in the query string is out
   of scope.
4. **Tool code can't set the injected header itself.** For a request that names a credential, that
   header goes on the refused list, so a request carries exactly one value, Valet's.
5. **Redirects never carry it.** They're already returned unfollowed, so tool code would have to
   make a new request, and rule 2 applies to that one.
6. **Responses are redacted before tool code sees them.** The headers and body are scrubbed against
   the credential's value, the same way tool output is redacted today, but at the point the
   response arrives. This catches an API that echoes the key back. An API that sends back an
   encoded copy can't be caught. That's a residual risk, documented and accepted: the person binds
   a credential only to hosts they approved.
7. **Grants work like secret grants.** A grant is per adapter and per content hash. The person binds
   the credential to a 1Password item or Valet's Keychain copy, on the same screens as passwords.
   Each use is audited as `secret-used`, with the host and the header name, never the value.
8. **The approval card says it plainly:** "Valet adds your GitHub personal access token to requests
   to api.github.com. The adapter never sees it."

**How this fits the security model.** Its first guarantee is that adapter code never gets a
secret's value, and rules 1, 4 and 6 keep that. The second is that a secret, or what it lets you
do, can't reach a host the manifest doesn't declare, and rules 2, 3 and 5 keep that. What tool code
*can* do with the key is call the declared endpoints with the purposes it declared. A signed-in
browser session gives a browser adapter exactly the same power today. So a key doesn't add a new
kind of trust, it adds a new way of carrying one. Even so, this slice needs its own red-team pass
before it merges ([red-team.md](red-team.md)), focused on attacks an agent could drive.

Credential fields: today a secret has the `username`, `password` and `otp` fields. A credential
reads a new `token` field. For 1Password, that maps to an API Credential item's `credential` field,
or a named field on any item. Basic auth uses `"format": "basic"`, and the main process builds the
header from the `username` and `password` fields.

### Home-network services

```jsonc
"privateHosts": [
  { "address": "192.168.1.20", "port": 8443, "scheme": "https", "certSha256": "AB:CD:…" }
]
```

- Each entry is an IP literal, never a name. A name can resolve somewhere new after approval (DNS
  rebinding), but a literal can't.
- Each entry is its own line on the approval card ("Reach 192.168.1.20 on your network"), and the
  grant is per adapter hash, like other exceptions. It reuses the `private-network` approval kind,
  approved for the adapter's life instead of 30 minutes. It never covers a port Valet listens on,
  the same rule as `local-service`.
- `https` with a pinned certificate fingerprint covers the self-signed certificates most NASes use.
  Plain `http` is allowed, but **a credential is never sent over plain `http`**.
- Declarations name the address as their `host`, and steps 2 and 3 apply as they do for any host.

### What stays out

- **Mixing browser cookies with plain HTTP in one adapter.** It gives up the real-browser
  fingerprint, which is why Valet exists for sites like Woolworths. A mixed site uses one browser
  adapter and one `http` adapter.
- **OAuth.** It needs a browser sign-in, consent screens and refresh. If it's ever built, it could
  be an auth flow that ends by storing a token in the Keychain for an `http` adapter, but not now.
- **Query-string keys, request signing (AWS SigV4 and the like), and client certificates.** Each is
  a different custody rule.

## Authoring

- `valet_create_draft` takes `runtime: "http"`, and the authoring guide gets a short "API adapters"
  section. It replaces the advice to point `home` at a JSON endpoint, for drafts that don't need a
  browser.
- Live trials and cases run through the same client and checks as live calls, so a case passes only
  when the real call would.
- A draft can't use a credential until the person grants it. A trial without the grant fails with
  `needsUser`, which says which credential is missing, so the agent knows what to ask for.

## Building it

Three slices, each its own PR, merged on green CI:

1. **`runtime: "http"` with no credentials and no private hosts.** This covers the manifest, the
   shared policy and pacing, `blocked` and audit, and the authoring tools and guide. It lets the
   Hacker News draft drop its workaround. It doesn't change the trust model, so it's low risk.
2. **Credentials.** This covers the schema, grants, header injection, response redaction and the
   approval card wording. It merges only after a red-team pass.
3. **Private hosts.** This covers IP literals, the pinned certificate, the `http` rule, and the
   durable `private-network` grant.

Each slice is sized for one build thread. None needs Nick's time apart from approving this design.

## Open questions for Nick

1. **Should public, no-login APIs be allowed as `http` adapters at all?** Recommendation: yes, once
   slice 1 exists. It costs nothing more, and it gives them the audit log. But they're not a reason
   to build it.
2. **Plain `http` to a home-network address**, without a credential: allow it with a clear warning
   on the card, or refuse it? Recommendation: allow it, since many home devices only offer `http`.
3. **Slice order.** If Nick has no particular home-network device in mind, credentials go first.
