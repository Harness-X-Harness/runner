# Live Story: Private Development Environment

Use this story after a merged change affects the Private Development
Environment workflow, Tailscale, T3, Quick Tunnel, LarkSend, connection files,
or environment cleanup. This is a human-in-the-loop production acceptance
story for vibe coding. It is not an automated test or a CI job.

## User story

As the owner, I can start one zero-input temporary development machine, receive
its private connection descriptor in Lark, connect through Tailscale SSH and T3,
and cancel the GitHub run without leaving a live runner or publishing pairing
credentials.

## Preconditions

- The change is merged to `main`; `session--none` only permits that branch.
- `gh` is authenticated for `Harness-X-Harness/runner`.
- The Agent's machine is online in the same Tailscale network.
- The user can read the configured Lark chat and complete T3 pairing.
- No pairing URL, token, private IP, provider endpoint, or secret is copied into
  chat, issue comments, Actions output, summaries, or artifacts.

## Roles

The Agent performs all non-sensitive probes, keeps the user informed, and
cancels the run after acceptance. The Agent must pause at the explicit user
gates instead of operating the user's Lark or pairing UI.

The user confirms the Lark card and completes native T3 pairing. The user does
not need to copy the pairing URL back to the Agent.

## Story

### 1. Start one environment

The Agent dispatches **Private Development Environment** on `main` without
inputs and records the new run only for the current acceptance session.

Wait by observing GitHub step state. Do not use a fixed sleep as a readiness
signal. Continue when these steps have succeeded and **Keep environment
running** is active:

- development tools
- private network
- T3 session
- LarkSend

### 2. Confirm the one-shot Lark delivery

Pause for the user to confirm that the newest run produced:

- exactly one Ready card;
- no Starting card;
- Open T3, Pair T3, GitHub run, and Tailscale SSH information;
- no message update when an earlier run was cancelled.

Do not add Lark message-history permission only to automate this confirmation.

### 3. Probe the private machine

The Agent finds the peer named `gha-<run-id>-<run-attempt>` in Tailscale and
connects as `runner` through Tailscale SSH.

Verify without changing the workspace:

- the peer is online and SSH succeeds;
- `$HOME/workspace` is empty, owned by `runner`, and mode `0700`;
- `codex --version`, `claude --version`, and `grok --version` succeed;
- T3 on `127.0.0.1:3773` returns HTTP 200;
- `t3-url`, `pairing-url`, and `connection.txt` are mode `0600`.

Version numbers are evidence, not pinned expectations. The workflow installs
the official current versions.

### 4. Probe the public T3 descriptor

Read the two runner-local URL files only inside a remote probe. Print boolean
results, never the values.

Verify:

- the T3 origin is an HTTPS Quick Tunnel;
- the pairing URL is an HTTPS Quick Tunnel;
- both URLs have the same origin;
- the pairing path is `/pair`;
- a `token` exists in the URL fragment;
- the pairing route returns HTTP 200.

The expected evidence shape is:

```text
TUNNEL_PUBLIC=true
PAIRING_PUBLIC=true
ORIGINS_MATCH=true
PAIR_PATH_VALID=true
PAIR_TOKEN_PRESENT=true
PAIR_ROUTE_HTTP=200
```

This story does not prescribe a shell loop. The workflow's `await-log` Action
waits for the Quick Tunnel log value before T3 issues the public pairing URL.

### 5. Complete native pairing

Pause. The user opens **Pair T3** from the newest Lark card and confirms that
native pairing succeeds. Do not ask the user to paste the URL or token.

If this gate is unavailable, cancel the run and record pairing as not tested.
Do not leave the runner active while waiting for a later session.

### 6. Cancel and prove cleanup

After the user confirms pairing, the Agent cancels the same GitHub run and
waits for:

- GitHub status `completed` with conclusion `cancelled`;
- the matching Tailscale peer to report offline and inactive;
- zero artifacts;
- zero actual Quick Tunnel or pairing URL values in the completed run log.

Source-code strings such as `Pairing URL:` or `PAIRING_URL=` are not credential
leaks. Count only lines that contain an actual URL value.

LarkSend has no cleanup update. The existing Ready card remains, while GitHub
Actions is authoritative for whether the environment is still online.

## Stop conditions

Cancel the run before further diagnosis when:

- the user or Agent exposes a pairing URL or token outside the trusted Lark
  delivery;
- Pair T3 uses a loopback or different origin;
- the workflow fails before keep-alive;
- the user cannot complete the manual gate in the current session.

Do not hide a failure with a retry, fallback tunnel, fixed sleep, or a second
notification lifecycle.

## Acceptance record

Record only a short, redacted conclusion:

```text
Environment startup: passed | failed | not tested
Lark one-shot card: passed | failed | not tested
Tailscale SSH and workspace: passed | failed | not tested
Installed CLIs: passed | failed | not tested
T3 public descriptor: passed | failed | not tested
Native pairing: passed | failed | not tested
Cancellation and peer offline: passed | failed | not tested
Credential log/artifact scan: passed | failed | not tested
```

Do not preserve transient run IDs, host addresses, URLs, tokens, or full logs in
this document.
