/** Emit a reviewable standalone Wrangler config. No deploy, secret loading, or API calls. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stagingConfig, type ProductionConfig } from "./helpers/t3-staging.ts";

async function main() {
  if (process.argv.length !== 3) throw new Error();
  const require = createRequire(new URL("../apps/chatgpt-app/package.json", import.meta.url));
  const { unstable_readConfig } = require("wrangler") as {
    unstable_readConfig(input: { config: string }): ProductionConfig;
  };
  const production = unstable_readConfig({ config: fileURLToPath(new URL("../apps/chatgpt-app/wrangler.jsonc", import.meta.url)) });
  const config = stagingConfig(JSON.parse(await readFile(process.argv[2]!, "utf8")), production);
  process.stdout.write(JSON.stringify(config, null, 2) + "\n");
  process.stderr.write("OFFLINE CONFIG ONLY: resource ownership, protected branch revision, OAuth and deployment remain unverified.\n");
}

if (import.meta.main) main().catch(() => {
  // Input can accidentally contain credentials; never echo it or a parser error.
  process.stderr.write("T3_STAGING_PREPARATION_FAILED\n");
  process.exitCode = 1;
});
