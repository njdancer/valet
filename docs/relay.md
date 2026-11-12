# Remote access and the relay

> **2026-11-12:** the relay is now planned as the default transport (D76, leaning), with the
> phone channel and signed approvals that the last open question below asked for. The current
> protocol and threat model are in [agent-run-security.md](agent-run-security.md#the-relay-protocol);
> this document stays as the background and the options considered.

Draft. This covers how MCP clients that can't reach `127.0.0.1` (claude.ai on the web and phone,
cloud agents, a laptop away from home) could call tools on the person's Mac. It answers
[D14](plan.md#d14-relay) and shapes [M9](plan.md#m9-relay-beta-optional) and
[WS10](plan.md#ws10-relay). The security rules it has to keep are in
[security-model.md](security-model.md).

Facts about third-party products here (claude.ai connectors, Anthropic's MCP tunnels,
Cloudflare, Tailscale, ngrok, prices) are from memory as of November 2026 and were not re-checked
for this draft. Each one marked _verify_ must be confirmed before anything is built on it.

## Summary

- **Now:** stay local. Claude Code and Claude Desktop already work through the local endpoint
  and the stdio bridge.
- **Next, for Nick's own phone use:** build the app-side "remote mode" (an OAuth authorisation
  server inside the app, consent on the Mac, a per-tool remote policy, remote calls marked in the
  audit log, a kill switch), and document **Tailscale Funnel** as the transport. TLS then ends on
  the Mac, so no third party but the MCP client's operator sees tool results, and there's no
  service to run.
- **Later, as a market test:** a hosted relay that is a thin pipe in front of the same app-side
  remote mode. Build it only on the triggers in [Recommendation](#recommendation), and not at all
  if Anthropic's MCP tunnels reach claude.ai connectors first.

The app-side remote mode is the part worth building whichever option wins. Every option except
"do nothing" needs it, and it's where the security properties live.

**This departs from the plan in three places**, each listed for Nick in
[Open questions](#open-questions):

- **[WS10](plan.md#ws10-relay) and [M9](plan.md#m9-relay-beta-optional) put the OAuth 2.1
  authorisation server in the Worker.** Here it's in the app. The tunnel options have no Worker,
  so they need it in the app anyway; consent then happens on the Mac, not on a web page the relay
  serves; and the relay never holds a token-minting key, so a compromised relay can replay tokens
  it sees (in D1) but can't issue new ones.
- **[D14](plan.md#d14-relay) recommends documenting the tunnels at M3.** Here that waits until
  remote mode exists. A tunnel can't reach today's local endpoint without loosening its `Host`
  guard ([below](#b-do-it-yourself-tunnels)), and claude.ai can't send its bearer token, so
  until the app has its own authorisation server there's nothing safe to document.
- **WS10's "behind OAuth or the bearer token"** becomes OAuth only, for the same reason.

## What remote access must not change

These hold whatever the transport:

- **Secrets never leave the Mac.** Passwords, one-time codes, the 1Password token and session
  cookies are not in tool results today (redaction, `httpOnly` cookies). Remote access adds no
  path for them.
- **The Mac decides.** Which tools are callable remotely, rate budgets
  ([D28](plan.md#d28-rate-budget-defaults)), circuit breakers and confirmations are enforced in the
  app. A relay may filter as a courtesy, but it is never the authority.
- **Confirmations stay local.** An `irreversible` tool still needs the person to click in the app
  on the Mac. The MCP client can't approve it, and neither can a relay. If Nick is away, it times
  out and is declined ([D19](plan.md#d19-confirmation-when-nick-is-away)).
- **Every remote call is attributable.** The audit log records that a call came in remotely and
  through which client registration.

## Options

| Option                                    | Reaches claude.ai web/phone         | Who sees tool results in plaintext         | Service to run | Setup for the person             |
| ----------------------------------------- | ----------------------------------- | ------------------------------------------ | -------------- | -------------------------------- |
| A. Local only                             | No                                  | MCP client operator only                   | None           | None                             |
| B1. Tailscale Funnel + in-app OAuth       | Yes                                 | Client operator only (TLS ends on the Mac) | None           | Install Tailscale, enable Funnel |
| B2. cloudflared + in-app OAuth            | Yes                                 | Client operator and Cloudflare             | None           | Cloudflare account and a domain  |
| B3. ngrok + in-app OAuth                  | Yes                                 | Client operator and ngrok                  | None           | ngrok account                    |
| C. Anthropic's MCP tunnels                | No (API and Managed Agents only) \* | Anthropic only                             | None           | Per Anthropic's preview          |
| D1. Own relay, TLS ends at the relay      | Yes                                 | Client operator, relay operator, its host  | Yes            | Sign in, pair the Mac            |
| D2. Own relay, TLS passthrough to the Mac | Yes                                 | Client operator only                       | Yes            | Sign in, pair the Mac            |

\* As of November 2026, per the brief for this doc; _verify_ before relying on it either way.

Whatever the option, the MCP client's operator sees tool arguments and results, because the
model has to read them. For claude.ai that's Anthropic. Every option below is about whether
anyone _else_ also sees them.

### A. Local only

The local endpoint is Streamable HTTP on `127.0.0.1` with a bearer token, plus the stdio bridge.
It already refuses anything whose `Host` isn't exactly `127.0.0.1:<port>` and any non-localhost
`Origin` (`packages/mcp-server/src/http-guards.ts`), so it can't be reached by accident.

- Good: nothing new to secure; matches the product's "your machine, your accounts" story.
- Bad: no claude.ai on the phone, which is the use Nick actually wants remote access for.

### B. Do-it-yourself tunnels

All three put a public HTTPS URL in front of the Mac. All three share two problems:

1. **The local endpoint is deliberately unreachable through them.** A tunnel forwards with its
   own `Host` header, which `hostAllowed` refuses. That's correct, and it must not be loosened for
   the local listener: DNS rebinding is exactly a request with the wrong `Host`. Remote mode
   needs its **own listener** (a second port, or a Unix socket the tunnel daemon connects to) with
   its own guards, not a relaxed local one.
2. **claude.ai's custom connectors want OAuth**, not a static bearer token (_verify_; as far as we
   know a connector can be authless or OAuth, and can't send an arbitrary `Authorization`
   header). Authless is out of the question: the URL would be the only secret, and it ends up in
   logs and screenshots. So every tunnel option needs an OAuth authorisation server somewhere.
   The cheapest place is inside the app ([below](#app-side-remote-mode)).

#### B1. Tailscale Funnel

- Funnel publishes a port on `<machine>.<tailnet>.ts.net`. As far as we know Tailscale's ingress
  routes the TLS connection by SNI without decrypting it, and the certificate's key lives on the
  Mac, so Tailscale can't read the traffic (_verify_ against current Tailscale docs).
- Limits: a fixed set of public ports, bandwidth caps, the hostname reveals the tailnet name, and
  the tailnet admin must allow Funnel in the policy file.
- **Tailscale Serve** (tailnet-only, no Funnel) is enough for Claude Code on Nick's laptop, and
  better, since nothing is public. It doesn't help claude.ai: Anthropic's servers aren't on his
  tailnet.

#### B2. cloudflared (Cloudflare Tunnel)

- A named tunnel to a hostname on a Cloudflare zone, or a throwaway `trycloudflare.com` quick
  tunnel (random name, no uptime promise; fine for a test, wrong for a connector).
- TLS ends at Cloudflare's edge, so Cloudflare sees plaintext.
- Extras that help: WAF rules can restrict the hostname to Anthropic's published egress ranges
  (_verify_ that Anthropic publishes them for connector traffic), and rate limiting. Cloudflare
  has documented putting Access in front of self-hosted MCP servers as their OAuth provider
  (_verify_ current status). That would replace the in-app authorisation server, but it puts the
  login and consent at Cloudflare rather than on the Mac, which loses the "consent on the Mac"
  property below.

#### B3. ngrok

- A static domain on the free tier (_verify_), TLS ends at ngrok's edge, so ngrok sees plaintext.
- Its traffic-policy OAuth actions are for browsers logging in, not MCP clients, so they don't
  replace the authorisation server.
- Least reason to prefer it over B1 or B2 for this use.

#### What the docs page should say

A short "remote access" page, written for technical users:

- Recommend Funnel (TLS ends on the Mac), then cloudflared.
- Show the exact commands, pointing the tunnel at the remote-mode listener only.
- Say plainly: this makes the tools callable from the internet by anyone holding a valid token;
  turn on only the tools you'd want callable from your phone; leave `irreversible` tools off.
- Say what the tunnel operator can see (B2, B3).

### C. Anthropic's MCP tunnels

Per the brief: a research preview that lets an MCP server behind a firewall be reached by
Anthropic's API and Managed Agents, without opening a port. As of November 2026 it doesn't serve
claude.ai's connectors (_verify_ both claims and the details before designing against it).

- Good: no inbound exposure; the only party in the middle is one that already sees tool results;
  no service for Nick to run.
- Bad: doesn't reach the client Nick wants (claude.ai on the phone); a preview can change or
  close; it ties remote access to one vendor, while the app is meant to be client-neutral
  ([D21](plan.md#d21-mcp-client-support)).
- **What it changes:** if it reaches claude.ai connectors, the hosted relay loses most of its
  reason to exist for Claude users. Adopt it then, behind the same app-side remote mode, and keep
  the relay only if non-Anthropic clients ask for it.

### D. Our own relay

Described in full below. In short: the app dials out over a WebSocket; the relay gives each Mac a
public MCP URL and forwards requests over that socket. It's the only option that's a service
with uptime, abuse handling, cost and liability, and the only obvious thing to charge for
([D16](plan.md#d16-pricing)).

## App-side remote mode

Needed by B, C and D. Build it once, in the app, as one module with its own tests.

### Built so far

The first slice (2026-11-08), the parts every option needs, sharing the local endpoint's code:

- **The listener.** `startRemoteListener` (`packages/mcp-server/src/remote.ts`) runs the same
  `startHttpServer` handler a second time, bound to `127.0.0.1` on its own port (kept across
  launches in `remote.json`, so a tunnel's configuration stays right). Only its `authenticate`
  hook (`remote-auth.ts`) and the caller wrapper differ. The hook refuses any `Host` but the
  public names the person set, so neither listener answers for the other; refuses any `Origin`;
  and accepts only access tokens from `RemoteAccessTokens` (opaque, hashed, one hour, in memory),
  never a local client's token.
- **The remote policy.** `RemotePolicyCaller` (`remote-policy.ts`) wraps the local endpoint's
  caller: tools are off for remote clients until the person turns each one on; `tools/list` shows
  only those; a call to anything else fails `config: not-found`; each client has a cap of 120
  calls an hour (a setting later); and a call whose identity isn't remote is refused. The app's
  store (`apps/desktop/src/main/core/remote.ts`) records each tool's side effect when it was turned
  on, and an adapter update that raises it turns it off again.
- **Audit.** Remote calls are recorded through the same runtime with `clientId: remote:<id>`;
  policy refusals are recorded like the app's own (`tool-called`, then `tool-finished` failed at
  stage `config`). New events: `remote-state` (`on`, or `paused` with how many tokens were
  revoked) and `remote-tool` (a tool turned on or off, with its side effect).
- **The kill switch.** While remote access is on, the tray shows `REMOTE` beside the icon and its
  menu has "Pause remote access", which revokes every access token, aborts remote calls in flight,
  closes every remote session and stops the listener, with no network needed. A pause survives a
  restart.

The second slice (2026-11-10) adds the authorisation server and consent, on the same listener:

- **The authorisation server.** `RemoteAuthorization` (`packages/mcp-server/src/oauth-server.ts`)
  answers ahead of the MCP path through the HTTP handler's `before` hook, after the same `Host`
  and `Origin` guards. It serves protected resource metadata (at
  `/.well-known/oauth-protected-resource/mcp`, which every 401's `WWW-Authenticate` points at) and
  authorisation server metadata; Dynamic Client Registration at `/register`; `/authorize` and its
  waiting page `/authorize/wait`; and `/token`. PKCE S256 only. Every access token is minted for one
  resource, `https://<public name>/mcp`, and refused on any other name. Codes live a minute and are
  good once; a second use revokes the grant. Refresh tokens rotate on every use, live 30 days from
  their last use, and a rotated-away one coming back revokes the grant (`remote-token-reuse`).
- **Registrations and grants** (`oauth-clients.ts`): our own `rc…` id is both the OAuth
  `client_id` and the `remote:<id>` in the audit log. Public clients (`none`) and confidential ones
  (`client_secret_basic`, `client_secret_post`) are accepted; secrets and refresh tokens are kept
  only as SHA-256. The app keeps them in `remote-clients.json`, so pausing and restarting keep every
  connector. The limits are this page's: 5 registrations an hour per source and 20 a day, 50 kept,
  unconsented ones gone after an hour; `/authorize` 10 an hour per source and 30 globally.
- **Consent** (`oauth-consent.ts`): `/authorize` opens a request (at most five, five minutes each)
  and shows its browser an 8-character code from Crockford's alphabet. The page is a fixed template
  with a strict CSP and no script; it refreshes itself every 3 seconds until the Mac answers, then
  sends the browser on with the code (or `access_denied`). The app shows one notification and its
  **Remote sign-in** screen, listing each request by its redirect URI's host, never with its code.
  The typed code selects the request; three wrong codes cancel them all. `read` tools start ticked
  and `write` and `irreversible` ones unticked, and a client may then list and call only the tools
  it was granted, and only while they are remote-enabled. Pausing declines whatever is waiting.
- **Revocation.** Each remote client on the Remote sign-in screen has its own Revoke; "Revoke all
  remote clients…" is there and in the tray menu, and asks first. New audit events:
  `remote-consent`, `remote-revoked`, `remote-token-reuse`.
- **Source address.** `cloudflaredSource` reads `Cf-Connecting-Ip` (D14: Cloudflare Tunnel). The
  listener binds `127.0.0.1`, so only a process on the Mac can set it, and one that lies only
  escapes the per-source limits; the global ones still hold.

The control panel's setup (2026-11-11): the **Remote sign-in** screen opens with a **Remote
access** card that turns remote access on or pauses it, adds and removes the public names the
tunnel forwards (each shown with its connector URL, `https://<name>/mcp`), shows the loopback
address to point the tunnel at, and lists every tool of each approved adapter with its own switch,
all off to start. Turning a tool on needs its adapter approved; turning it off always works.

Not built: Client ID Metadata Documents (the metadata says `client_id_metadata_document_supported:
false`; they need the fetcher [below](#before-consent-fetching-and-limits)), the typed `transport`
field in `tool-called` ([Core changes](#core-changes)), and running the tunnel (the person runs
`cloudflared` themselves, D14).

### A separate listener with its own guards

- The local listener stays exactly as it is. Remote traffic arrives on a second listener (for
  tunnels) or over the relay socket (for D), and is handled by a second transport with its own
  `ToolCaller` wrapper that applies the remote policy.
- It accepts only the MCP path and the OAuth endpoints below. No static files, no HTML except the
  consent hand-off page, and that page is a fixed template.
- Requests carry a bearer access token issued by the in-app authorisation server, never the local
  token. The local token never leaves the Mac.

### The authorisation server

The MCP authorisation spec (protocol revision 2025-11-25, which the bundled SDK, version 1.32,
speaks) asks for the following. The app implements them:

- **Protected resource metadata** (RFC 9728) at `/.well-known/oauth-protected-resource`, and a
  `WWW-Authenticate` header on 401s that points at it.
- **Authorisation server metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`.
- **PKCE with S256**, required; plain is refused.
- **Resource indicators** (RFC 8707): tokens are minted for exactly this server's MCP URL, and a
  token presented for any other audience is refused. No token passthrough: the app never forwards
  a client's token anywhere.
- **Client registration:** Client ID Metadata Documents (the 2025-11-25 spec's preferred way: the
  client ID is an HTTPS URL the server fetches) and Dynamic Client Registration for clients that
  still use it. claude.ai has used DCR (_verify_ which it uses now). Redirect URIs are matched
  exactly; for claude.ai that has been `https://claude.ai/api/mcp/auth_callback` (_verify_).
  Both registration paths run on an internet-facing listener before anyone has consented, so
  each has its own rules ([below](#before-consent-fetching-and-limits)).
- **Tokens:** opaque random access tokens, 1 hour; refresh tokens rotated on every use, with reuse
  of an old refresh token revoking the whole grant (a stolen refresh token used after the real
  client has rotated it shows up as reuse). Tokens are stored hashed. They're per client
  registration, so revoking one client doesn't touch another.
- **Scopes:** one scope per remote-enabled tool is tempting but makes the consent screen a wall of
  checkboxes that clients then ask for wholesale. Instead the grant records the tool set the
  person ticked at consent, and the scope is just `tools`. The remote policy, not the scope, is
  what the app enforces on each call.

### Before consent: fetching and limits

The public URL is not a secret. Funnel's `<machine>.<tailnet>.ts.net` certificates and D2's
`<id>.<relay-domain>` certificates are in Certificate Transparency logs, and any URL ends up in
logs and screenshots. So assume anyone can reach the registration and `/authorize` endpoints,
and that they run on the person's Mac, inside the person's network.

**Client ID Metadata Document fetches** are the server fetching a URL a stranger chose, from the
Mac. Without rules that's server-side request forgery against the person's LAN, their tailnet
(`100.64.0.0/10`), and `127.0.0.1`, which includes the local MCP endpoint. The fetcher:

- accepts only `https://` URLs with a DNS name: no IP literals (including decimal and hex forms
  such as `https://2130706433/`), no userinfo, no port but 443, no fragment, a trailing dot
  normalised away, and at most 512 characters;
- resolves the name once, and refuses if **any** answer is loopback (`127.0.0.0/8`, `::1`),
  private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`), CGNAT and
  tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), unique-local (`fc00::/7`), unspecified,
  multicast or broadcast, or an IPv4-mapped or NAT64 form of any of these;
- connects to the address that passed, pinned, with the name as SNI and `Host` and normal
  certificate checks, so a DNS-rebinding resolver's second answer is never used;
- follows no redirects; sends no cookies and no credentials;
- reads at most 16 KiB, with a 5-second deadline for the whole fetch, and accepts only a JSON
  object whose `client_id` equals the URL exactly and whose `redirect_uris` are all HTTPS;
- caches each result (success or failure) by URL: successes for the response's `max-age`,
  clamped to between 5 minutes and 24 hours, failures for 1 minute, so a client can't make the
  Mac fetch in a loop;
- runs at most two fetches at a time, after the rate limits below have passed;
- never fetches anything else the document names (`logo_uri`, `jwks_uri`, `tos_uri`). Logos
  aren't shown, so there's nothing to fetch.

The resolver and the socket are injected, so the tests are deterministic and adversarial: a name
resolving to each refused range, one resolving to a public and a private address, a rebinding
resolver, a redirect to `http://127.0.0.1`, an oversized body, a body that trickles, and each
IP-literal spelling.

**Dynamic Client Registration** stays open, because that's how clients like claude.ai have
registered, but bounded:

- registrations per source address (5 an hour) and globally (20 a day);
- at most 50 stored registrations. One with no consent expires after an hour. At the cap, new
  registrations are refused; consented ones are never evicted to make room;
- the same metadata rules as a fetched document: HTTPS redirect URIs, size caps, and a
  `client_name` that is stored but never shown as the headline.

**`/authorize` and consent prompts:**

- `/authorize` is rate-limited per source address (10 an hour) and globally (30 an hour), before
  any fetch or prompt;
- at most five pending consent requests at once, each expiring after ten minutes (time to reach
  the phone); beyond that, `/authorize` answers "try later" (`too-many`) without notifying
  anyone. Consents have their own bucket (`APPROVAL_LIMITS.consentPending`), outside the five
  waiting cards agents share, so a flood of consents can't crowd out an agent's request, or the
  reverse;
- the Mac and each phone show **one** consent card at a time, listing every pending request in
  it, never a notification per request, so a flood can't bury the screen or train the person to
  click through.

The source address comes from the transport: from cloudflared's `Cf-Connecting-Ip` for Cloudflare
Tunnel (D14; trusted only because the listener is on loopback), from tailscaled's forwarding headers
for Funnel (_verify_ which it sets; not built), and from the relay's frame for D. Where it's unknown, the global limits alone apply. The numbers are a
starting point for one person; they're settings, not constants.

### Consent happens on the Mac or a paired phone

The authorise endpoint never decides by itself, and Valet never approves a request it can't tie
to the browser the person is holding:

1. The client sends the person's browser (on their phone, say) to `/authorize`.
2. The page there shows a code (8 letters from a 24-letter alphabet with no I or O, about 37
   bits, `consentCodeSchema` in `packages/core`; letters only, so a phone keyboard needs no
   switching) and says: "Type this code into Valet on your Mac or iPhone. If you didn't just add
   a connector, close this page."
3. The menu-bar app, and each paired phone, show a notification and one card. It shows, for each
   pending request, when it arrived and from which address, and the client's _claimed_ identity:
   its redirect URI's host, shown in full and never shortened. It **doesn't show the code**: the
   request the device renders has no code in it, and the Mac keeps the code beside the pending
   request. It has an empty code field, and the remote-enabled tools with checkboxes, `write`
   tools unticked by default.
4. The person types the code from their own browser. The typed code selects the request it
   belongs to; nothing can be approved until it matches. Three wrong codes cancel every pending
   request.
5. The person approves with Touch ID at the Mac or Face ID on the phone; there is no passcode
   fallback for consent. On the phone, the typed code is part of the signed approval
   (`typedCode`), and the Mac accepts it only if it matches the code it issued (`wrong-code`
   otherwise, which counts as a wrong code). The browser's page continues to the client's
   redirect.

**Why typed, not shown on both sides.** An attacker can add a custom connector in their _own_
claude.ai account, pointed at the person's public URL. Their consent request then names
`claude.ai`, exactly like the person's own setup, and approving it links the person's tools to
the attacker's account. The client identity can't tell the two apart. The code can: it's shown
only in the browser that started the flow, which is the attacker's. If the Mac merely displayed
the code next to the browser's, nothing would make the person compare them. Making them type it
does.

So the rule the app states in the window, and the docs repeat: **a consent prompt you didn't just
start was started by someone else. Decline it.** Requests that expire or are declined are
audited with their time and source address.

Adding a connector therefore needs the person at their Mac, or at a phone paired with it, once.
After that, refresh tokens keep it working from anywhere. Nobody who merely knows the URL, or has phished the person's relay
account, can grant themselves access. If the Mac is asleep or offline, consent fails rather than
waiting, even with the phone at hand: the phone only signs, and the Mac decides.

### Per-tool remote policy

- **Default off.** A newly approved adapter's tools are local-only until the person turns them on
  for remote use, per tool.
- `read` tools can be enabled freely. `write` tools are enabled one by one, with the side effect
  spelled out. `irreversible` tools can be enabled, but every remote call still waits for the
  confirmation on the Mac, and the setting says so.
- `tools/list` over remote returns only the remote-enabled tools. A call to anything else is
  refused with the same error as an unknown tool, so a remote client can't enumerate what's
  installed.
- A per-client cap on calls per hour, applied before the per-site rate budget. A remote client
  stuck in a loop then burns its own quota, not the person's standing with the site.

### Audit and the kill switch

- `tool-called` records the client as `remote:<client registration id>`. Core's `AuditEvent` has
  only a free `client` string, so for now that prefix is the marker. A typed transport field is in
  [Core changes](#core-changes).
- Consent, refresh-token reuse and revocation are audited too, as new event types once core has
  them.
- **Two tray items, because they do different things:**
  - **"Pause remote access"** closes the listener or relay socket, fails in-flight remote calls
    with `aborted`, and **revokes every issued access token**. Access tokens are opaque and stored
    hashed, so revoking them is deleting rows. Client registrations and refresh tokens are kept,
    so on resume each client refreshes and carries on without the person adding it again. Without
    the access-token revocation, any token in flight at the pause (including one a D1 relay saw)
    would work again if remote access resumed within its hour.
  - **"Revoke all remote clients…"** is the destructive one, and says so: it asks for
    confirmation, then deletes every registration with its refresh and access tokens and its
    grant. Every connector then has to be added again, with consent on the Mac.
  - Each client in the remote-clients list also has its own "Revoke", which does the same for
    that client alone.

  None of these needs the network to take effect.
- The tray icon shows when remote mode is on, so it can't stay on unnoticed.

## Our own relay, in detail

### Shape

```
claude.ai ──HTTPS──▶ relay (Worker + Durable Object per Mac) ◀──WSS (outbound)── menu-bar app
                     https://<id>.<relay-domain>/mcp                              remote mode
```

- **Cloudflare Worker plus a Durable Object per paired Mac**, as WS10 suggests. The Durable Object
  holds the app's WebSocket using the hibernation API, so an idle connection costs almost
  nothing, and answers keep-alive pings with an automatic response so they don't wake it.
- **The app dials out.** No inbound port on the Mac, no router setup, works behind CGNAT (which
  Nick is on).
- **Pairing:** the app generates an Ed25519 key pair; the private key stays in the Keychain under
  the app's designated requirement. The relay account stores only the public key and a random
  `<id>`. The socket authenticates with a signed challenge, never a bearer secret.
- **The relay forwards, the Mac decides.** OAuth tokens are minted and checked by the app's
  authorisation server, as above. The relay stores no tokens and no user data beyond the routing
  table (`<id>` → public key → Durable Object) and billing.
- **The relay renders, the Mac decides, for consent too.** The `/authorize` page is a fixed
  template served by the relay, filled with structured data the Mac returns (the code, the
  client's host, approved or not). The relay never forwards HTML from a Mac. Otherwise any paired
  "Mac" (any program that speaks the protocol) could host arbitrary pages, phishing included, on
  the relay's domain.
- **Per-Mac hostnames on a separate registrable domain** listed on the Public Suffix List, not the
  product's brand domain. Cookies and reputation then can't cross between users or onto the main
  site.

### Forwarding MCP

- Each HTTP request on `/mcp` becomes a framed message on the socket: request id, method, the
  headers MCP needs (`Mcp-Session-Id`, `MCP-Protocol-Version`, `Authorization`, `Accept`), and the
  body. Responses, including SSE streams, come back as frames for that request id.
- Caps at the relay: body size (the local endpoint allows 1 MiB; use the same), frames per second
  per Mac, concurrent requests per Mac, and only JSON-RPC bodies on `/mcp` (anything that doesn't
  parse is refused at the relay, so it can't be a general-purpose tunnel).
- **Long calls.** Rate budgets make some calls slow by design: a login, or a write that waits out a
  10–15 s gap ([D28](plan.md#d28-rate-budget-defaults)). The app sends MCP progress notifications
  on long calls so streams stay alive, and the relay doesn't impose a shorter timeout than the
  client's. What claude.ai's own timeout is, is unknown (_verify_).
- **Mac offline or asleep.** The relay answers at once with a tool error saying the Mac running
  Valet isn't connected. It never queues calls for later: a queued `set_cart_quantity`
  replayed hours later is worse than a failure. The app can hold a power assertion while remote
  mode is on, as an opt-in, with the battery cost stated.

### Does the relay see tool results?

**Yes, in design D1, and there is no way round that while standard clients terminate TLS at the
relay's hostname.** A remote MCP client opens an HTTPS connection to the URL it was given, and
whoever holds that hostname's certificate key reads the requests and responses. MCP has no
message-level encryption a client would apply, and there's no key the app could share with
claude.ai that would let it decrypt something the relay couldn't.

What that means concretely:

| Data                                                                               | Does the relay see it (D1)?                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Passwords, one-time codes, the 1Password token                                     | No. They never leave the Mac.                          |
| Site session cookies                                                               | No. `httpOnly`, and redacted from results if they leak |
| OAuth access and refresh tokens for the connector                                  | Yes, in transit. It could replay them.                 |
| Tool names and arguments (search terms, stockcodes)                                | Yes                                                    |
| Tool results (cart contents, order history; bank transactions, for a bank adapter) | Yes                                                    |
| Who calls what, when, from where                                                   | Yes                                                    |

What D1 can do about it:

- **Minimise.** Forward and forget: payloads live in memory only for the life of a request.
  Nothing is written to Durable Object storage except the routing table. Workers Logs, Logpush,
  tail workers and request sampling are off for payload-bearing routes, and error paths log a
  stage and class, never a body (the same rule as `ValetError`).
- **Say so.** The relay's privacy page says what it can see, what it keeps (routing and billing),
  and that its host (Cloudflare) terminates TLS too.
- **Shape what's exposed.** The remote policy keeps sensitive tools local. Adapters can offer
  remote-safe variants (a cart summary without the delivery address). For a bank adapter, the
  honest default is local-only.
- **Prove it, partly.** The relay is open source and its deployment reproducible, but nobody can
  verify from outside what a hosted service actually runs. Don't claim more than "we publish the
  code and don't log payloads".

**D2, TLS passthrough,** is the only design where the relay can't read traffic:

- The relay routes raw TLS by SNI to the Mac's socket, and the Mac terminates TLS with a
  certificate for `<id>.<relay-domain>` whose key never leaves the Mac. That's how Funnel works.
- Certificates come from ACME DNS-01: the relay offers an API that writes only the
  `_acme-challenge` TXT record for that Mac's own name.
- **Costs:**
  - Workers can't accept raw TCP, so this needs a small VM or a TCP proxy product, not
    Workers.
  - Let's Encrypt's per-registered-domain weekly limits start to bite with many users; the
    domain then needs the Public Suffix List entry above, or a limit increase.
  - Certificate Transparency logs publish every `<id>` (use random ids, never names).
  - The Mac must be online for the OAuth endpoints too, which it already must be for consent.
- **What it still doesn't protect:**
  - The relay operator controls DNS, so it _could_ get its own certificate for a user's name and
    intercept. CT logs would show the second certificate, so this is detectable, not
    preventable. The app can watch CT for its own name and warn.
  - Metadata (timing, sizes, which `<id>` is active) is still visible.

### Threat model

| Attacker                                                 | Wants                                         | What stops or limits them                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone on the internet                                   | Call tools                                    | Not the URL: Funnel hostnames and D2's `<id>`s are in Certificate Transparency logs, and any URL leaks through logs and screenshots. OAuth with consent only on the Mac, bound by a typed code; refused calls look like unknown tools; rate limits on registration and `/authorize` in the app, and per-IP and per-Mac limits at the relay.     |
| Anyone on the internet                                   | Make the Mac fetch internal hosts (SSRF)      | Client ID Metadata Document fetches: HTTPS names only, every resolved address checked against loopback, private, link-local, CGNAT/tailnet and ULA ranges, pinned to the checked address, no redirects, size and time caps, a cache, and nothing else in the document fetched.                                                                  |
| Anyone on the internet                                   | Exhaust storage or flood the Mac with prompts | Per-source and global limits on DCR and `/authorize`; a cap of 50 registrations, unconsented ones expiring; at most five pending consents, shown in one window.                                                                                                                                                                                 |
| An attacker's own legitimate client against your URL     | Link your tools to their claude.ai account    | Their consent request looks like yours (`claude.ai`), so identity can't separate them. The code appears only in the browser that started the flow (theirs), and the Mac approves only a request whose code the person types. A prompt you didn't start is someone else's: decline it.                                                           |
| A client that holds a stolen access or refresh token     | Call tools as the person                      | 1-hour access tokens; refresh rotation with reuse detection; per-client revocation in the app; per-client hourly caps; pausing (which revokes access tokens).                                                                                                                                                                                   |
| Prompt injection in the person's own claude.ai chat      | Make Claude call a write tool                 | Same as local, but the remote surface is smaller: remote-enabled tools only, `write` off by default, `irreversible` waits for the Mac. Remote doesn't add a confirmation channel.                                                                                                                                                               |
| A phishing "connector" that asks the person to approve   | Get a grant for an attacker's client          | Consent on the Mac shows the client's host, the time and the source address; refuse clients whose redirect URI isn't HTTPS; never show the client's self-chosen name as the headline. Residual: an attacker who persuades the person to type a code from the attacker's page gets the grant. The window's warning is the only control for that. |
| The relay, compromised (or its operator, or its host)    | Read data; call tools                         | **Reads everything in D1.** Can replay tokens it saw, so can call any remote-enabled tool until the person notices or revokes. Can't get secrets, can't approve an `irreversible` call, can't exceed the app's caps and rate budgets, and every call it makes is in the Mac's audit log. In D2 it sees only metadata.                           |
| Another paired "Mac" (any program speaking the protocol) | Use the relay as free hosting or a tunnel     | `/mcp` accepts JSON-RPC only; no HTML is ever forwarded; size and rate caps; separate PSL-listed domain; accounts can be closed.                                                                                                                                                                                                                |
| Theft of the Mac's relay key                             | Impersonate the Mac to the relay              | Key in the Keychain under the app's designated requirement; re-pairing rotates it; the relay shows the person their paired devices. An impostor Mac can serve fake tool results to the person's client, but can't reach their accounts.                                                                                                         |
| Load against the person's sites through the relay        | Get the person's account or IP blocked        | Rate budgets and the circuit breaker are in the runtime, after remote mode, so a remote flood waits or fails like a local one.                                                                                                                                                                                                                  |

The row that matters is the compromised relay. In D1 the relay is a party that can read results
and drive remote-enabled tools. The design keeps that bounded (no secrets, no confirmations, the
app's limits, a complete local audit trail), but it doesn't remove it. The product copy must not
call the relay "end-to-end encrypted" in D1.

### Abuse

- **As a tunnel:** prevented by JSON-RPC-only forwarding, caps, and no HTML.
- **As phishing infrastructure:** prevented by fixed templates and the separate domain.
- **Sign-up abuse:** waitlist and invites for the beta; payment for general access. A free tier,
  if any, is a few calls per day.
- **Against sites.** A hosted relay makes the project a hosted part of automated access to
  third-party sites, even though it runs no browser. It can't see which sites an adapter
  targets beyond tool names. It should not try: that would mean reading payloads it has promised
  not to keep. The terms of service for the relay say the person is responsible for the sites they
  automate, and the bot-detection posture ([D24](plan.md#d24-bot-detection-posture)) applies. Get
  the legal opinion in [D25](plan.md#d25-adapter-legal-posture) to cover the relay too, before
  launch.
- **Abuse reports:** a contact address, the ability to close an account, and nothing else. The
  relay can't inspect traffic to judge a report, by design.

### Cost

Rough, from Cloudflare's published pricing as remembered (_verify_ before quoting a price):

| Item                                                             | Estimate                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| Workers paid plan (includes millions of requests a month)        | about US$5 a month, fixed                             |
| Durable Objects: an idle hibernated socket per Mac               | close to nothing; keep-alives use automatic responses |
| A heavy user: 100 tool calls a day, about 10 relay messages each | about 30,000 messages a month: within included usage  |
| 1,000 heavy users                                                | tens of millions of messages: tens of dollars a month |
| D2 instead: a small VM plus bandwidth                            | about US$5–20 a month at beta scale                   |
| Domain, PSL listing, monitoring                                  | small                                                 |

Infrastructure isn't the cost. The cost is Nick's time:

- on-call for a service people's agents depend on;
- security response for a component that, if compromised, can drive users' remote-enabled tools;
- abuse reports;
- billing and support.

M9's 8–12 agent-day estimate covers the build, not running it.

## Recommendation

1. **M3:** local only. Nothing in this doc is needed for the MVP.
2. **After M3, when Nick wants his phone:** build app-side remote mode (authorisation server,
   consent on the Mac, remote policy, audit marking, kill switch) with a test suite that attacks
   each guard. Then:
   - document Tailscale Funnel as the recommended transport and cloudflared as the alternative;
   - Nick uses claude.ai on his phone through Funnel.

   About 4–6 agent-days: most of M9's work, without the service.
3. **Watch Anthropic's MCP tunnels.** If they reach claude.ai connectors, add them as a transport
   behind the same remote mode and don't build the relay.
4. **Build the hosted relay (D1) only when all of these hold:**
   - M7 (sandbox) and M8 (public release) are done, because a relay invites people who won't read
     the security model;
   - Nick has used Funnel-based remote access for at least a month and still wants it, so the
     feature is real;
   - a waitlist with a price on the page ([D16](plan.md#d16-pricing)) gets about 100 sign-ups, or
     20 people who pre-pay, from people who aren't technical enough to run Funnel;
   - Anthropic's tunnels still don't serve claude.ai connectors;
   - the D25 legal opinion covers the hosted component.
5. **D2 (passthrough)** is the upgrade if users with sensitive adapters (banks) ask for remote
   access. It's more infrastructure for a property most claude.ai users won't notice, since
   Anthropic sees the results either way. Don't start there.

What would change this:

- claude.ai accepting static bearer tokens or custom headers would make tunnels easier, but
  wouldn't change the recommendation: per-client OAuth with consent on the Mac is still better
  than one shared token.
- An MCP-level end-to-end encryption extension adopted by clients would make D1 private without
  D2's infrastructure.

## Core changes

Not needed until remote mode is built:

- `AuditEvent['tool-called']` gains `transport: 'local' | 'remote'` and a `clientRegistration`
  id, instead of encoding both in the `client` string.
- New audit events: `remote-consent` (client host, source address, time, tool set, and approved,
  declined, expired or cancelled by wrong codes), `remote-revoked`, `remote-token-reuse`. Built in
  the second slice; `remote-state` (on or paused) and `remote-tool` exist since the first.
- An error class for "not available remotely", or a documented decision to reuse `not-granted`.

## Open questions

- **Answered by Nick (2026-11-10, [D14](plan.md#d14-relay)):** the tunnel is Cloudflare Tunnel on
  his own domain, not Tailscale Funnel. Where this document recommends Funnel, read `cloudflared`
  for Nick's setup; TLS then ends at Cloudflare, which he accepted. The Funnel questions below no
  longer block anything.
- Which client registration method claude.ai uses today (DCR or Client ID Metadata Documents),
  its redirect URIs, and its request timeout for tool calls.
- Whether Funnel still terminates TLS on the node, and its current limits.
- Whether Anthropic publishes egress IP ranges for connector traffic (useful as a WAF rule for
  B2 and D, never as the only control).
- **For Nick: the authorisation server in the app, not the Worker** (departs from WS10 and M9),
  and **the tunnel docs after remote mode, not at M3** (departs from D14). See
  [Summary](#summary).
- What source address tailscaled passes to the remote listener for Funnel traffic, and whether
  claude.ai's connector flow works with a code typed on the Mac (it should: the browser simply
  waits on the `/authorize` page until the Mac answers).
- Phone confirmation of `irreversible` calls (D19). It must not go through the relay unsigned,
  or the relay could approve on the person's behalf. It needs a device key pair between the
  person's phone and their Mac, which is a separate, later piece of work.
