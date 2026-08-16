export function canonicalMcpResource(controlPlaneUrl) {
  const resource = new URL(controlPlaneUrl);
  resource.pathname = "/mcp";
  resource.search = "";
  resource.hash = "";
  return resource.toString();
}

export function authorizationServerIssuer(controlPlaneUrl) {
  return new URL(controlPlaneUrl).origin;
}

export async function requireCanonicalResourceParameter(request) {
  const url = new URL(request.url);
  let values;

  if (url.pathname === "/authorize" && request.method === "GET") {
    values = url.searchParams.getAll("resource");
  } else if (url.pathname === "/oauth/token" && request.method === "POST") {
    const body = await request.clone().formData().catch(() => undefined);
    if (!body) return undefined;
    if (!body.has("grant_type") && body.has("token")) return undefined;
    values = body.getAll("resource").map(String);
  } else {
    return undefined;
  }

  // The provider preserves redirect-aware errors for explicit wrong or repeated
  // resource values. This boundary only closes its compatibility omission path.
  if (values.length > 0) return undefined;
  return new Response(
    JSON.stringify({
      error: "invalid_target",
      error_description: "resource must be provided for the canonical MCP resource",
    }),
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    },
  );
}
