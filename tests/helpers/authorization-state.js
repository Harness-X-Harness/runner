export function fakeAuthorizationStates(initial = []) {
  const values = new Map(initial);
  return {
    binding: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (input, init = {}) => {
          const path = new URL(input).pathname;
          if (init.method === "PUT" && path === "/state") {
            values.set(id, JSON.parse(init.body).value);
            return new Response(null, { status: 204 });
          }
          if ((!init.method || init.method === "GET") && path === "/state") {
            return values.has(id)
              ? Response.json(values.get(id))
              : new Response(null, { status: 404 });
          }
          if (init.method === "POST" && path === "/state/consume") {
            const record = values.get(id);
            if (!record) return new Response(null, { status: 404 });
            const expected = JSON.parse(init.body).browserBindingHash;
            if (record.browserBindingHash !== expected) {
              return new Response(null, { status: 403 });
            }
            values.delete(id);
            return Response.json(record);
          }
          if (init.method === "DELETE" && path === "/state") {
            values.delete(id);
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 405 });
        },
      }),
    },
    get: (id) => values.get(id),
    has: (id) => values.has(id),
    size: () => values.size,
    values: () => [...values.values()],
  };
}
