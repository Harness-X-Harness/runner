import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { GrantIdentity } from "./mcp-events.ts";

/** Provider-owned records only. KV visibility is eventual, not instant revocation. */
export async function eventGrantAllowed(api: Pick<OAuthHelpers, "listUserGrants">, grant: GrantIdentity): Promise<boolean> {
  let cursor: string | undefined;
  for (let page = 0; page < 16; page++) {
    const result = await api.listUserGrants(grant.userId, { cursor, limit: 100 });
    const current = result.items.find(value => value.id === grant.grantId);
    if (current) return current.userId === grant.userId && current.clientId === grant.clientId &&
      current.scope.includes("environments:use") && (current.expiresAt === undefined || current.expiresAt > Date.now() / 1000);
    cursor = result.cursor;
    if (!cursor) return false;
  }
  throw new Error("GRANT_LOOKUP_LIMIT");
}
