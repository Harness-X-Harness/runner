import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Deployment owns this setting because Wrangler cannot yet declare it. */
export async function secureWorkerLogs(account: string, script: string, token: string, fetchImpl: typeof fetch = fetch) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/${encodeURIComponent(script)}/settings`;
  const request = async (init?: RequestInit) => {
    const response = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Worker log settings request failed (${response.status})`);
    const body = await response.json() as { success?: boolean; result?: { observability?: Record<string, unknown> } };
    if (body.success !== true || !body.result) throw new Error("Worker log settings unavailable");
    return body.result.observability ?? {};
  };
  const current = await request();
  const form = new FormData();
  form.set("settings", JSON.stringify({ observability: { ...current, redact_query_string: true,
    logs: { ...(current.logs as object ?? {}), invocation_logs: false },
    traces: { ...(current.traces as object ?? {}), enabled: false },
  } }));
  await request({ method: "PATCH", body: form });
  const verified = await request();
  if (verified.redact_query_string !== true ||
      (verified.logs as { invocation_logs?: boolean } | undefined)?.invocation_logs !== false ||
      (verified.traces as { enabled?: boolean } | undefined)?.enabled !== false) {
    throw new Error("Worker deployed, but private log settings were not confirmed");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--dry-run")) throw new Error("Only --dry-run is supported");
  const local = parseEnv(await readFile(new URL("../../.secrets.env", import.meta.url), "utf8"));
  const env = { ...process.env };
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (!local[name]) throw new Error(`Missing ${name}`);
    env[name] = local[name];
  }
  const { unstable_readConfig } = await import("wrangler");
  const config = unstable_readConfig({ config: fileURLToPath(new URL("wrangler.jsonc", import.meta.url)) });
  if (!config.name) throw new Error("Worker name missing");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("node_modules/wrangler/bin/wrangler.js", import.meta.url)), "deploy", ...args],
      { cwd: fileURLToPath(new URL(".", import.meta.url)), env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error("Wrangler deployment failed")));
  });
  if (args.includes("--dry-run")) return;
  await secureWorkerLogs(env.CLOUDFLARE_ACCOUNT_ID!, config.name, env.CLOUDFLARE_API_TOKEN!);
  process.stdout.write("Worker deployment and private log settings confirmed.\n");
}

if (import.meta.main) main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Deployment failed"}\n`);
  process.exitCode = 1;
});
