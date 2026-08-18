const SCOPE_DETAILS = Object.freeze({
  "tasks:read": Object.freeze({
    group: "Task permissions",
    title: "Read task status and results",
    description: "View tasks that you submitted, including their status and final result.",
  }),
  "tasks:run": Object.freeze({
    group: "Task permissions",
    title: "Run code tasks",
    description: "Submit instructions to a selected coding executor.",
  }),
  "tasks:cancel": Object.freeze({
    group: "Task permissions",
    title: "Cancel tasks",
    description: "Stop tasks that you previously submitted.",
  }),
  "repos:read": Object.freeze({
    group: "Repository permissions",
    title: "Read repositories",
    description: "Read repository contents needed for an analysis or code task.",
  }),
  "repos:write": Object.freeze({
    group: "Repository permissions",
    title: "Change repositories",
    description: "Create task changes in repositories when edit or pull-request mode is selected.",
  }),
  "pull_requests:write": Object.freeze({
    group: "Repository permissions",
    title: "Create pull requests",
    description: "Create a pull request when pull-request mode is selected.",
  }),
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

export function requiredSubmitScopes(mode) {
  const required = ["tasks:run", "repos:read"];
  if (mode === "edit" || mode === "pull_request") required.push("repos:write");
  if (mode === "pull_request") required.push("pull_requests:write");
  return required;
}
