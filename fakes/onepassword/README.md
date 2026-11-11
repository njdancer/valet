# Fake 1Password

A stand-in for 1Password, for demos and tests. It covers every call Valet makes, and the windows a
person sees while Valet talks to their 1Password. It never contacts 1Password. Its look and name
are its own, **Keyhold**, not 1Password's.

One `FakeOnePassword` holds an account, vaults, items (username, password, an optional TOTP secret,
websites, archived or not, `updatedAt`) and service accounts. Three faces work on it:

- **The SDK** (`fakeSdk(fake)`): `createClient` with a service-account token or a `DesktopAuth`,
  then `secrets.resolve`, `vaults.list` and `items.list` (with the `ByState` filter), and the SDK's
  typed errors (`DesktopSessionExpiredError`, `AuthExpiredError`, `RateLimitExceededError`) with its
  own messages. A service account sees only its vaults and is held to a daily request limit.
- **The CLI** (`runOp`, `fakeOpSpawner`): `op read [--no-newline] <reference>`,
  `op item list --vault <v> --format json` and `op --version`, with op's exit codes and error
  wording. The spawner also answers the `codesign --verify` Valet runs before it trusts an op
  binary, for the fake's path only.
- **The app's windows** (`startKeyholdApp`): loopback pages for a prompt (unlock if locked, then
  allow or deny the integration), the main window (vaults and items, never a value) and Settings >
  Developer with the “Integrate with other apps” switch.

The desktop app's rules are the real ones as far as Valet depends on them: the integration must be
on, the account named by its name or UUID, and the person must allow it; an approval is reused while
it is up and lapses after ten idle minutes or a lock. `autoApprove` answers every prompt at once for
tests that don't drive the window. Every call is in `fake.calls`, without values.

## Use

```ts
import { demoOnePassword, FakeOnePassword, fakeSdk, startKeyholdApp } from '@valet/fake-onepassword'
import { desktopAuthClientFactory, OnePasswordDesktopProvider } from '@valet/credentials'

const fake = new FakeOnePassword(demoOnePassword({ username: 'shopper@example.test', password: 'pw' }))
const desktop = new OnePasswordDesktopProvider({
  account: 'Tess Tester',
  clientFactory: desktopAuthClientFactory(async () => fakeSdk(fake)),
})
const app = await startKeyholdApp(fake)
fake.on('prompt', (prompt) => console.log(app.promptUrl(prompt.id))) // show it to the person
```

Demo mode wires it in `apps/desktop/src/main/core/demo.ts` (credentials) and
`src/main/electron/demo.ts` (the prompt windows); the e2e suite drives those windows
(`e2e/onepassword.spec.ts`, `setup.spec.ts`, `journey.spec.ts`), and `packages/credentials` runs its
real providers against the fake (`test/fake-onepassword.test.ts`).

The demo data (`demo-data.ts`) is Tess Tester's account (unlock password `keyhold-demo-unlock`), a
Personal vault with the fake shop's login and two other items, a Shared vault, and a Valet vault
that a service account can read. All of it is test values.
