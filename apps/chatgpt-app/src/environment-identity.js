export async function issueEnvironmentIdentity(ownerId, secret) {
  if (!secret) throw new Error("Environment session secret is not configured");
  const payload = base64Url(
    new TextEncoder().encode(JSON.stringify({ ownerId: String(ownerId), nonce: crypto.randomUUID() })),
  );
  return `${payload}.${await signature(payload, secret)}`;
}

export async function verifyEnvironmentIdentity(value, secret) {
  if (!value || !secret) return undefined;
  const [payload, supplied, extra] = String(value).split(".");
  if (!payload || !supplied || extra !== undefined) return undefined;
  const key = await importKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    decode(supplied),
    new TextEncoder().encode(`environment:${payload}`),
  ).catch(() => false);
  if (!valid) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decode(payload)));
    return typeof parsed.ownerId === "string" && typeof parsed.nonce === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function signature(payload, secret) {
  const key = await importKey(secret, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`environment:${payload}`),
  )));
}

function importKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
