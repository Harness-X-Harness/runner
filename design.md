# Interface design

AgentEnv is a compact workspace: read the response, continue the conversation,
and control the Environment. These rules apply to product cards and their local
preview. Development controls use the same visual language, with their own
grouping rules below.

## Preserve the pixel identity

Keep the green light/dark palette, crisp pixel geometry, square controls, stepped
icons and hard offset shadows. Carry this language through the workspace, not
only its logo. Improve structure inside this theme; a theme replacement needs
explicit user approval. Exact tokens belong in the stylesheet.

Use a quiet reading surface for long output, readable body type, and monospace
for controls and logs. Pixel identity does not require low-resolution text.
Respect host theme and accessibility variables without losing the geometry.

## Reply typography

Render all final agent replies as Markdown, including plain short replies. Keep
15px body text and restrained 15–18px headings. Use the theme's readable body
font, color and spacing; code uses the existing smaller monospace scale. Lists,
quotes and tables belong to the same reading surface, not a new theme.

Keep long prose wrapping. Wide tables and fenced code scroll inside their own
keyboard-accessible regions without widening the card. Do not parse command
output or progress logs as Markdown. Ignore raw HTML and show image descriptions
without loading images. Only absolute HTTP(S) links can be opened through the
host's standard link capability; otherwise keep link text non-interactive.
An unchanged reply keeps its scroll position when the composer or snapshot clock
updates, or the user refreshes the same result.

## Three regions, one activity

1. **Control bar:** small AgentEnv identity, executor/model context, Environment
   indicator, and compact refresh/list/close controls. Use familiar pixel icons
   with accessible names and hover/focus hints. Close means ending the workspace,
   not hiding the card. Keep destructive controls visually distinct.
2. **Content:** the selected response, command output or question is the focus.
   Use its placement and pixel framing instead of a redundant visible “Result”
   heading. Explain failure or required input in words. A retained old result is
   not the active operation; identify and stop the active operation separately.
3. **Composer:** keep input and send together, with send integrated into the input
   area. Continuing the conversation is the normal path; omit a permanent
   “Explain result” shortcut. Question forms keep their own submit/decline actions.

An empty workspace should lead straight to input. Short replies produce short
cards; long replies can grow. Use one reading column. On narrow screens, wrap
the control bar into compact rows without changing action order or meaning.

## Hierarchy and density

- **Contrast:** output and the next useful action lead. Branding, metadata and
  utility controls support them. Equivalent executor choices have equal weight.
- **Proximity:** group related information before adjusting spacing. Use a small
  internal gap and a larger group gap; avoid a title and new row for every field.
- **Alignment:** share content edges and align controls on a consistent grid.
- **Repetition:** give equal roles equal geometry, spacing and feedback. A new
  visual variant must carry a different meaning.

Show only metadata useful to the current decision. Keep usage limits and snapshot
freshness compact and secondary. Technical IDs remain in the tool/model context;
they do not need a permanent field list or a generic “Details” disclosure.

## State and interaction

Environment availability and operation outcome are different. The control-bar
indicator represents the Environment, not task success. Ready may use a filled
short bar without persistent text; also provide its name to assistive technology
and in a focus/hover hint. Other states use distinct shapes and concise text when
needed. Color alone must not be the only way to identify a state.

Keep existing tool, selection and submission-identity contracts. Busy feedback
and disabled controls must remain clear. Preserve explicit confirmation for
stop, close and decline, with initial focus on the safe choice. Closed cards may
retain results but show no future usage countdown or work-entry controls.

The card shows a snapshot. Refresh is explicit, and viewing progress does not
extend usage limits. Layout changes do not add background queries or claim live
state. Keep visible keyboard focus, usable target sizes and readable contrast.

## Local acceptance

The preview's controls support the card, which remains the visual focus. Group
scene/executor, theme/width and response simulation in one compact control band.
Place reset, trace and scene-link utilities in its header. Keep trace output
available on demand and use one short scene hint instead of repeated explanation.

Use the [local preview](docs/development/frontend-preview.md), which renders the
production card with fixtures. Check empty, ready, working, question, completed,
failure, historical-result and closed scenes in light/dark and desktop/narrow
layouts. Verify compact short replies, mixed Markdown and raw logs, readable long
output, icon hints, keyboard
focus, confirmations and the actual tool arguments. Check that failed/cancelled
operations cannot be mistaken for closed Environments or successful results.

Run rendering, browser and accessibility checks, then inspect screenshots for
pixel identity, hierarchy and grouping. Passing tests is not visual approval.
Use real-host acceptance only for changed integration boundaries; ordinary layout
and copy work needs neither a new runner nor repeated user live tests.
