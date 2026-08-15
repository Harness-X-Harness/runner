# Keep OAuth state in KV and task state in Durable Objects

The control plane keeps OAuth clients, grants, token metadata, and short-lived
authorization state in Workers KV because `@cloudflare/workers-oauth-provider`
requires an `OAUTH_KV` binding and already implements hashed token storage,
encrypted grant properties, expiration, and revocation around that model.
Task prompts and lifecycle state remain in one Durable Object per task so that
runner callbacks, cancellation, and result updates are serialized. The two
stores have different consistency and access requirements; they are not unified
solely to reduce the number of Cloudflare products.

## Considered options

- D1 would support relational queries, audit reporting, and explicit SQL
  transactions, but adopting it for OAuth would require a custom persistence
  layer, schema migrations, expiration cleanup, and renewed security validation
  for authorization codes, token rotation, and revocation.
- Durable Objects could serialize OAuth updates as well as task updates, but the
  selected OAuth provider does not expose a Durable Object storage adapter.
  Using one would therefore also mean owning more of the OAuth implementation.

## Consequences

The deployment token needs `Workers KV Storage: Edit` in addition to
`Workers Scripts: Edit`; D1 permissions are not required. KV's eventual
consistency is accepted for the current provider-backed OAuth flow. Revisit the
decision if the product requires immediate global revocation, relational
authorization queries, comprehensive audit reporting, or a different OAuth
provider with a supported transactional storage adapter.
