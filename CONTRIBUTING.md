# Contributing

## Tooling

- **mise** pins Node and pnpm (`mise.toml`). Run commands through it: `mise exec -- pnpm …`, or
  activate mise in your shell.
- **pnpm** workspaces: `packages/*`, `adapters/*`, `fakes/*`, `apps/*`, `spikes/*`.
- **TypeScript** is strict, with `noUncheckedIndexedAccess`. Packages export their TypeScript
  source directly (`"exports": { ".": "./src/index.ts" }`). Only the desktop app is bundled.
- **Biome** lints and formats. **Vitest** tests, with v8 coverage.

## Before every commit

```bash
mise exec -- pnpm check
```

`check` runs lint, typecheck, and the tests with coverage thresholds: 90% lines, functions and
statements, and 85% branches. Commit at each green checkpoint, in small commits with
conventional-style subjects (`feat(runtime): …`, `test(core): …`, `docs: …`).

## Code

- **Electron.** No module outside `packages/browser-electron` and `apps/desktop` imports
  `electron`. Everything else must run and be tested in plain Node.
- **Secrets.** Pass them as `SecretValue`, never as `string`. Only the privileged filler in
  `packages/auth-flow` calls `reveal()`, with one exception: `sdkClientFactory` in
  `packages/credentials` reveals the 1Password service-account token once, straight into the SDK's
  `createClient`, which only accepts a string. A test in `packages/credentials` fails if any other
  module there calls `reveal()`.
- **Errors.** Errors that cross a package boundary are `ValetError(stage, errorClass)` from
  `@valet/core`. Never put page text, URLs with query strings, or exception messages into
  anything that leaves the runtime.
- **Injected effects.** Inject clocks, sleeps, process spawners and network access, so that tests
  are deterministic and never touch the real world.
- **Comments** say why, not what.

## Tests

- Tests live in `<package>/test/*.test.ts` and are explicit: copy a fixture and change one
  thing, rather than building factories or DSLs.
- Test the security properties as behaviour, not just the happy paths. For each guard, write a
  test that tries to get past it.
- Fakes live next to the tests that use them, or in `fakes/*` when several packages share them.
  No test talks to a real site, 1Password, or the Messages database.
