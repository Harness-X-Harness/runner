import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { IncomingMessage, type ClientRequest } from "node:http";
import { Socket } from "node:net";
import { callbackUrl, publicDestination, deliverWebhook, type DeliveryDependencies } from "../apps/event-delivery/src/delivery.ts";

const message = { url: "https://receiver.example.com/callback", body: '{"type":"verification","challenge":"opaque"}', headers: {
  "webhook-id": "msg_verification_1", "webhook-timestamp": "1790770000",
  "webhook-signature": "v1,abc=", "x-mcp-subscription-id": "sub_1",
} };

test("webhook destination policy rejects non-public addresses and unsafe URL identities", () => {
  for (const value of ["invalid", "http://example.com", "https://127.0.0.1/", "https://2130706433/", "https://[::1]/",
    "https://user:pass@example.com/", "https://example.com:8443/", "https://example.com/#secret", "https://localhost/"]) {
    assert.throws(() => callbackUrl(value));
  }
  for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1",
    "192.0.2.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "::ffff:127.0.0.1", "ff02::1"]) {
    assert.throws(() => publicDestination([{ address, family: address.includes(":") ? 6 : 4 }]));
  }
  assert.throws(() => publicDestination([]));
  assert.throws(() => publicDestination([{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]));
  assert.deepEqual(publicDestination([{ address: "2606:4700:4700::1111", family: 6 }]),
    { address: "2606:4700:4700::1111", family: 6 });
});

test("one checked DNS answer pins the connection while retaining TLS hostname and signed bytes", async () => {
  let queries = 0;
  let ended = "";
  const result = await deliverWebhook(message, {
    resolve: async () => { queries++; return [{ address: "1.1.1.1", family: 4 }]; },
    request: (url, options, onResponse) => {
      assert.equal(String(url), message.url);
      assert.equal(options.agent, false);
      assert.equal(options.servername, "receiver.example.com");
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.method, "POST");
      assert.equal(options.family, 4);
      assert.deepEqual(options.headers, { ...message.headers, "content-type": "application/json",
        "content-length": String(Buffer.byteLength(message.body)) });
      assert.ok(options.lookup);
      options.lookup("receiver.example.com", {}, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, "1.1.1.1"); assert.equal(family, 4);
      });
      const req = new EventEmitter() as EventEmitter & { end(body: string): void; destroy(): void };
      req.destroy = () => {};
      req.end = body => {
        ended = body;
        const response = new IncomingMessage(new Socket()); response.statusCode = 307;
        onResponse(response);
        response.emit("data", Buffer.from("not followed")); response.emit("end");
      };
      return req as unknown as ClientRequest;
    },
  });
  assert.equal(queries, 1);
  assert.equal(ended, message.body);
  assert.deepEqual(result, { kind: "response", status: 307, body: "not followed" });
});

test("private answers and invalid signed envelopes stop before an HTTPS connection", async () => {
  let started = false;
  const dependencies: DeliveryDependencies = {
    resolve: async () => [{ address: "169.254.169.254", family: 4 }],
    request: () => { started = true; throw new Error("PRIVATE_DETAIL"); },
  };
  assert.deepEqual(await deliverWebhook(message, dependencies), { kind: "error", reason: "invalid_destination" });
  assert.deepEqual(await deliverWebhook({ ...message, headers: { ...message.headers, authorization: "PRIVATE" } }, dependencies),
    { kind: "error", reason: "invalid_request" });
  assert.deepEqual(await deliverWebhook({ ...message, body: "x".repeat(256 * 1024 + 1) }, dependencies),
    { kind: "error", reason: "invalid_request" });
  assert.equal(started, false);
});

test("network errors and oversized callback responses have bounded, non-sensitive results", async () => {
  const resolve = async () => [{ address: "1.1.1.1", family: 4 }];
  assert.deepEqual(await deliverWebhook(message, { resolve, request: () => { throw new Error("PRIVATE_URL"); } }),
    { kind: "error", reason: "network" });
  const result = await deliverWebhook(message, { resolve, request: (_url, _options, onResponse) => {
    const req = Object.assign(new EventEmitter(), { destroy() {}, end() {
      const response = new IncomingMessage(new Socket()); response.statusCode = 200;
      onResponse(response); response.emit("data", Buffer.alloc(4097));
    } });
    return req as unknown as ClientRequest;
  } });
  assert.deepEqual(result, { kind: "error", reason: "response_too_large" });
});
