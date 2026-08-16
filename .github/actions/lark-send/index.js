const { readFile } = require("node:fs/promises");
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
    element_id: "environment_actions",
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

function card(environment, t3Url, pairingUrl) {
  const runUrl = `${environment.GITHUB_SERVER_URL}/${environment.GITHUB_REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}`;
  const facts = [
    { label: "Environment", value: "Ephemeral" },
    { label: "Run", value: `#${environment.GITHUB_RUN_ID}` },
    {
      label: "SSH host",
      value: `gha-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`,
    },
    { label: "Attempt", value: environment.GITHUB_RUN_ATTEMPT },
  ];

  return {
    schema: "2.0",
    config: {
      enable_forward: false,
      summary: { content: "Private development environment: Ready" },
    },
    header: {
      title: { tag: "plain_text", content: "Private development environment" },
      subtitle: { tag: "plain_text", content: "Temporary workspace ready" },
      template: "green",
      text_tag_list: [
        {
          tag: "text_tag",
          text: { tag: "plain_text", content: "READY" },
          color: "green",
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
          text: {
            tag: "plain_text",
            content: "Your temporary development machine is ready.",
          },
        },
        factRow("environment_facts_primary", facts.slice(0, 2)),
        factRow("environment_facts_secondary", facts.slice(2)),
        { tag: "hr", margin: "6px 0px 6px 0px" },
        actionRow([
          { label: "Open T3", url: t3Url, primary: true },
          { label: "Pair T3", url: pairingUrl, primary: false },
          { label: "GitHub run", url: runUrl, primary: false },
        ]),
        {
          tag: "div",
          text: {
            tag: "plain_text",
            content: "Pairing access is shared with this Lark chat. Treat it as a credential.",
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
  const sessionDirectory = join(environment.HOME, "private-runner-session", "t3code");
  const [t3Url, pairingUrl] = await Promise.all([
    readFile(join(sessionDirectory, "t3-url"), "utf8"),
    readFile(join(sessionDirectory, "pairing-url"), "utf8"),
  ]);

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

  await fetchImpl(`${API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      receive_id: chat.chat_id,
      msg_type: "interactive",
      content: JSON.stringify(card(environment, t3Url.trim(), pairingUrl.trim())),
    }),
  });
}

module.exports = { run };

if (require.main === module) {
  run();
}
