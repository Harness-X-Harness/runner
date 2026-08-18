# Keep provider records in KV and application state in Durable Objects

`@cloudflare/workers-oauth-provider` requires `OAUTH_KV` for registered
clients, grants, authorization codes, access tokens, refresh tokens,
expiration, and revocation. Harness keeps that binding and does not replace the
provider persistence implementation.

Application-owned state needs immediate consistency. Consent POSTs and GitHub
callbacks consume one-time state from `AuthorizationStateObject`. Environment
lifecycle, Agent Sessions, controllers, commands, and event cursors use one
owner-scoped `EnvironmentObject`. Each object serializes its own transitions
with strongly consistent storage.

## Considered options

- Workers KV was rejected for application state because it does not guarantee
  immediate read-after-write visibility.
- Moving the OAuth provider to Durable Objects was rejected because the chosen
  provider requires KV and exposes no Durable Object adapter.
- D1 was rejected because these owner- or opaque-ID-scoped transitions do not
  require relational queries.
- Self-contained signed state was rejected because it adds signing-key,
  payload-size, and replay rules to one-time browser flows.
- One Durable Object per Agent Session was rejected because one owner object
  already serializes Environment generation, Session controller, queue, and
  channel state.

## Consequences

Deployment needs Workers KV and two SQLite-backed Durable Object classes:
`AuthorizationStateObject` and `EnvironmentObject`. D1 is not used.
Application code must not use `OAUTH_KV` for state that another request must
read immediately.
