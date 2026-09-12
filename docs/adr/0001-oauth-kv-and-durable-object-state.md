# Keep provider records in KV and application state in Durable Objects

Status: accepted for Task Runtime and OAuth.

The OAuth provider owns `OAUTH_KV` for its clients, grants, codes, tokens,
expiry and revocation. Application state instead needs immediate consistency:
one-time consent/callback state uses `AuthorizationStateObject`, and each
opaque Task ID uses one `TaskRuntimeObject`.

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
for Task identity, terminal state and one-time authorization decisions. D1 is
not used. Environment/Session state ownership is superseded by the accepted
[Task product](https://github.com/Harness-X-Harness/runner/issues/114).
