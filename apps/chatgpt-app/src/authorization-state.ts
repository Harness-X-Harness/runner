import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export type AuthorizationStateEnv = { AUTHORIZATION_STATES: DurableObjectNamespace };
export type ConsentState = { authRequest: AuthRequest; browserBindingHash: string };
export type GitHubState = {
  payload: { kind: "mcp"; authRequest: AuthRequest };
  codeVerifier: string;
  browserBindingHash: string;
};
type ConsumeResult<T> =
  | { kind: "missing" }
  | { kind: "browser_mismatch" }
  | { kind: "consumed"; value: T };

const STATE_URL = "https://authorization-state/state";

export async function putAuthorizationState(
  env: AuthorizationStateEnv, id: string, value: ConsentState | GitHubState, ttlSeconds: number,
) {
  const response = await stateStub(env, id).fetch(STATE_URL, {
    method: "PUT",
    body: JSON.stringify({ value, ttlSeconds }),
  });
  if (!response.ok) throw new Error("Authorization state write failed");
}

export async function consumeAuthorizationState<T extends ConsentState | GitHubState = ConsentState>(
  env: AuthorizationStateEnv, id: string, browserBindingHash: string,
): Promise<ConsumeResult<T>> {
  const response = await stateStub(env, id).fetch(`${STATE_URL}/consume`, {
    method: "POST",
    body: JSON.stringify({ browserBindingHash }),
  });
  if (response.status === 404) return { kind: "missing" };
  if (response.status === 403) return { kind: "browser_mismatch" };
  if (!response.ok) throw new Error("Authorization state consume failed");
  return { kind: "consumed", value: await response.json<T>() };
}

function stateStub(env: AuthorizationStateEnv, id: string) {
  return env.AUTHORIZATION_STATES.get(
    env.AUTHORIZATION_STATES.idFromName(id),
  );
}
