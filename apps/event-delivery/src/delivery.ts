import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { isIP } from "node:net";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import type { WebhookDeliveryResult } from "../../../shared/webhook-delivery.ts";

const payloadBytes = 256 * 1024;
const responseBytes = 4096;
export type DeliveryDependencies = {
  resolve(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
  request(url: URL, options: RequestOptions, response: (value: IncomingMessage) => void): ClientRequest;
};
const input = z.object({ url: z.string().max(4096), body: z.string(), headers: z.object({
  "webhook-id": z.string().min(1).max(256).regex(/^[\w-]+$/),
  "webhook-timestamp": z.string().regex(/^\d{1,16}$/),
  "webhook-signature": z.string().min(1).max(1024).regex(/^[\w+/=, -]+$/),
  "x-mcp-subscription-id": z.string().min(1).max(256).regex(/^[\w-]+$/),
}).strict() }).strict().refine(value => Buffer.byteLength(value.body, "utf8") <= payloadBytes);

export function callbackUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_destination"); }
  // First supported transport is HTTPS on its standard port, with a DNS name.
  // IP literals and userinfo are not valid callback identities for this service.
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash ||
      !url.hostname.includes(".") || isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("invalid_destination");
  return url;
}

export function publicDestination(records: readonly { address: string; family: number }[]) {
  // Reject mixed public/private answers, mapped loopback, multicast, reserved and
  // transition ranges. No connection starts before the whole answer is checked.
  if (!records.length || records.some(value => ![4, 6].includes(value.family) ||
    !ipaddr.isValid(value.address) || ipaddr.parse(value.address).range() !== "unicast" ||
    (isIP(value.address) !== value.family))) throw new Error("invalid_destination");
  return records.find(value => value.family === 4) ?? records[0]!;
}

/** One bounded POST; no redirects, pooling, retries or persisted state. */
export async function deliverWebhook(raw: unknown,
  dependencies: DeliveryDependencies = { resolve: lookup, request }): Promise<WebhookDeliveryResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { kind: "error", reason: "invalid_request" };
  const signal = AbortSignal.timeout(10_000);
  try {
    const url = callbackUrl(parsed.data.url);
    const records = await Promise.race([
      dependencies.resolve(url.hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
    signal.throwIfAborted();
    const destination = publicDestination(records);
    return await new Promise<WebhookDeliveryResult>((resolve, reject) => {
      const req = dependencies.request(url, {
        method: "POST", agent: false, signal,
        // Explicit family also disables Node's automatic multi-address racing.
        family: destination.family,
        servername: url.hostname, rejectUnauthorized: true,
        // Node connects to this exact checked address, but verifies the original
        // URL hostname. This callback performs no second DNS lookup.
        lookup: (_hostname, _options, done) => done(null, destination.address, destination.family),
        headers: { ...parsed.data.headers, "content-type": "application/json",
          "content-length": String(Buffer.byteLength(parsed.data.body)) },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > responseBytes) {
            resolve({ kind: "error", reason: "response_too_large" });
            response.destroy(); req.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve({ kind: "response", status: response.statusCode ?? 502,
          body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(parsed.data.body);
    });
  } catch (error) {
    return { kind: "error", reason: signal.aborted ? "timeout"
      : error instanceof Error && error.message === "invalid_destination" ? "invalid_destination" : "network" };
  }
}
