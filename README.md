# siteadapter

A macOS menu-bar app that turns per-site browser automation "adapters" into MCP tools, so agents
can use websites that have no API, as you, without ever seeing your passwords. "siteadapter" is a
working name.

**Status: pre-alpha.** Everything runs end to end against a local fake of the first site
(Woolworths, an Australian supermarket): log in, search, read and change the cart. It has not
been used against the real site while logged in, and nothing is signed or released.

Not affiliated with or endorsed by Woolworths Group or any site an adapter targets. An adapter
acts as the person who installed it, in their own account, at a human pace; it is not a scraper.

## How it works

- **Adapters** declare a site's origins, its login flow and its tools. Tool code runs against a
  guarded page; it never sees a secret.
- **Login** is a fully declarative flow run in its own browser partition. Secrets come from
  1Password, bound to the origins they may be typed into, and are typed as keystrokes. Two-factor
  codes come from 1Password (TOTP) or the Messages database. The signed-in session is handed one
  way to the tool's partition.
- **Every run** goes through approval, a per-site rate budget and circuit breaker, a run-scoped
  network policy, confirmation for irreversible actions, and a hash-chained audit log.
- **Agents** connect over MCP: Streamable HTTP on `127.0.0.1` with a bearer token, or a stdio
  bridge.

The design is in [docs/security-model.md](docs/security-model.md) and
[docs/architecture.md](docs/architecture.md); the plan, milestones and open decisions are in
[docs/plan.md](docs/plan.md).

## Try it

Needs macOS, [mise](https://mise.jdx.dev) and OpenSSL.

```bash
mise install && pnpm install
pnpm demo
```

`pnpm demo` launches the app against a local fake of the site, with a test account and a test
credential provider; no real account, 1Password, Keychain or Messages is touched. Approve the
adapter in the control panel, grant the demo login, then add the MCP client snippet from
Settings → Clients to your agent.

## Develop

```bash
pnpm check          # lint, typecheck, unit and integration tests with coverage
pnpm test:e2e       # the desktop app's Electron end-to-end suite
pnpm package:smoke  # an unsigned .app, checked and launched under a temporary HOME
```

| Path                        | What                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| `packages/core`             | Contracts: manifests, the auth flow, secrets, run policy, audit   |
| `packages/runtime`          | Runs tools: approval, locks, budget, breaker, redaction, audit    |
| `packages/auth-flow`        | The declarative login interpreter and the secret filler           |
| `packages/credentials`      | 1Password, Keychain and Messages providers                        |
| `packages/browser-electron` | The Electron driver: partitions, typing, request filter, hand-off |
| `packages/mcp-server`       | The MCP endpoint and stdio bridge                                 |
| `adapters/woolworths`       | The first adapter                                                 |
| `fakes/woolworths-site`     | A local fake of the site, with hostile variants for the tests     |
| `apps/desktop`              | The menu-bar app and control panel                                |
