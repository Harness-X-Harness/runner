# Keep provider records in KV and request state in Durable Objects

`@cloudflare/workers-oauth-provider` requires the `OAUTH_KV` binding for its
registered clients, grants, authorization codes, access tokens, refresh tokens,
expiration, and revocation. The control plane keeps that binding and does not
replace the provider's persistence implementation.

Application-owned authorization state has a different consistency requirement.
Consent POSTs, GitHub callbacks, and repository-installation continuations read
state immediately after another request creates it, and some records must be
consumed exactly once. These records use one `AuthorizationStateObject` Durable
Object per opaque state identifier. Its storage is strongly consistent; it
serializes consumption and deletes unconsumed records with an alarm.

Task prompts and lifecycle state continue to use one `TaskObject` Durable Object
per task so runner callbacks, cancellation, and result updates are serialized.
The authorization-state and task modules share the Durable Objects product but
have separate interfaces and namespaces.

## Considered options

- Keeping application state in Workers KV was rejected. KV is eventually
  consistent and does not guarantee read-after-write visibility, including for
  newly created keys. Retrying or delaying the callback would retain the race.
- Moving the complete OAuth provider to Durable Objects was rejected because the
  selected provider requires KV and does not expose a Durable Object adapter.
- D1 would add relational queries and SQL transactions, but these opaque,
  single-record state transitions do not need a relational schema or migrations.
- Self-contained signed state would remove storage, but it would add signing-key
  lifecycle, payload-size, and replay rules to three authorization paths.

## Consequences

The deployment retains `Workers KV Storage: Edit` because the OAuth provider
still requires KV. It also deploys the `AUTHORIZATION_STATES` SQLite-backed
Durable Object namespace. D1 permissions are not required. Application code
must not use `OAUTH_KV` for state that a later request needs to read immediately.
