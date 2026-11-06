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
  Relative candidates and relative PATH entries (including empty ones) are never used, so a
  binary planted in the working directory can't be run. An app started from Finder has a minimal `PATH`, which is why the Homebrew
  locations come first. The path found is kept until a run reports it gone. Tests inject
  `isExecutable`, so none looks at the disk.
- **`FakeCredentialProvider`** for tests and demo mode.

### Listing a vault

Both 1Password providers implement `VaultItemLister`:
`listItems(vault: string): Promise<readonly VaultItemSummary[]>`, where a summary is
`{ id, title }`. The grant picker calls the same method whichever provider the person uses.

- The CLI runs `op item list --vault <vault> --format json` with the same `op` it resolves with.
- The service account asks the SDK for the vaults it can see, picks the one whose id or title is
  exactly `vault`, and lists that vault's active items. It uses the same cached client as
  `resolve`, so the token still goes only to `sdkClientFactory`.
- Only `id` and `title` come back. An id must be 1 to 64 letters and digits, so it can't add a
  segment or a query to `op://<vault>/<id>`. Titles lose control and bidi characters and are cut
  at 200 code points. Websites, tags and anything else op or the SDK print are dropped. Listing
  never resolves a field.
- Failures are `CredentialError`: `not-found` for a vault name that isn't a valid name, or that
  matches no vault or more than one; `locked` when 1Password waits for the person (for the CLI, a
  run that times out); `unavailable` for anything else.

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
- **One messages grant per sender.** A grant's slot is (adapter, hash, secret), and `put` replaces
  the grant in its slot. For messages grants the slot also includes the sender (compared with
  `sameOtpSender`), so a flow with two Messages OTP sources keeps a grant for each: granting the
  second sender never drops the first. `findMessages(adapterId, hash, sender)` returns the grant
  for one sender; core's `find(adapterId, hash, 'messages')` has no sender to ask with and returns
  one of them, so a runtime with more than one source must use `findMessages`.
  `revokeMessages(adapterId, sender)` revokes one sender; `revoke(adapterId, 'messages')` all.
- **What the store does not check.** It never sees a manifest. When the runtime uses a grant, it
  must check that `grant.origins` is a subset of the origins the manifest requests for that secret
  (for a messages grant, of the origins its OTP step may type into). The sender check has help
  from the reader; see below.

Errors: a malformed grant passed to `put` is `grant: invalid`. Problems with the file itself use
stage `config`: `insecure-file` when it or its directory has loose permissions, another owner, or
is a symlink, FIFO or other non-regular file; `invalid` when its contents don't parse or validate
(one bad grant and none are used); `unavailable` when it can't be read or written.

## Messages OTP

`MessagesOtpReader` opens `chat.db` read-only per lookup and returns only a code-shaped capture
from exactly the named sender. The query's `sender` is required by type; the reader still refuses
a query without a usable sender, for queries built from untyped data. Patterns are screened
(`isScreenedPattern`) and run in a worker under a deadline.

The sender the person approved is the messages grant's `itemRef`; a query's sender comes from the
manifest. Pass the grant as `latest(query, notBefore, grant)` and the reader refuses, with
`otp: not-granted` and before opening the database, any query whose sender is not that grant's
(or a grant that is not a messages grant). `messagesQueryFor(grant, source)` makes the same check
and builds the query with the granted sender. Construct the reader with `requireGrant: true` to
refuse every lookup that comes without a grant. Core's `OtpReader.latest` takes no grant yet, so a
caller through that interface can't pass one, and `requireGrant` defaults to false until it can.
