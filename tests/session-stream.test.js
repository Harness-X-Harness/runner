import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionStreamCapability,
  sessionStreamFetch,
  verifySessionStreamCapability,
} from "../apps/chatgpt-app/src/session-stream.js";

test("Session stream capability is private, session-bound, tamper-evident, and short-lived", async () => {
  const issuedAt = new Date("2026-08-19T00:00:00.000Z");
  const secret = "test-environment-secret";
  const capability = await createSessionStreamCapability(
    "42",
    "session-a",
    "grant-a",
    secret,
    () => issuedAt,
  );

  assert.equal(capability.token.includes("42"), false);
  assert.equal(capability.token.includes("session-a"), false);
  assert.deepEqual(await verifySessionStreamCapability(
    capability.token,
    "session-a",
    secret,
    () => new Date(issuedAt.getTime() + 9 * 60 * 1_000),
  ), {
    ownerId: "42",
    sessionId: "session-a",
    grantId: "grant-a",
    expiresAt: Math.floor(issuedAt.getTime() / 1_000) + 10 * 60,
  });
  assert.equal(await verifySessionStreamCapability(
    capability.token,
    "session-b",
    secret,
    () => issuedAt,
  ), undefined);
  assert.equal(await verifySessionStreamCapability(
    capability.token.slice(0, -1) + (capability.token.endsWith("A") ? "B" : "A"),
    "session-a",
    secret,
    () => issuedAt,
  ), undefined);
  assert.equal(await verifySessionStreamCapability(
    capability.token,
    "session-a",
    secret,
    () => new Date(issuedAt.getTime() + 10 * 60 * 1_000),
  ), undefined);
});

test("Session stream edge routes only a valid capability to its owner Durable Object", async () => {
  const secret = "test-environment-secret";
  const capability = await createSessionStreamCapability(
    "42",
    "session-a",
    "grant-a",
    secret,
  );
  const forwarded = [];
  const env = {
    ENVIRONMENT_SESSION_SECRET: secret,
    ENVIRONMENTS: {
      idFromName: (name) => name,
      get: (owner) => ({
        fetch: async (url, init) => {
          forwarded.push({ owner, url: String(url), init });
          return new Response('{"type":"snapshot"}\n', {
            headers: { "content-type": "application/x-ndjson" },
          });
        },
      }),
    },
  };
  const request = new Request("https://runner.example/session-stream/session-a?after=7", {
    headers: { authorization: `Bearer ${capability.token}` },
  });
  const response = await sessionStreamFetch(request, env, new URL(request.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), '{"type":"snapshot"}\n');
  assert.equal(forwarded[0].owner, "github-42");
  assert.equal(forwarded[0].url, "https://environment/sessions/session-a/stream?after=7");
  assert.equal(forwarded[0].init.headers["x-session-grant-id"], "grant-a");

  const deniedRequest = new Request("https://runner.example/session-stream/session-b", {
    headers: { authorization: `Bearer ${capability.token}` },
  });
  const denied = await sessionStreamFetch(deniedRequest, env, new URL(deniedRequest.url));
  assert.equal(denied.status, 401);
  assert.equal(forwarded.length, 1);
});
