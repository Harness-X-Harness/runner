import { environmentRequest } from "./environment.js";
import { verifyEnvironmentIdentity } from "./environment-identity.js";

export async function publishEnvironmentReady(env, environmentId, runId, descriptor) {
  const identity = await verifyEnvironmentIdentity(
    environmentId,
    env.ENVIRONMENT_SESSION_SECRET,
  );
  if (!identity) return json({ error: "invalid environment identity" }, 404);
  if (
    typeof descriptor?.pairingUrl !== "string" ||
    typeof descriptor?.t3Url !== "string" ||
    typeof descriptor?.tailscaleHost !== "string" ||
    !validDescriptor(descriptor)
  ) return json({ error: "invalid environment descriptor" }, 400);

  try {
    const environment = await environmentRequest(
      env,
      identity.ownerId,
      "/environment/ready",
      {
        method: "POST",
        body: JSON.stringify({
          generation: environmentId,
          runId: String(runId),
          pairingUrl: descriptor.pairingUrl,
          t3Url: descriptor.t3Url,
          tailscaleHost: descriptor.tailscaleHost,
        }),
      },
    );
    return json({ status: environment.status });
  } catch {
    return json({ error: "environment callback is stale" }, 409);
  }
}

function validDescriptor(descriptor) {
  try {
    const t3 = new URL(descriptor.t3Url);
    const pairing = new URL(descriptor.pairingUrl);
    return t3.protocol === "https:" &&
      pairing.protocol === "https:" &&
      pairing.origin === t3.origin &&
      pairing.pathname === "/pair" &&
      new URLSearchParams(pairing.hash.slice(1)).has("token") &&
      /^gha-\d+-\d+$/.test(descriptor.tailscaleHost);
  } catch {
    return false;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
