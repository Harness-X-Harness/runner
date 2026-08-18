const VERSION = "v1";
const TTL_SECONDS = 10 * 60;
const CONTEXT = new TextEncoder().encode("harness-session-stream-v1");

export async function createSessionStreamCapability(
  ownerId,
  sessionId,
  grantId,
  secret,
  now = () => new Date(),
) {
  requireSecret(secret);
  const expiresAt = new Date(now().getTime() + TTL_SECONDS * 1_000);
  const payload = {
    ownerId: String(ownerId),
    sessionId: String(sessionId),
    grantId: String(grantId),
    expiresAt: Math.floor(expiresAt.getTime() / 1_000),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: CONTEXT },
    await capabilityKey(secret, ["encrypt"]),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    token: `${VERSION}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifySessionStreamCapability(
  token,
  expectedSessionId,
  secret,
  now = () => new Date(),
) {
  if (typeof token !== "string" || !secret) return undefined;
  const [version, encodedIv, encodedCiphertext, extra] = token.split(".");
  if (version !== VERSION || !encodedIv || !encodedCiphertext || extra !== undefined) {
    return undefined;
  }
  let payload;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(encodedIv), additionalData: CONTEXT },
      await capabilityKey(secret, ["decrypt"]),
      fromBase64Url(encodedCiphertext),
    );
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
  if (
    !validId(payload?.ownerId) ||
    !validId(payload?.sessionId) ||
    !validId(payload?.grantId) ||
    payload.sessionId !== expectedSessionId ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt <= Math.floor(now().getTime() / 1_000)
  ) return undefined;
  return payload;
}

export async function sessionStreamFetch(request, env, url) {
  const sessionId = decodeURIComponent(url.pathname.slice("/session-stream/".length));
  if (!sessionId || sessionId.includes("/")) return json({ error: "not found" }, 404);
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const capability = await verifySessionStreamCapability(
    token,
    sessionId,
    env.ENVIRONMENT_SESSION_SECRET,
  );
  if (!capability) return withCors(json({ error: "Session stream authorization required" }, 401));
  const target = new URL(
    `https://environment/sessions/${encodeURIComponent(sessionId)}/stream`,
  );
  const after = url.searchParams.get("after");
  if (after !== null) target.searchParams.set("after", after);
  const stub = env.ENVIRONMENTS.get(
    env.ENVIRONMENTS.idFromName(`github-${capability.ownerId}`),
  );
  const response = await stub.fetch(target, {
    headers: { "x-session-grant-id": capability.grantId },
  });
  return withCors(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
}

function withCors(response) {
  response.headers.set("access-control-allow-headers", "authorization");
  response.headers.set("access-control-allow-methods", "GET, OPTIONS");
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("cache-control", "no-store");
  return response;
}

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireSecret(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Environment session secret is not configured");
  }
}

async function capabilityKey(secret, usages) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, usages);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
