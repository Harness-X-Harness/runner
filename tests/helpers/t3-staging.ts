/** Offline configuration only. This module never contacts Cloudflare or GitHub. */
export type ProductionConfig = {
  name: string;
  compatibility_date: string;
  compatibility_flags: string[];
  durable_objects: { bindings: Array<{ name: string; class_name: string; script_name?: string }> };
  kv_namespaces: Array<{ binding: string; id: string }>;
  vars: Record<string, string | number>;
  routes: Array<{ pattern: string }>;
};

const fields = ["accountId", "workerName", "origin", "oauthKvId", "githubAppClientId",
  "executionRepository", "runtimeBranch", "runtimeRevision"] as const;
export type StagingManifest = Record<typeof fields[number], string>;

export function stagingManifest(input: unknown, production: ProductionConfig): StagingManifest {
  const fail = (): never => { throw new Error("T3_STAGING_MANIFEST_INVALID_OR_SHARED"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some(key =>
    typeof value[key] !== "string" || value[key] !== value[key].trim() || !value[key])) return fail();
  const manifest = value as StagingManifest;
  if (!/^[a-f0-9]{32}$/.test(manifest.accountId) || !/^[a-f0-9]{32}$/.test(manifest.oauthKvId) ||
      !/^[a-z0-9][a-z0-9-]*-staging-[a-z0-9-]+$/.test(manifest.workerName) || manifest.workerName.length > 63 ||
      manifest.workerName === production.name ||
      production.kv_namespaces.some(item => item.id === manifest.oauthKvId) ||
      !/^Iv[0-9A-Za-z]+$/.test(manifest.githubAppClientId) ||
      manifest.githubAppClientId === production.vars.GITHUB_APP_CLIENT_ID ||
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(manifest.executionRepository) ||
      manifest.executionRepository.toLowerCase() === String(production.vars.GITHUB_RUNNER_REPOSITORY).toLowerCase() ||
      !/^[a-f0-9]{40}$/.test(manifest.runtimeRevision) ||
      !/^[A-Za-z0-9][A-Za-z0-9_/-]*[A-Za-z0-9]$/.test(manifest.runtimeBranch) ||
      manifest.runtimeBranch.includes("//") || manifest.runtimeBranch.startsWith("refs/")) return fail();
  let origin: URL;
  try { origin = new URL(manifest.origin); } catch { return fail(); }
  if (origin.protocol !== "https:" || origin.origin !== manifest.origin || origin.port ||
      !/^[a-z0-9.-]+$/.test(origin.hostname) || !origin.hostname.includes(".") ||
      origin.hostname.endsWith(".") || origin.hostname === "localhost" ||
      /^\d+\.\d+\.\d+\.\d+$/.test(origin.hostname)) return fail();
  const productionHosts = [new URL(String(production.vars.TASK_CONTROL_PLANE_URL)).hostname,
    ...production.routes.map(route => route.pattern)];
  if (productionHosts.some(host => origin.hostname === host || origin.hostname.endsWith("." + host))) return fail();
  return manifest;
}

/** Construct a standalone config; never inherit routes, state IDs, services or migrations. */
export function stagingConfig(input: unknown, production: ProductionConfig) {
  const manifest = stagingManifest(input, production);
  const bindings = production.durable_objects.bindings.map(({ name, class_name, script_name }) => {
    if (script_name) throw new Error("T3_STAGING_EXTERNAL_DO_BINDING_REJECTED");
    return { name, class_name };
  });
  return {
    name: manifest.workerName, account_id: manifest.accountId, main: "src/index.ts",
    build: { command: "npm run build:ui" },
    rules: [{ type: "Text", globs: ["**/*.css"], fallthrough: true }],
    compatibility_date: production.compatibility_date, compatibility_flags: production.compatibility_flags,
    workers_dev: false, preview_urls: false,
    // No query, invocation, trace, or application logs before private settings are verified.
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } },
    routes: [{ pattern: new URL(manifest.origin).hostname, custom_domain: true }],
    durable_objects: { bindings },
    migrations: [{ tag: "staging-v1", new_sqlite_classes: bindings.map(binding => binding.class_name) }],
    containers: [{ class_name: "EventDeliveryContainer", image: "../event-delivery/Dockerfile",
      instance_type: "lite", max_instances: 1 }],
    kv_namespaces: [{ binding: "OAUTH_KV", id: manifest.oauthKvId }],
    vars: {
      GITHUB_CI_EVENT_REPOSITORIES: JSON.stringify([manifest.executionRepository]),
      ENVIRONMENT_STARTUP_MS: production.vars.ENVIRONMENT_STARTUP_MS,
      GITHUB_RUNNER_REPOSITORY: manifest.executionRepository, GITHUB_RUNNER_REF: manifest.runtimeBranch,
      GITHUB_APP_CLIENT_ID: manifest.githubAppClientId, TASK_CONTROL_PLANE_URL: manifest.origin,
    },
  };
}
