export const ENVIRONMENT_SCOPE = "environments:use";

const SCOPE_DETAILS = Object.freeze({
  [ENVIRONMENT_SCOPE]: Object.freeze({
    group: "工作区权限",
    title: "使用私人开发工作区",
    description: "打开和关闭临时工作区，运行命令和编程助手，并读取它们的任务和输出。助手使用平台配置的 GitHub 凭据。",
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
