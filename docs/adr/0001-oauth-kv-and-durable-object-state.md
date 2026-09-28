# Keep provider records in KV and application state in Durable Objects

Status: accepted for Environment and OAuth.

The OAuth provider owns `OAUTH_KV` for its clients, grants, codes, tokens,
expiry and revocation. Application state instead needs immediate consistency:
one-time consent/callback state uses `AuthorizationStateObject`, and each
Environment uses one `BoundedEnvironmentObject`. `EnvironmentAdmissionObject`
coordinates bounded live membership per Principal.

## Considered options

- KV does not provide immediate read-after-write visibility for application
  transitions.
- Replacing OAuth provider persistence would require an unsupported adapter.
- D1 adds no value to these opaque-ID-scoped transitions without relational
  queries.
- Self-contained signed browser state would add signing, payload and replay
  rules to the one-time authorization flow.

## Consequences

Preserve the OAuth KV binding. Use strongly consistent per-object transactions
for Environment identity, terminal operation state and one-time authorization
decisions. D1 is not used.
