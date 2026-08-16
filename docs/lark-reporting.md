# LarkSend connection card

The private development-environment workflow calls the dependency-free Node 24
LarkSend Action once, after T3, Quick Tunnel, and Tailscale are ready. The
Action sends one non-forwardable application-bot card and ends.

## Required configuration

Enable the bot capability for a Lark custom app, add the bot to the destination
group, and grant these permissions:

- `im:chat:readonly` to list chats visible to the bot.
- `im:message` to send the bot's message card.

Configure these repository secrets:

| Secret | Value |
| --- | --- |
| `LARK_APP_ID` | Custom app ID |
| `LARK_APP_SECRET` | Custom app secret |
| `LARK_CHAT_NAME` | Exact name of the destination group |

The action resolves `LARK_CHAT_NAME` by exact match. The bot must already be a
member of that group. Local credentials may be kept in `.lark.env`; that file is
ignored by Git and must never be committed.

## One-shot delivery

LarkSend performs one tenant-token request, resolves the destination chat by
exact name, and creates one interactive card. It stores no `message_id`, makes
no PATCH request, and has no post hook, heartbeat, external store, or cleanup
workflow.

The ready card includes both the temporary T3 origin and the native pairing URL
that T3 issues for that origin after the Quick Tunnel becomes ready. Anyone who
can read the destination chat can use that pairing access, so the card disables
forwarding and the group membership is part of the credential trust boundary.
Neither value is written to Actions logs or step summaries. The card is not a
status monitor; GitHub Actions is authoritative after delivery.

The payload uses Lark card JSON 2.0 throughout. Its links are JSON 2.0
interactive containers and its footnote is notation text; the legacy `action`
and `note` elements are not valid in this schema.

The visual hierarchy is deliberately compact: the header marks the environment
ready, run facts use two-column grey tiles, and a divider separates facts from
the T3 and GitHub actions.
