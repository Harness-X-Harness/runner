const STATE_URL = "https://authorization-state/state";

export async function putAuthorizationState(env, id, value, ttlSeconds) {
  const response = await stateStub(env, id).fetch(STATE_URL, {
    method: "PUT",
    body: JSON.stringify({ value, ttlSeconds }),
  });
  if (!response.ok) throw new Error("Authorization state write failed");
}

export async function getAuthorizationState(env, id) {
  const response = await stateStub(env, id).fetch(STATE_URL);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error("Authorization state read failed");
  return response.json();
}

export async function consumeAuthorizationState(env, id, browserBindingHash) {
  const response = await stateStub(env, id).fetch(`${STATE_URL}/consume`, {
    method: "POST",
    body: JSON.stringify({ browserBindingHash }),
  });
  if (response.status === 404) return { kind: "missing" };
  if (response.status === 403) return { kind: "browser_mismatch" };
  if (!response.ok) throw new Error("Authorization state consume failed");
  return { kind: "consumed", value: await response.json() };
}

export async function deleteAuthorizationState(env, id) {
  const response = await stateStub(env, id).fetch(STATE_URL, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("Authorization state delete failed");
}

function stateStub(env, id) {
  return env.AUTHORIZATION_STATES.get(
    env.AUTHORIZATION_STATES.idFromName(id),
  );
}
