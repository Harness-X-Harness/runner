import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizePage,
  completeAuthorizationCallback,
  submitAuthorizationDecision,
} from "../apps/chatgpt-app/src/authorization.ts";
import {
  describeScopes,
} from "../apps/chatgpt-app/src/oauth-scopes.ts";
import { fakeAuthorizationStates } from "./helpers/authorization-state.ts";
import type { AuthorizationEnvironment } from "../apps/chatgpt-app/src/authorization.ts";
import type { ConsentState } from "../apps/chatgpt-app/src/authorization-state.ts";

const authRequest: ConsentState["authRequest"] = Object.freeze({
  responseType: "code",
  clientId: "client-123",
  redirectUri: "https://client.example/callback",
  scope: ["environments:use"],
  state: "client-state",
  issuer: "https://runner.example.com",
  codeChallenge: "client-challenge",
  codeChallengeMethod: "S256",
});

const client = { clientId: "client-123", redirectUris: [authRequest.redirectUri], tokenEndpointAuthMethod: "none" };
const baseEnv: AuthorizationEnvironment = {
  GITHUB_APP_CLIENT_ID: "Iv1.example", GITHUB_APP_CLIENT_SECRET: "client-secret",
  GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
  AUTHORIZATION_STATES: fakeAuthorizationStates().binding,
  OAUTH_PROVIDER: {
    parseAuthRequest: async () => authRequest,
    lookupClient: async () => ({ ...client, clientName: "ChatGPT" }),
    completeAuthorization: async () => assert.fail("unexpected grant completion"),
  },
};

test("consent page explains fixed scopes and sends hardened browser headers", async () => {
  const states = fakeAuthorizationStates();
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      ...baseEnv,
      AUTHORIZATION_STATES: states.binding,
      OAUTH_PROVIDER: {
        ...baseEnv.OAUTH_PROVIDER,
        parseAuthRequest: async () => authRequest,
        lookupClient: async () => ({ ...client, clientName: "<script>ChatGPT</script>" }),
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control") ?? "", "no-store");
  assert.equal(response.headers.get("referrer-policy") ?? "", "no-referrer");
  assert.equal(response.headers.get("x-frame-options") ?? "", "DENY");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /base-uri 'none'/);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /form-action 'self' https:\/\/client\.example https:\/\/github\.com/,
  );
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-RUNNER_CSRF=/);

  const body = await response.text();
  assert.match(body, /使用私人开发工作区/);
  assert.match(body, /GitHub 凭据/);
  assert.match(body, /environments:use/);
  assert.match(body, /<button\b(?=[^>]*\btype="submit")(?=[^>]*\bname="decision")(?=[^>]*\bvalue="allow")[^>]*>用 GitHub 继续<\/button>/);
  assert.match(body, /<button\b(?=[^>]*\btype="submit")(?=[^>]*\bname="decision")(?=[^>]*\bvalue="deny")[^>]*>取消<\/button>/);
  assert.doesNotMatch(body, /<script\b|<style\b/);
  assert.match(body, /<link rel="stylesheet" href="\/assets\/authorization.css"/);
  assert.match(body, /&lt;script&gt;ChatGPT&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>ChatGPT<\/script>/);
  assert.equal(states.size(), 1);
  const [stored] = states.values();
  assert.ok(stored && "authRequest" in stored);
  assert.deepEqual(stored.authRequest.scope, [
    "environments:use",
  ]);
});

test("initial consent displays and preserves every requested capability", async () => {
  const states = fakeAuthorizationStates();
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      ...baseEnv,
      AUTHORIZATION_STATES: states.binding,
      OAUTH_PROVIDER: {
        ...baseEnv.OAUTH_PROVIDER,
        parseAuthRequest: async () => ({
          ...authRequest,
          scope: ["environments:use"],
        }),
        lookupClient: async () => ({ ...client, clientName: "ChatGPT" }),
      },
    },
  );

  const body = await response.text();
  assert.match(body, /使用私人开发工作区/);
  assert.match(body, /GitHub 凭据/);
  assert.match(body, /工作区权限/);
  assert.match(
    body,
    /这些权限决定你的客户端能让 Harness 做什么/,
  );
  assert.match(body, /Harness 只会得到运行仓库和 Actions 工作流的控制凭据/);
  assert.equal(states.size(), 1);
  const [stored] = states.values();
  assert.ok(stored && "authRequest" in stored);
  assert.deepEqual(stored.authRequest.scope, [
    "environments:use",
  ]);
});

