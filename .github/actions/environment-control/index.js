const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const controlPlaneUrl = input("control-plane-url").replace(/\/$/, "");
  const environmentId = input("environment-id");
  const sessionDirectory = path.join(
    process.env.HOME,
    "private-runner-session",
    "t3code",
  );
  const [t3Url, pairingUrl] = await Promise.all([
    read(path.join(sessionDirectory, "t3-url")),
    read(path.join(sessionDirectory, "pairing-url")),
  ]);
  process.stdout.write(`::add-mask::${t3Url}\n::add-mask::${pairingUrl}\n`);
  const token = await oidcToken(controlPlaneUrl);
  process.stdout.write(`::add-mask::${token}\n`);
  const response = await fetch(
    `${controlPlaneUrl}/internal/environments/${encodeURIComponent(environmentId)}/ready`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        t3Url,
        pairingUrl,
        tailscaleHost: `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Environment callback failed with ${response.status}`);
  }
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
}

async function read(file) {
  return (await fs.readFile(file, "utf8")).trim();
}

async function oidcToken(audience) {
  const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: {
      authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC token request failed with ${response.status}`);
  }
  return (await response.json()).value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
