export const ENVIRONMENT_SCOPE = "environments:use";

const SCOPE_DETAILS = Object.freeze({
  [ENVIRONMENT_SCOPE]: Object.freeze({
    group: "Environment permissions",
    title: "Use private development environments",
    description: "Open and close temporary environments, run commands and coding agents, and read their tasks and output. Agents use the platform's configured GitHub credentials.",
  }),
  "tasks:manage": Object.freeze({
    group: "Task permissions",
    title: "Read and stop retained code tasks",
    description: "Read results and request cancellation of previously submitted tasks. This permission cannot start new work.",
  }),
});

export const OAUTH_SCOPES = Object.freeze(Object.keys(SCOPE_DETAILS));

export function consentScopes(requestedScopes: readonly string[]): string[] {
  describeScopes(requestedScopes);
  const requested = new Set(requestedScopes);
  return OAUTH_SCOPES.filter((scope) => requested.has(scope));
}

export function describeScopes(scopes: readonly string[]) {
  return scopes.map((scope) => {
    if (!Object.hasOwn(SCOPE_DETAILS, scope)) throw new TypeError(`Unknown OAuth scope: ${scope}`);
    const detail = SCOPE_DETAILS[scope as keyof typeof SCOPE_DETAILS];
    return { scope, ...detail };
  });
}
