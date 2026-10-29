import { isAbsolute, join } from "node:path";

export type T3Executor = "codex" | "grok";

/**
 * T3 is a separately installed execution service. It reads the native Codex
 * or Grok configuration already written into HOME by configureProvider().
 * Do not copy credentials into T3 settings or into MCP/Task results.
 */
export function t3ProviderEnvironment(executor: T3Executor, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = source.HOME;
  if (!home || !isAbsolute(home) || !source.MINI_END_USER_KEY ||
      !source[executor === "codex" ? "MINI_CODEX_BASE_URL" : "MINI_GROK_BASE_URL"]) {
    throw new Error("T3_PROVIDER_UNAVAILABLE");
  }
  // A separate allowlist prevents job control/OIDC authority from leaking into
  // the T3 process while preserving the explicitly approved Agent work token.
  return {
    HOME: home,
    PATH: [join(home, ".local", "bin"), source.PATH].filter(Boolean).join(":"),
    ...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}),
    ...(source.LANG ? { LANG: source.LANG } : {}),
    ...(source.CI ? { CI: source.CI } : {}),
    MINI_END_USER_KEY: source.MINI_END_USER_KEY,
    ...(source.GH_TOKEN ? { GH_TOKEN: source.GH_TOKEN } : {}),
  };
}
