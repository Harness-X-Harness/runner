import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { buildWorkbench } from "../build-ui.ts";

/** Local files + local fixtures only. No MCP client, credentials, or proxy route. */
export async function startPreview(port = 4173) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'none'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    try {
      const local = server.address();
      if (!local || typeof local === "string" || request.headers.host !== `127.0.0.1:${local.port}`) {
        response.writeHead(403).end("Use the printed loopback address."); return;
      }
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      const path = new URL(request.url!, "http://localhost").pathname;
      if (path === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await readFile(new URL("./index.html", import.meta.url)));
      } else if (path === "/host.js") {
        const built = await build({ entryPoints: [new URL("./host.ts", import.meta.url).pathname], bundle: true,
          write: false, format: "esm", platform: "browser", target: "es2022" });
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(built.outputFiles[0]!.text);
      } else if (path === "/workbench") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await buildWorkbench());
      } else { response.writeHead(404).end("Not found"); }
    } catch (error) {
      console.error(error);
      response.writeHead(500).end("Preview build failed. Check the local terminal.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing preview address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

if (import.meta.main) {
  const { url } = await startPreview(Number(process.env.PREVIEW_PORT ?? 4173));
  console.log(`AgentEnv frontend preview: ${url}\nLocal fixtures only. Stop with Ctrl+C.`);
}
