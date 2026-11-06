# @siteadapter/credentials

Credential providers, the grant store and the Messages OTP reader. Every secret leaves this package
as a `SecretValue`, and every failure as `SiteAdapterError(stage, errorClass)` or
`CredentialError(failure)`: never with a value, an item name or a provider's message in it.

## Providers

- **`OnePasswordServiceAccountProvider`** resolves through `@1password/sdk`. Its token comes from a
  `TokenSource` (core's interface); `KeychainTokenSource` reads it with `/usr/bin/security`, with a
  bounded wait. See "The service-account token" in `docs/security-model.md` for the v0 gap.
- **`OnePasswordCliProvider`** runs `op read`. `op` is always run by absolute path: the first
  executable of `opPaths` (default `/opt/homebrew/bin/op`, then `/usr/local/bin/op`), then `op` in
  each absolute directory on `searchPath` (default this process's `PATH`; `null` skips it).
  Relative paths and PATH entries are never used, so a binary planted in the working directory
  can't be run. An app started from Finder has a minimal `PATH`, which is why the Homebrew
  locations come first. The path found is kept until a run reports it gone. Tests inject
  `isExecutable`, so none looks at the disk.
- **`FakeCredentialProvider`** for tests and demo mode.

`CredentialResolver` resolves a grant through the provider its `provider` names, and refuses to
take a provider of kind `messages`: Messages codes only go through the `OtpReader`.

## Grants

`FileGrantStore` keeps grants in one JSON file, validated on every read and replaced atomically,
mode `0600`, in a directory only the person can write.

- A grant's origins must each be a bare https origin on a DNS name (core's `isBareOrigin`): no
  wildcards and no IP literals; a port is allowed.
- A 1Password grant's `itemRef` is exactly `op://<vault>/<item>`. No grant but a messages grant may
  use the reserved secret name `messages`.
- A **messages grant** is `{ provider: 'messages', secret: 'messages', itemRef: <sender> }`, where
  the sender is one `parseOtpSender` accepts (an E.164 number, short code, sender ID or email), and
  `origins` are where the code may be typed.
- **What the store does not check.** It never sees a manifest. When the runtime uses a grant, it
  must check that `grant.origins` is a subset of the origins the manifest requests for that secret,
  and for a messages grant that `sameOtpSender(grant.itemRef, source.sender)` holds for the OTP
  source it is about to read.

Errors: a malformed grant passed to `put` is `grant: invalid`. Problems with the file itself use
stage `config`: `insecure-file` when it or its directory has loose permissions, another owner, or
is a symlink, FIFO or other non-regular file; `invalid` when its contents don't parse or validate
(one bad grant and none are used); `unavailable` when it can't be read or written.

## Messages OTP

`MessagesOtpReader` opens `chat.db` read-only per lookup and returns only a code-shaped capture
from exactly the named sender. The query's `sender` is required by type; the reader still refuses
a query without a usable sender, for queries built from untyped data. Patterns are screened
(`isScreenedPattern`) and run in a worker under a deadline.
