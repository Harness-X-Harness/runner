const SCOPE_DETAILS = Object.freeze({
  "environments:manage": Object.freeze({
    group: "Environment permissions",
    title: "Manage private development environments",
    description: "Open and close your temporary private development environment.",
  }),
  "sessions:manage": Object.freeze({
    group: "Session permissions",
    title: "Manage coding sessions",
    description: "Start and control your private Codex and Grok sessions.",
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
