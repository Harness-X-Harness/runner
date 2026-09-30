import { createServer } from "node:http";
import { deliverWebhook } from "./delivery.ts";

// Only the Container binding forwards requests here. There is no public route.
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/deliver") { res.writeHead(404).end(); return; }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 600 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const result = await deliverWebhook(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(result));
  } catch { res.writeHead(400).end(); }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
// The Container sends SIGTERM on idle. Node runs as PID 1, so handle it
// explicitly and finish accepted requests before exiting.
process.once("SIGTERM", () => server.close(() => process.exit(0)));
server.listen(8080, "0.0.0.0");
