const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { run } = require("../.github/actions/lark-send/index.js");

function response(body) {
  return { json: async () => body };
}

function cardFacts(card) {
  return card.body.elements
    .filter(({ element_id: elementId }) => elementId?.startsWith("environment_facts_"))
    .flatMap(({ columns }) => columns)
    .map(({ elements }) => ({
      label: elements[0].text.content,
      value: elements[1].text.content,
    }));
}

function cardActions(card) {
  return card.body.elements
    .find(({ element_id: elementId }) => elementId === "environment_actions")
    .columns.map(({ elements }) => elements[0]);
}

async function actionEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "lark-send-"));
  const sessionDirectory = join(directory, "private-runner-session", "t3code");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "t3-url"), "https://runner.trycloudflare.com\n");
  await writeFile(
    join(sessionDirectory, "pairing-url"),
    "https://runner.trycloudflare.com/pair#pairing-secret\n",
  );

  return {
    directory,
    environment: {
      HOME: directory,
      GITHUB_REPOSITORY: "Harness-X-Harness/runner",
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      LARK_CHAT_NAME: "Runner environments",
    },
  };
}

test("sends one ready connection card to the exact configured chat", async () => {
  const context = await actionEnvironment();
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return response({ code: 0, tenant_access_token: "tenant-token" });
    }
    if (requests.length === 2) {
      return response({
        code: 0,
        data: {
          has_more: true,
          page_token: "next page",
          items: [{ chat_id: "oc_other", name: "Other" }],
        },
      });
    }
    if (requests.length === 3) {
      return response({
        code: 0,
        data: {
          has_more: false,
          items: [{ chat_id: "oc_runner", name: "Runner environments" }],
        },
      });
    }
    return response({ code: 0, data: { message_id: "om_environment" } });
  };

  await run(context.environment, fetch);

  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(({ options }) => options.method), ["POST", undefined, undefined, "POST"]);
  assert.equal(requests[1].url, "https://open.larksuite.com/open-apis/im/v1/chats?page_size=100");
  assert.equal(
    requests[2].url,
    "https://open.larksuite.com/open-apis/im/v1/chats?page_size=100&page_token=next+page",
  );
  assert.equal(
    requests[3].url,
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
  );
  assert.equal(requests[3].options.headers.Authorization, "Bearer tenant-token");

  const sent = JSON.parse(requests[3].options.body);
  assert.equal(sent.receive_id, "oc_runner");
  assert.equal(sent.msg_type, "interactive");
  const card = JSON.parse(sent.content);
  assert.equal(card.config.enable_forward, false);
  assert.equal(card.config.summary.content, "Private development environment: Ready");
  assert.equal(card.header.template, "green");
  assert.equal(card.header.title.content, "Private development environment");
  assert.equal(card.header.subtitle.content, "Temporary workspace ready");
  assert.deepEqual(card.header.text_tag_list, [
    { tag: "text_tag", text: { tag: "plain_text", content: "READY" }, color: "green" },
  ]);
  assert.deepEqual(cardFacts(card), [
    { label: "Environment", value: "Ephemeral" },
    { label: "Run", value: "#123456" },
    { label: "SSH host", value: "gha-123456-2" },
    { label: "Attempt", value: "2" },
  ]);

  const actions = cardActions(card);
  assert.deepEqual(actions.map(({ elements }) => elements[0].text.content), [
    "Open T3",
    "Pair T3",
    "GitHub run",
  ]);
  assert.equal(actions[0].background_style, "green");
  assert.equal(actions[0].behaviors[0].default_url, "https://runner.trycloudflare.com");
  assert.equal(
    actions[1].behaviors[0].default_url,
    "https://runner.trycloudflare.com/pair#pairing-secret",
  );
  assert.equal(
    new URL(actions[1].behaviors[0].default_url).origin,
    new URL(actions[0].behaviors[0].default_url).origin,
  );
  assert.equal(
    actions[2].behaviors[0].default_url,
    "https://github.com/Harness-X-Harness/runner/actions/runs/123456",
  );
  assert.match(card.body.elements.at(-1).text.content, /credential/);

  await rm(context.directory, { recursive: true });
});
