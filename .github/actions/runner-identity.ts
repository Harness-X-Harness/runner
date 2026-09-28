/** Fresh GitHub Actions assertion for one control-plane request. Never cache it. */
export async function runnerIdentity(origin: string, env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  try {
    const audience = new URL(origin);
    const endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "");
    if (audience.protocol !== "https:" || audience.origin !== origin ||
        endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
        !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error();
    endpoint.searchParams.set("audience", origin);
    const response = await fetchImpl(endpoint, { redirect: "error", signal,
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    if (!response.ok) throw new Error();
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("value" in body) ||
        typeof body.value !== "string" || !body.value) throw new Error();
    return body.value;
  } catch {
    throw new Error("RUNNER_IDENTITY_UNAVAILABLE");
  }
}
