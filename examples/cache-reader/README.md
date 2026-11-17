# Cache reader (example)

An example of a `raw` adapter: Node code that opens its own TLS connection to one exact endpoint,
`cache.example.com:6380`, and speaks a Redis-compatible cache's own protocol (RESP), which Valet
can't see inside. It reads with the [redis-parser](https://www.npmjs.com/package/redis-parser) npm
package and signs in with an **entrusted** password: `ctx.secrets.get('cache')` hands the code the
value, audited, and from then on the call can reach only the credential's endpoints.

- `get_key` reads one key's value as text.
- `scan_keys` lists the keys that match a pattern.

It ships without its dependency, as a draft would start: add it first with
`valet_add_dependency` (`name: "redis-parser"`, `range: "3.0.0"`), which fetches it and its own
dependency (redis-errors) and writes `valet-lock.json`, whose hashes the adapter's hash covers.

A raw adapter's cases have no network, so each tool takes an optional `caseReply`: the cache's answer,
decoded as if it had come back. A real call leaves it out. Live trials get no credential, so a
trial of this example fails as `not-granted`: it works once the person approves it and grants the
credential, ideally for an account that can only read.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "cache-reader"`).
