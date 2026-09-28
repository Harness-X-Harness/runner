# ACP SDK integration probe

This TypeScript experiment uses the stable ACP v1 entry point of the official
`@agentclientprotocol/sdk`. It imports the same TypeScript ACP modules as the
production runtime rather than keeping separate client implementations.
The SDK owns protocol validation, framing, correlation and connection teardown.
Harness supplies the child process, explicit environment and client callbacks.

```sh
npm ci --prefix experiments/acp
npm ci --prefix .github/actions/agent-runtime
npm --prefix experiments/acp run typecheck
node --test experiments/acp/*.test.ts
```

Use a Node version with native TypeScript support. Tests launch a deterministic
SDK-based agent and check unavailable-process behavior. They make no model calls
and prove neither Codex/Grok support nor production acceptance. Real-provider
input, cancellation and timeout evidence is still required before replacement.

Final results consume the SDK ActiveSession queue through its stop message, not
an independently resolved prompt promise plus notification callbacks. A small
Grok input transform maps response boundaries to standard session updates with
metadata, before the SDK queues them. Framing and request matching stay in the
SDK. Tests cover consecutive turns and preserve the notification-order regression.

## Real provider continuity and cancellation

```sh
node experiments/acp/probe.ts grok /absolute/private-config-root
node experiments/acp/probe.ts codex /absolute/private-config-root
```

The source root must contain the selected provider's `.grok/config.toml` or
`.codex/config.toml`. Only the selected model/provider is
copied into a private temporary home using `smol-toml`; other MCP servers and
personal configuration are excluded. The probe runs four model turns in one ACP
session, with a 90-second budget per prompt: two-turn recall, cancel during actual
output, then recall again. Ordinary provider charges apply.
It reports only a check name and status, then closes the process and removes its
temporary home. It does not validate input requests or long waits. Codex uses
the published ACP adapter, not Harness's App Server driver.

Use `final` after the config root to request commentary, a controlled tool call,
and then an exact final marker. The result selector must return only that marker,
using Codex message identity/phase or Grok response boundaries. Native tool
discovery is permitted; exactly one target-tool call is still required. This does not
replace the production runtime and does not count as a pass if the tool is not called.

Use `runtime` to test the production AgentRuntime entry point, including its
log-isolated Node Worker and default CLI selection. It creates one private
README with a random first line, asks the Agent to read it without changing
files, and requires that exact final result. A 90-second outer deadline closes
the runtime. This is a local provider test, not GitHub/Cloudflare acceptance.

Use `environment` to test the production `withEnvironment` and provider-process
selection. Two direct command operations write/read a private random marker;
an Agent operation reads that same workspace and the next recalls it without
tools. All four operations share one Environment and a 90-second hard deadline.
The probe closes the Environment and provider before reporting success. This
does not test the public MCP, runner transport, OIDC or GitHub lifecycle.

Use `environment-ci 65000` to call the Environment's private
`wait_for_github_run` tool through the selected real provider. The final argument
is the controlled hold in milliseconds (1–65000); the Environment has a
180-second deadline. The probe approves only that tool's ACP permission request.
It requires one registration, one initial GitHub read and the same native turn's
exact final result. GitHub is a local fixture and registration acknowledgement
and completion are controlled in-process. This proves provider integration, not
GitHub webhook delivery or production acceptance. No actual GitHub token is used.

Add `wait` after the config root to add one local MCP tool call. The fixture uses
the official MCP Node transport, waits five seconds after tool entry, and returns
an unpredictable marker to the pending prompt. The probe rejects duplicate calls
and premature completion. This is not a test of the provider's default timeout,
tool-wait cancellation or all late-result schedules. A successful report is
printed only after both process and temporary-resource cleanup finish.

Use `wait-cancel` instead to cancel after the tool has entered, wait for the
native cancelled response, then release the late tool result. The one-second
quiet-output observation is one bounded schedule, not proof of all interleavings.
The following turns must still operate on the same session.

The client registers ACP form elicitation only when a handler is provided and
advertises only that capability. This extension is marked unstable by the SDK;
the deterministic test proves SDK wiring, not real-provider support.

`question` mode makes one prompt and asks the local MCP tool for an unpredictable
form answer. The ACP callback supplies the answer; the original prompt must use
it. This mode does not repeat continuity/cancellation checks or prove elicitation
in later turns. Grok explicitly selects its native `_x.ai/mcp/elicit` extension
and `outcome` response field; Codex selects ACP `elicitation/create`. There is no
runtime fallback between them. Grok's form is validated with the SDK's form guard.

`question-later` runs two continuity prompts before the input prompt, without
repeating the unrelated output-cancellation scenario.
Question prompts permit native tool discovery, while still requiring exactly one
target-tool call and the real form answer. A model reporting a missing tool is
not a successful elicitation check. Failure evidence includes only bounded flags
and counts, not provider text, endpoints, credentials or raw protocol messages.

`question-cancel` holds a form answer, cancels the prompt, waits for `cancelled`,
and only then sends the old answer. It checks a one-second quiet window and
recall in the same session afterward.

`timeout` explicitly configures the native MCP server's `tool_timeout_sec = 2`
in the temporary provider config, rather than sending a nonexistent ACP timeout
field. It withholds the result until the prompt completes, requires a failed
native tool event identifying a timeout, and then releases a late result. This
proves a configured boundary, not the default timeout or a full Environment
lifetime. The ordinary `wait` modes use ACP-supplied MCP server configuration.

`long-wait` configures `tool_timeout_sec = 660` in the same temporary native
configuration. After actual tool entry, it requires the original prompt to remain
pending for at least 600 seconds, then consume an unpredictable result with exactly
one target-tool call. This mode has a 720-second prompt budget to allow tool discovery
and final response; other modes retain their 90-second prompt budget. The acceptance
target is ten minutes, not a measurement of a provider's default timeout or proof of
the full Environment lifetime. It does not require crossing Grok's 6000-second default.
No daily user configuration is changed.
