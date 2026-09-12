const SCOPE_DETAILS = Object.freeze({
  "tasks:manage": Object.freeze({
    group: "Task permissions",
    title: "Run and control code tasks",
    description: "Run autonomous Codex and Grok tasks, read their results and cancel them. Agents use the platform's configured GitHub credentials.",
  }),
});

export const OAUTH_SCOPES = Object.freeze(Object.keys(SCOPE_DETAILS));

export function consentScopes(requestedScopes) {
  describeScopes(requestedScopes);
  const requested = new Set(requestedScopes);
  return OAUTH_SCOPES.filter((scope) => requested.has(scope));
}

export function describeScopes(scopes) {
  return scopes.map((scope) => {
    const detail = SCOPE_DETAILS[scope];
    if (!detail) throw new TypeError(`Unknown OAuth scope: ${scope}`);
    return { scope, ...detail };
  });
}
