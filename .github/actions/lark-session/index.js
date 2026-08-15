const { appendFile, readFile } = require("node:fs/promises");
const { join } = require("node:path");

const API = "https://open.larksuite.com/open-apis";

function factTile({ label, value }) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    background_style: "grey",
    padding: "10px 8px",
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: label,
          text_size: "notation",
          text_color: "grey",
          text_align: "center",
        },
      },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: value,
          text_size: "heading",
          text_align: "center",
        },
      },
    ],
  };
}

function factRow(elementId, facts) {
  return {
    tag: "column_set",
    element_id: elementId,
    flex_mode: "none",
    horizontal_spacing: "6px",
    margin: "4px 0px 4px 0px",
    columns: facts.map(factTile),
  };
}

function actionRow(actions) {
  return {
    tag: "column_set",
    element_id: "session_actions",
    flex_mode: "none",
    horizontal_spacing: "6px",
    columns: actions.map(({ label, url, primary }) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [
        {
          tag: "interactive_container",
          width: "fill",
          background_style: primary ? "green" : "default",
          has_border: true,
          border_color: primary ? "green" : "grey",
          corner_radius: "6px",
          padding: "8px 12px",
          behaviors: [{ type: "open_url", default_url: url }],
          elements: [
            {
              tag: "div",
              text: {
                tag: "plain_text",
                content: label,
                text_align: "center",
                text_color: primary ? "white" : "default",
              },
            },
          ],
        },
      ],
    })),
  };
}

function card(status, environment) {
  const runUrl = `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`;
  const githubAction = { label: "GitHub run", url: runUrl, primary: false };
  const presentation = {
    Starting: {
      template: "blue",
      status: { color: "blue", label: "STARTING" },
      subtitle: "One-time development environment",
      summary: "Preparing your temporary workspace…",
      fields: [
        { label: "Target", value: environment.SESSION_TARGET_ID },
        { label: "Run", value: `#${environment.GITHUB_RUN_ID}` },
        { label: "Attempt", value: environment.GITHUB_RUN_ATTEMPT },
        { label: "Access", value: "Preparing" },
      ],
      actions: [githubAction],
      note: "Ephemeral GitHub-hosted development session",
    },
    Online: {
      template: "green",
      status: { color: "green", label: "ONLINE" },
      subtitle: "Development environment ready",
      summary: "Your temporary development workspace is ready.",
      fields: [
        { label: "Target", value: environment.SESSION_TARGET_ID },
        { label: "Run", value: `#${environment.GITHUB_RUN_ID}` },
        {
          label: "SSH host",
          value: environment.SESSION_SSH_ONLINE === "true"
            ? `gha-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`
            : "Not available",
        },
        { label: "Attempt", value: environment.GITHUB_RUN_ATTEMPT },
      ],
      actions: [
        { label: "Open T3", url: environment.SESSION_T3_URL, primary: true },
        { label: "Pair T3", url: environment.SESSION_PAIRING_URL, primary: false },
        githubAction,
      ],
      note: "Pairing access is shared with this Lark chat. Treat it as a credential.",
    },
    Offline: {
      template: "grey",
      status: { color: "neutral", label: "OFFLINE" },
      subtitle: "Session ended · Temporary access removed",
      summary: "This development session has ended.",
      fields: [
        { label: "Target", value: environment.SESSION_TARGET_ID },
        { label: "Run", value: `#${environment.GITHUB_RUN_ID}` },
        { label: "Attempt", value: environment.GITHUB_RUN_ATTEMPT },
        { label: "Access", value: "Removed" },
      ],
      actions: [githubAction],
      note: "Temporary T3 access has been removed.",
    },
  }[status];

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      enable_forward: false,
      summary: {
        content: `Private T3 session: ${status}`,
      },
    },
    header: {
      title: { tag: "plain_text", content: "Private T3 session" },
      subtitle: { tag: "plain_text", content: presentation.subtitle },
      template: presentation.template,
      text_tag_list: [
        {
          tag: "text_tag",
          text: { tag: "plain_text", content: presentation.status.label },
          color: presentation.status.color,
        },
      ],
    },
    body: {
      direction: "vertical",
      padding: "8px 8px 8px 8px",
      vertical_spacing: "6px",
      elements: [
        {
          tag: "div",
          text: { tag: "plain_text", content: presentation.summary },
        },
        factRow("session_facts_primary", presentation.fields.slice(0, 2)),
        factRow("session_facts_secondary", presentation.fields.slice(2)),
        { tag: "hr", margin: "6px 0px 6px 0px" },
        actionRow(presentation.actions),
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: presentation.note,
            text_size: "notation",
            text_color: "grey",
          },
        },
      ],
    },
  };
}

async function token(environment, fetchImpl) {
  const response = await fetchImpl(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: environment.LARK_APP_ID,
      app_secret: environment.LARK_APP_SECRET,
    }),
  });
  return (await response.json()).tenant_access_token;
}

async function run(environment = process.env, fetchImpl = fetch) {
  const accessToken = await token(environment, fetchImpl);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json; charset=utf-8",
  };
  if (environment.INPUT_STATUS !== "starting") {
    const status = environment.INPUT_STATUS === "online" ? "Online" : "Offline";
    let cardEnvironment = environment;
    if (status === "Online") {
      const sessionDirectory = join(environment.HOME, "private-runner-session", "t3code");
      const [t3Url, pairingUrl] = await Promise.all([
        environment.SESSION_T3_URL ?? readFile(join(sessionDirectory, "t3-url"), "utf8"),
        environment.SESSION_PAIRING_URL ?? readFile(join(sessionDirectory, "pairing-url"), "utf8"),
      ]);
      cardEnvironment = {
        ...environment,
        SESSION_T3_URL: t3Url.trim(),
        SESSION_PAIRING_URL: pairingUrl.trim(),
      };
    }
    await fetchImpl(`${API}/im/v1/messages/${environment.LARK_MESSAGE_ID}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ content: JSON.stringify(card(status, cardEnvironment)) }),
    });
    return;
  }

  let chat;
  let pageToken;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (pageToken) {
      query.set("page_token", pageToken);
    }
    const chatsResponse = await fetchImpl(`${API}/im/v1/chats?${query}`, { headers });
    const { data } = await chatsResponse.json();
    chat = data.items.find(({ name }) => name === environment.LARK_CHAT_NAME);
    pageToken = data.has_more ? data.page_token : undefined;
  } while (!chat && pageToken);
  const messageResponse = await fetchImpl(
    `${API}/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        receive_id: chat.chat_id,
        msg_type: "interactive",
        content: JSON.stringify(card("Starting", environment)),
      }),
    },
  );
  const messageId = (await messageResponse.json()).data.message_id;
  await appendFile(environment.GITHUB_ENV, `LARK_MESSAGE_ID=${messageId}\n`);
  await appendFile(environment.GITHUB_STATE, `message_id=${messageId}\n`);
}

module.exports = { run };

if (require.main === module) {
  run();
}
