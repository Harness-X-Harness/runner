import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizePage,
  completeAuthorizationCallback,
  submitAuthorizationDecision,
} from "../apps/chatgpt-app/src/authorization.js";
import {
  describeScopes,
  requiredSubmitScopes,
} from "../apps/chatgpt-app/src/oauth-scopes.js";

const authRequest = Object.freeze({
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: ["tasks:run", "repos:read"],
  state: "client-state",
  issuer: "https://runner.example.com",
  codeChallenge: "client-challenge",
  codeChallengeMethod: "S256",
});

test("consent page explains fixed scopes and sends hardened browser headers", async () => {
  const kv = new Map();
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      OAUTH_KV: mapKv(kv),
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => authRequest,
        lookupClient: async () => ({ clientName: "<script>ChatGPT</script>" }),
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(response.headers.get("content-security-policy"), /base-uri 'none'/);
  assert.doesNotMatch(response.headers.get("content-security-policy"), /https:\/\/github\.com/);
  assert.match(response.headers.get("set-cookie"), /__Host-RUNNER_CSRF=/);

  const body = await response.text();
  assert.match(body, /Run code tasks/);
  assert.match(body, /Read repositories/);
  assert.match(body, /tasks:run/);
  assert.match(body, /name="decision" value="allow"/);
  assert.match(body, /name="decision" value="deny"/);
  assert.match(body, /&lt;script&gt;ChatGPT&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>ChatGPT<\/script>/);
  assert.equal(kv.size, 1);
});

test("validated authorization errors return OAuth error state and issuer", async () => {
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw authorizationError("invalid_target", {
            description: "The resource is invalid",
            redirectUri: "https://client.example/callback",
            state: "client-state",
            issuer: "https://runner.example.com",
          });
        },
      },
    },
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://client.example");
  assert.equal(location.searchParams.get("error"), "invalid_target");
  assert.equal(location.searchParams.get("state"), "client-state");
  assert.equal(location.searchParams.get("iss"), "https://runner.example.com");
});

test("untrusted authorization redirects are rendered locally", async () => {
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => {
          throw authorizationError("invalid_request", {
            description: "The redirect was not trusted",
          });
        },
      },
    },
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.has("location"), false);
  assert.match(await response.text(), /redirect was not trusted/);
});

test("denying consent returns access_denied without contacting GitHub", async () => {
  const kv = new Map([["oauth:consent:csrf-123", JSON.stringify(authRequest)]]);
  const response = await submitAuthorizationDecision(
    consentRequest("deny"),
    { OAUTH_KV: mapKv(kv) },
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://client.example");
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "client-state");
  assert.equal(location.searchParams.get("iss"), "https://runner.example.com");
  assert.equal(kv.size, 0);
  assert.match(response.headers.get("set-cookie"), /__Host-RUNNER_CSRF=;/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("GitHub callback requires the initiating browser and exchanges PKCE once", async () => {
  const kv = new Map([["oauth:consent:csrf-123", JSON.stringify(authRequest)]]);
  const env = {
    GITHUB_APP_CLIENT_ID: "Iv1.example",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    OAUTH_KV: mapKv(kv),
    OAUTH_PROVIDER: {
      completeAuthorization: async () => ({
        redirectTo: "https://client.example/callback?code=mcp-code",
      }),
    },
  };
  const start = await submitAuthorizationDecision(consentRequest("allow"), env);
  const github = new URL(start.headers.get("location"));
  const state = github.searchParams.get("state");
  assert.equal(github.origin, "https://github.com");
  assert.equal(github.searchParams.get("code_challenge_method"), "S256");
  assert.match(github.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.headers.get("set-cookie"), /__Host-RUNNER_GITHUB_STATE=/);
  assert.match(start.headers.get("set-cookie"), /__Host-RUNNER_CSRF=;/);

  const record = JSON.parse(kv.get(`github:oauth:${state}`));
  assert.equal(record.payload.kind, "mcp");
  assert.deepEqual(record.payload.authRequest, authRequest);
  assert.match(record.codeVerifier, /^[A-Za-z0-9_-]{43}$/);

  const wrongBrowser = await completeAuthorizationCallback(
    new Request(
      `https://runner.example.com/github/callback?state=${state}&code=github-code`,
      { headers: { cookie: "__Host-RUNNER_GITHUB_STATE=wrong" } },
    ),
    env,
  );
  assert.equal(wrongBrowser.status, 400);
  assert.equal(kv.has(`github:oauth:${state}`), true);

  const stateCookie = cookieFromResponse(start, "__Host-RUNNER_GITHUB_STATE");
  let tokenParameters;
  const completed = await completeAuthorizationCallback(
    new Request(
      `https://runner.example.com/github/callback?state=${state}&code=github-code`,
      { headers: { cookie: `__Host-RUNNER_GITHUB_STATE=${stateCookie}` } },
    ),
    env,
    async (url, init) => {
      if (url === "https://github.com/login/oauth/access_token") {
        tokenParameters = Object.fromEntries(new URLSearchParams(init.body));
        return Response.json({ access_token: "ghu_access" });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 42, login: "owner" });
      }
      return new Response("unexpected request", { status: 500 });
    },
  );

  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get("location"), "https://client.example/callback?code=mcp-code");
  assert.equal(completed.headers.get("cache-control"), "no-store");
  assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
  assert.equal(completed.headers.get("x-frame-options"), "DENY");
  assert.equal(tokenParameters.code_verifier, record.codeVerifier);
  assert.equal(kv.has(`github:oauth:${state}`), false);
  assert.match(completed.headers.get("set-cookie"), /__Host-RUNNER_GITHUB_STATE=;/);
  assert.match(completed.headers.get("set-cookie"), /Max-Age=0/);
});

test("submit modes map to the minimum complete OAuth scope set", () => {
  assert.deepEqual(requiredSubmitScopes("analyze"), ["tasks:run", "repos:read"]);
  assert.deepEqual(requiredSubmitScopes("edit"), [
    "tasks:run",
    "repos:read",
    "repos:write",
  ]);
  assert.deepEqual(requiredSubmitScopes("pull_request"), [
    "tasks:run",
    "repos:read",
    "repos:write",
    "pull_requests:write",
  ]);
  assert.throws(() => describeScopes(["unknown:scope"]), /Unknown OAuth scope/);
});

function consentRequest(decision) {
  return new Request("https://runner.example.com/authorize/consent", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: "__Host-RUNNER_CSRF=csrf-123",
    },
    body: new URLSearchParams({ csrf: "csrf-123", decision }),
  });
}

function cookieFromResponse(response, name) {
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")];
  for (const cookie of cookies) {
    const match = cookie?.match(new RegExp(`${name}=([^;,]*)`));
    if (match) return match[1];
  }
  throw new Error(`Missing cookie: ${name}`);
}

function mapKv(values) {
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key),
  };
}

function authorizationError(code, options) {
  const error = new Error(options.description);
  error.name = "AuthorizationError";
  return Object.assign(error, { code, ...options });
}
