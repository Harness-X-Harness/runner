# Lark session card

Each private runner session owns one application-bot card. The workflow creates
the card as `Starting`, updates the same message to `Online` when T3 is ready,
and uses the JavaScript action's native `post` hook to mark it `Offline` when
the job finishes or is cancelled.

## Required configuration

Enable the bot capability for a Lark custom app, add the bot to the destination
group, and grant these permissions:

- `im:chat:readonly` to list chats visible to the bot.
- `im:message` to send and update the bot's message card.

Configure these repository or selected-Environment secrets:

| Secret | Value |
| --- | --- |
| `LARK_APP_ID` | Custom app ID |
| `LARK_APP_SECRET` | Custom app secret |
| `LARK_CHAT_NAME` | Exact name of the destination group |

The action resolves `LARK_CHAT_NAME` by exact match. The bot must already be a
member of that group. Local credentials may be kept in `.lark.env`; that file is
ignored by Git and must never be committed.

## Lifecycle

The first action invocation sends the card and saves its `message_id` in GitHub
Actions environment and action state files. The Online invocation updates that
message. At job teardown, only the first invocation has cleanup state, so its
`post` hook updates the same message to Offline. No artifact, external key-value
store, heartbeat, or cleanup workflow is involved.

The Online card includes both the temporary T3 origin and the native pairing
URL. Anyone who can read the destination chat can use that pairing access, so
the card disables forwarding and the group membership is part of the credential
trust boundary. The Offline card removes both links. Neither value is written to
Actions logs or step summaries.

The payload uses Lark card JSON 2.0 throughout. Its links are JSON 2.0
interactive containers and its footnote is notation text; the legacy `action`
and `note` elements are not valid in this schema.

The visual hierarchy is deliberately compact: the header carries the lifecycle
status, session facts use two-column grey tiles, and a divider separates facts
from connection actions. All three lifecycle states share that structure so an
in-place update does not move the important information unexpectedly.

This cleanup is best-effort. It covers normal completion, step failure, and
cooperative cancellation while the runner can still execute action teardown. A
runner that disappears or loses network cannot update the card; detecting that
case would require an external watchdog.
