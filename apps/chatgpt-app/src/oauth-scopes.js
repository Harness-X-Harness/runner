const SCOPE_DETAILS = Object.freeze({
  "tasks:read": Object.freeze({
    title: "Read task status and results",
    description: "View tasks that you submitted, including their status and final result.",
  }),
  "tasks:run": Object.freeze({
    title: "Run code tasks",
    description: "Submit instructions to a selected coding executor.",
  }),
  "tasks:cancel": Object.freeze({
    title: "Cancel tasks",
    description: "Stop tasks that you previously submitted.",
  }),
  "repos:read": Object.freeze({
    title: "Read repositories",
    description: "Read repository contents needed for an analysis or code task.",
  }),
  "repos:write": Object.freeze({
    title: "Change repositories",
    description: "Create task changes in repositories when edit or pull-request mode is selected.",
  }),
  "pull_requests:write": Object.freeze({
    title: "Create pull requests",
    description: "Create a pull request when pull-request mode is selected.",
  }),
});

export const OAUTH_SCOPES = Object.freeze(Object.keys(SCOPE_DETAILS));
export const BASELINE_OAUTH_SCOPES = Object.freeze(["tasks:read"]);

export function consentScopes(requestedScopes) {
  describeScopes(requestedScopes);
  const requested = new Set(requestedScopes);
  if (
    requested.size === OAUTH_SCOPES.length &&
    OAUTH_SCOPES.every((scope) => requested.has(scope))
  ) {
    return [...BASELINE_OAUTH_SCOPES];
  }
  return OAUTH_SCOPES.filter((scope) => requested.has(scope));
}

export function describeScopes(scopes) {
  return scopes.map((scope) => {
    const detail = SCOPE_DETAILS[scope];
    if (!detail) throw new TypeError(`Unknown OAuth scope: ${scope}`);
    return { scope, ...detail };
  });
}

export function requiredSubmitScopes(mode) {
  const required = ["tasks:run", "repos:read"];
  if (mode === "edit" || mode === "pull_request") required.push("repos:write");
  if (mode === "pull_request") required.push("pull_requests:write");
  return required;
}
