async function main() {
  const controlPlaneUrl = input("control-plane-url").replace(/\/$/, "");
  const environmentId = input("environment-id");
  const token = await oidcToken(controlPlaneUrl);
  process.stdout.write(`::add-mask::${token}\n`);
  const response = await fetch(
    `${controlPlaneUrl}/internal/environments/${encodeURIComponent(environmentId)}/claim`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  if (!response.ok) {
    throw new Error(`Environment callback failed with ${response.status}`);
  }
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? "";
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
