/** Reproducible local checks; never deploys, opens Environments or enables a tunnel/provider run. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--native" || !isAbsolute(args[1]!))) throw new Error();
  const root = await mkdtemp(tmpdir() + "/runner-staging-checks-");
  // In particular: no GH/Cloudflare/provider credentials, NODE_OPTIONS, remote
  // origins, or ambient T3 live/model opt-ins reach either child.
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, WRANGLER_SEND_METRICS: "false" };
  const run = (commandArgs: string[], extra: NodeJS.ProcessEnv = {}) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: fileURLToPath(new URL("../", import.meta.url)), env:{...env,...extra}, stdio:"inherit",
    });
    child.once("error", () => reject(new Error()));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error()));
  });
  try {
    await run(["--test", "tests/t3-staging.test.ts", "tests/t3-access.test.ts", "tests/t3-authority.test.ts",
      "tests/t3-connection.test.ts", "tests/t3-lifecycle.test.ts", "tests/t3-acceptance.test.ts"]);
    if (args.length) await run(["tests/run-t3-acceptance.ts"], {T3_ACCEPTANCE:"1", T3_LIVE_BINARY:args[1]!});
    console.log("Local staging preparation checks passed. G1–G5 and human browser gates remain UNVALIDATED.");
  } finally { await rm(root, {recursive:true,force:true}); }
}

if (import.meta.main) main().catch(() => {
  process.stderr.write("T3_STAGING_LOCAL_CHECKS_FAILED\n");
  process.exitCode = 1;
});
