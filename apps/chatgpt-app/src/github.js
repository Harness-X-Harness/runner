export function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "HarnessXHarness",
    "x-github-api-version": "2026-03-10",
  };
}
