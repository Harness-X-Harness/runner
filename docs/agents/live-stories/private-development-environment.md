# Live Story: Private Development Environment

Use this human-in-the-loop story after a merged and deployed change affects
the ChatGPT Environment tools, workflow, Tailscale, T3, Quick Tunnel, private
entry, or cleanup. Do not convert it into CI automation.

## User story

As the authenticated owner, I can ask ChatGPT to open one temporary development
machine, use one stable private entry to complete native T3 pairing, connect by
Tailscale SSH, and close the same runner without publishing pairing credentials.

## Preconditions

- The change is merged to `main` and the Worker is deployed.
- `gh` is authenticated for `Harness-X-Harness/runner`.
- The Agent machine is in the same Tailscale network.
- The user can refresh and reconnect the ChatGPT MCP connection.
- No pairing URL, token, private address, provider endpoint, or secret is copied
  into chat, issues, Actions output, summaries, artifacts, or tracked files.

## Roles

The Agent performs all non-sensitive probes and cleanup. It pauses for the user
to refresh or reconnect ChatGPT, confirm GitHub browser identity, and complete
native T3 pairing. The user never pastes pairing access back to the Agent.

## Story

### 1. Refresh the ChatGPT connection

Pause. The user refreshes the MCP metadata, reconnects once, and confirms the
single Environment-management permission. The user starts a new conversation.

### 2. Open one Environment

The user calls `open_environment` without arguments. Confirm that it returns:

- status Starting or Ready;
- the stable `https://runners.trustedtunnel.app/environment` entry;
- the exact non-sensitive GitHub run link;
- no T3 origin, pairing URL, token, private address, or provider endpoint.

If ChatGPT renders the inline card, confirm that it leaves Loading after the
tool result arrives and that both the stable Environment action and the GitHub
run action are enabled. The card does not poll Starting for Ready.

Call it again and confirm that it returns the same active run instead of
dispatching another one.

### 3. Confirm identity and pair T3

Pause. The user opens the stable Environment entry, completes GitHub identity
confirmation, sees Preparing, and then completes T3's native pairing flow. The
user does not copy the destination or token into ChatGPT.

### 4. Probe the private machine

The Agent observes the exact GitHub run until **Keep environment running** is
active. It finds `gha-<run-id>-<run-attempt>` in Tailscale, connects as `runner`,
and verifies without changing the workspace:

- peer online and Tailscale SSH succeeds;
- `$HOME/workspace` is empty, owned by `runner`, and mode `0700`;
- `codex --version` and `grok --version` succeed;
- T3 on `127.0.0.1:3773` returns HTTP 200;
- `t3-url`, `pairing-url`, and `connection.txt` are mode `0600`.

Read URL files only inside a remote boolean probe. Verify that the two HTTPS
URLs share one Quick Tunnel origin, pairing uses `/pair`, its fragment contains
a token, and the pairing route returns HTTP 200. Never print either URL.

### 5. Close and prove cleanup

The user calls `close_environment` without arguments. The Agent confirms:

- the exact run becomes `completed` with conclusion `cancelled`;
- the matching Tailscale peer becomes offline;
- the stable Environment entry reports Offline;
- a repeated close stays Offline and does not affect another run;
- the run has zero artifacts;
- MCP results, run logs, summaries, and artifacts contain no actual temporary
  origin or pairing URL value.

For a change that affects reopen convergence, call `open_environment` before
the cancelled run becomes terminal. Confirm that the card shows Closing,
repeats the Open intent without another user action, then changes to Starting
with one new exact run. Confirm that no second replacement run is dispatched,
then close the replacement run and repeat the cleanup checks above.

If ChatGPT is unavailable, cancel the exact GitHub run directly and confirm the
same terminal and Offline state.

## Stop conditions

Cancel the run before more diagnosis if a pairing credential is exposed, T3
pairing uses loopback or a different origin, startup fails before keep-alive,
or the user cannot complete the current manual gate. Do not add a fallback
tunnel, fixed sleep, heartbeat, or second lifecycle owner.

## Acceptance record

Record only this redacted state in local project memory:

```text
Worker and MCP contracts: passed | failed | not tested
ChatGPT refresh and permission: passed | failed | not tested
Stable Environment entry and ownership: passed | failed | not tested
Native T3 pairing: passed | failed | not tested
Tailscale SSH and workspace: passed | failed | not tested
Installed CLIs: passed | failed | not tested
Private descriptor: passed | failed | not tested
Close, terminal run, and peer offline: passed | failed | not tested
Credential log/artifact scan: passed | failed | not tested
```

Do not preserve run IDs, addresses, URLs, tokens, or full logs.