test("Environment consent grants only the fresh requested scope", async () => {
  const states = fakeAuthorizationStates();
  const response = await authorizePage(new Request("https://runner.example.com/authorize"), {
    ...baseEnv, AUTHORIZATION_STATES: states.binding,
    OAUTH_PROVIDER: { ...baseEnv.OAUTH_PROVIDER,
      parseAuthRequest: async () => ({ ...authRequest, scope: ["environments:use"] }),
    },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /使用私人开发工作区/);
  assert.match(body, /GitHub 凭据/);
  assert.doesNotMatch(body, /tasks:manage|environments:manage/);
  const [stored] = states.values();
  assert.ok(stored && "authRequest" in stored);
  assert.deepEqual(stored.authRequest.scope, ["environments:use"]);
  assert.throws(() => describeScopes(["environments:manage"]), /Unknown OAuth scope/);
});

test("validated authorization errors return OAuth error state and issuer", async () => {
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      ...baseEnv,
      OAUTH_PROVIDER: {
        ...baseEnv.OAUTH_PROVIDER,
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
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://client.example");
  assert.equal(location.searchParams.get("error"), "invalid_target");
  assert.equal(location.searchParams.get("state"), "client-state");
  assert.equal(location.searchParams.get("iss"), "https://runner.example.com");
});

test("untrusted authorization redirects are rendered locally", async () => {
  const response = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    {
      ...baseEnv,
      OAUTH_PROVIDER: {
        ...baseEnv.OAUTH_PROVIDER,
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

for (const failedMethod of ["parseAuthRequest", "lookupClient"]) {
  test(`CIMD failure in ${failedMethod} creates no consent state`, async () => {
    const states = fakeAuthorizationStates();
    const response = await authorizePage(new Request("https://runner.example.com/authorize"), {
      ...baseEnv,
      AUTHORIZATION_STATES: states.binding,
      OAUTH_PROVIDER: {
        ...baseEnv.OAUTH_PROVIDER,
        parseAuthRequest: async () => authRequest,
        lookupClient: async () => ({ ...client, clientName: "ChatGPT" }),
        [failedMethod]: async () => {
          throw Object.assign(new Error("private-upstream-detail"), {
            name: "CimdFetchError", reason: "metadata_resolution_failed",
          });
        },
      },
    });
    assert.equal(response.status, 503);
    assert.equal(states.size(), 0);
    assert.equal(response.headers.has("location"), false);
    assert.doesNotMatch(await response.text(), /private-upstream-detail/);
  });
}

test("unexpected authorization defects are not disguised as CIMD unavailability", async () => {
  const defect = new Error("unexpected defect");
  await assert.rejects(authorizePage(new Request("https://runner.example.com/authorize"), {
    ...baseEnv,
    OAUTH_PROVIDER: { ...baseEnv.OAUTH_PROVIDER, parseAuthRequest: async () => { throw defect; } },
  }), (error) => error === defect);
});

test("denying consent returns access_denied without contacting GitHub", async () => {
  const states = fakeAuthorizationStates([[
    "oauth:consent:csrf-123",
    await consentRecord(authRequest),
  ]]);
  const response = await submitAuthorizationDecision(
    consentRequest("deny"),
    { ...baseEnv, AUTHORIZATION_STATES: states.binding },
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  assert.equal(location.origin, "https://client.example");
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "client-state");
  assert.equal(location.searchParams.get("iss"), "https://runner.example.com");
  assert.equal(states.size(), 0);
  assert.equal(response.headers.has("set-cookie"), false);
});

test("parallel authorization pages keep one browser-bound consent session", async () => {
  const states = fakeAuthorizationStates();
  const env = {
    ...baseEnv,
    AUTHORIZATION_STATES: states.binding,
    OAUTH_PROVIDER: {
      ...baseEnv.OAUTH_PROVIDER,
      parseAuthRequest: async () => authRequest,
      lookupClient: async () => ({ ...client, clientName: "ChatGPT" }),
    },
  };

  const first = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    env,
  );
  const firstCsrf = await csrfFromResponse(first.clone());
  const firstCookie = cookieFromResponse(first, "__Host-RUNNER_CSRF");
  const second = await authorizePage(
    new Request("https://runner.example.com/authorize", {
      headers: { cookie: `__Host-RUNNER_CSRF=${firstCookie}` },
    }),
    env,
  );
  const secondCsrf = await csrfFromResponse(second.clone());
  const secondCookie = cookieFromResponse(second, "__Host-RUNNER_CSRF");

  const denied = await submitAuthorizationDecision(
    consentRequest("deny", firstCsrf, secondCookie),
    env,
  );

  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get("location") ?? "").searchParams.get("error"), "access_denied");

  const secondDenied = await submitAuthorizationDecision(
    consentRequest("deny", secondCsrf, secondCookie),
    env,
  );
  assert.equal(secondDenied.status, 302);
  assert.equal(
    new URL(secondDenied.headers.get("location") ?? "").searchParams.get("error"),
    "access_denied",
  );
});

test("consent does not depend on immediate Workers KV write visibility", async () => {
  const states = fakeAuthorizationStates();
  const env = {
    ...baseEnv,
    AUTHORIZATION_STATES: states.binding,
    OAUTH_KV: invisibleWritesKv(),
    OAUTH_PROVIDER: {
      ...baseEnv.OAUTH_PROVIDER,
      parseAuthRequest: async () => authRequest,
      lookupClient: async () => ({ ...client, clientName: "ChatGPT" }),
    },
  };
  const page = await authorizePage(
    new Request("https://runner.example.com/authorize"),
    env,
  );
  const csrf = await csrfFromResponse(page.clone());
  const browserSession = cookieFromResponse(page, "__Host-RUNNER_CSRF");

  const denied = await submitAuthorizationDecision(
    consentRequest("deny", csrf, browserSession),
    env,
  );

  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get("location") ?? "").searchParams.get("error"), "access_denied");
});

test("GitHub callback requires the initiating browser and exchanges PKCE once", async () => {
  const states = fakeAuthorizationStates([[
    "oauth:consent:csrf-123",
    await consentRecord(authRequest),
  ]]);
  const env = {
    ...baseEnv,
    GITHUB_APP_CLIENT_ID: "Iv1.example",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_RUNNER_REPOSITORY: "Harness-X-Harness/runner",
    AUTHORIZATION_STATES: states.binding,
    OAUTH_PROVIDER: {
      ...baseEnv.OAUTH_PROVIDER,
      completeAuthorization: async () => ({
        redirectTo: "https://client.example/callback?code=mcp-code",
      }),
    },
  };
  const start = await submitAuthorizationDecision(consentRequest("allow"), env);
  const github = new URL(start.headers.get("location") ?? "");
  const state = github.searchParams.get("state");
  assert.equal(github.origin, "https://github.com");
  assert.equal(github.searchParams.has("scope"), false);
  assert.equal(github.searchParams.get("code_challenge_method"), "S256");
  assert.match(github.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.headers.get("set-cookie") ?? "", /__Host-RUNNER_GITHUB_STATE=/);

  const record = states.get(`github:oauth:${state}`);
  assert.ok(record && "payload" in record);
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
  assert.equal(states.has(`github:oauth:${state}`), true);

  const stateCookie = cookieFromResponse(start, "__Host-RUNNER_GITHUB_STATE");
  let tokenParameters: Record<string, string> | undefined;
  const completed = await completeAuthorizationCallback(
    new Request(
      `https://runner.example.com/github/callback?state=${state}&code=github-code`,
      { headers: { cookie: `__Host-RUNNER_GITHUB_STATE=${stateCookie}` } },
    ),
    env,
    async (url, init) => {
      if (url === "https://github.com/login/oauth/access_token") {
        tokenParameters = Object.fromEntries(new URLSearchParams(await new Request(url, init).text()));
        return Response.json({ access_token: "ghu_access" });
      }
      if (String(url).endsWith("/token/scoped")) {
        return Response.json({
          token: "ghu_scoped",
          expires_at: "2030-01-01T00:00:00Z",
        });
      }
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 42, login: "owner" });
      }
      return new Response("unexpected request", { status: 500 });
    },
  );

  assert.equal(completed.status, 302);
  assert.equal(completed.headers.get("location") ?? "", "https://client.example/callback?code=mcp-code");
  assert.equal(completed.headers.get("cache-control") ?? "", "no-store");
  assert.equal(completed.headers.get("referrer-policy") ?? "", "no-referrer");
  assert.equal(completed.headers.get("x-frame-options") ?? "", "DENY");
  assert.ok(tokenParameters);
  assert.equal(tokenParameters.code_verifier, record.codeVerifier);
  assert.equal(states.has(`github:oauth:${state}`), false);
  assert.match(completed.headers.get("set-cookie") ?? "", /__Host-RUNNER_GITHUB_STATE=;/);
  assert.match(completed.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("authorization rejects scopes outside the declared Harness products", () => {
  for (const scope of ["unknown:scope", "sessions:manage", "environments:manage"]) {
    assert.throws(() => describeScopes([scope]), /Unknown OAuth scope/);
  }
});

function consentRequest(decision: string, csrf = "csrf-123", cookie = csrf) {
  return new Request("https://runner.example.com/authorize/consent", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `__Host-RUNNER_CSRF=${cookie}`,
    },
    body: new URLSearchParams({ csrf, decision }),
  });
}

async function csrfFromResponse(response: Response) {
  const match = (await response.text()).match(/name="csrf" value="([^"]+)"/);
  if (!match) throw new Error("Missing CSRF form value");
  return match[1];
}

function cookieFromResponse(response: Response, name: string) {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const match = cookie.match(new RegExp(`${name}=([^;,]*)`));
    if (match) return match[1];
  }
  throw new Error(`Missing cookie: ${name}`);
}

function invisibleWritesKv() {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
  };
}

function authorizationError(code: string, options: { description: string; redirectUri?: string; state?: string; issuer?: string }) {
  const error = new Error(options.description);
  error.name = "AuthorizationError";
  return Object.assign(error, { code, ...options });
}

async function consentRecord(request: ConsentState["authRequest"], browserSession = "csrf-123"): Promise<ConsentState> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(browserSession),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return {
    authRequest: request,
    browserBindingHash: btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", ""),
  };
}
