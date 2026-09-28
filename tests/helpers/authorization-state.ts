import type { AuthorizationStateEnv, ConsentState, GitHubState } from "../../apps/chatgpt-app/src/authorization-state.ts";

type StoredState = ConsentState | GitHubState;

export function fakeAuthorizationStates(initial: [string, StoredState][] = []) {
  const values = new Map(initial);
  return {
    binding: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (request.method === "PUT" && path === "/state") {
            const body: { value: StoredState } = await request.json();
            values.set(id, body.value);
            return new Response(null, { status: 204 });
          }
          if (request.method === "GET" && path === "/state") {
            return values.has(id)
              ? Response.json(values.get(id))
              : new Response(null, { status: 404 });
          }
          if (request.method === "POST" && path === "/state/consume") {
            const record = values.get(id);
            if (!record) return new Response(null, { status: 404 });
            const body: { browserBindingHash: string } = await request.json();
            const expected = body.browserBindingHash;
            if (record.browserBindingHash !== expected) {
              return new Response(null, { status: 403 });
            }
            values.delete(id);
            return Response.json(record);
          }
          if (request.method === "DELETE" && path === "/state") {
            values.delete(id);
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 405 });
        },
      }),
    // This in-memory HTTP double implements only idFromName/get/fetch, not
    // Cloudflare's branded RPC namespace. Real binding behavior is tested in workerd.
    } as unknown as AuthorizationStateEnv["AUTHORIZATION_STATES"],
    get: (id: string) => values.get(id),
    has: (id: string) => values.has(id),
    size: () => values.size,
    values: () => [...values.values()],
  };
}
