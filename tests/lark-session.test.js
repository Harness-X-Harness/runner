const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { cleanup } = require("../.github/actions/lark-session/cleanup.js");
const { run } = require("../.github/actions/lark-session/index.js");

function response(body) {
  return { json: async () => body };
}

function cardFacts(card) {
  return card.body.elements
    .filter(({ element_id: elementId }) => elementId?.startsWith("session_facts_"))
    .flatMap(({ columns }) => columns)
    .map(({ elements }) => ({
      label: elements[0].text.content,
      value: elements[1].text.content,
    }));
}

function cardActions(card) {
  return card.body.elements
    .find(({ element_id: elementId }) => elementId === "session_actions")
    .columns.map(({ elements }) => elements[0]);
}

async function actionEnvironment(status) {
  const directory = await mkdtemp(join(tmpdir(), "lark-session-"));
  const environmentFile = join(directory, "github-env");
  const stateFile = join(directory, "github-state");
  await writeFile(environmentFile, "");
  await writeFile(stateFile, "");

  return {
    directory,
    environment: {
      GITHUB_ENV: environmentFile,
      GITHUB_STATE: stateFile,
      HOME: directory,
      GITHUB_REPOSITORY: "Harness-X-Harness/runner",
      GITHUB_RUN_ID: "123456",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_SERVER_URL: "https://github.com",
      INPUT_STATUS: status,
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      LARK_CHAT_NAME: "Runner sessions",
      SESSION_SSH_ONLINE: "false",
      SESSION_TARGET_ID: "repo-01",
    },
  };
}

test("starting creates one card in the exact chat and saves its message id", async () => {
  const context = await actionEnvironment("starting");
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
          items: [{ chat_id: "oc_runner", name: "Runner sessions" }],
        },
      });
    }
    return response({ code: 0, data: { message_id: "om_session" } });
  };

  await run(context.environment, fetch);

  assert.equal(requests[1].url, "https://open.larksuite.com/open-apis/im/v1/chats?page_size=100");
  assert.equal(
    requests[2].url,
    "https://open.larksuite.com/open-apis/im/v1/chats?page_size=100&page_token=next+page",
  );
  assert.equal(
    requests[3].url,
    "https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id",
  );
  const sent = JSON.parse(requests[3].options.body);
  assert.equal(sent.receive_id, "oc_runner");
  assert.equal(sent.msg_type, "interactive");
  const card = JSON.parse(sent.content);
  assert.equal(card.config.summary.content, "Private T3 session: Starting");
  assert.equal(card.header.template, "blue");
  assert.equal(card.header.title.content, "Private T3 session");
  assert.equal(card.header.subtitle.content, "One-time development environment");
  assert.deepEqual(card.header.text_tag_list, [
    { tag: "text_tag", text: { tag: "plain_text", content: "STARTING" }, color: "blue" },
  ]);
  assert.equal(card.body.direction, "vertical");
  assert.equal(card.body.padding, "8px 8px 8px 8px");
  assert.equal(card.body.vertical_spacing, "6px");
  assert.equal(card.body.elements[0].text.content, "Preparing your temporary workspace…");
  assert.deepEqual(
    cardFacts(card),
    [
      { label: "Target", value: "repo-01" },
      { label: "Run", value: "#123456" },
      { label: "Attempt", value: "2" },
      { label: "Access", value: "Preparing" },
    ],
  );
  assert.ok(card.body.elements.some(({ tag }) => tag === "hr"));
  assert.deepEqual(
    cardActions(card).map(({ elements }) => elements[0].text.content),
    ["GitHub run"],
  );
  assert.equal(card.body.elements.at(-1).tag, "div");
  assert.equal(card.body.elements.at(-1).text.text_size, "notation");
  assert.equal(await readFile(context.environment.GITHUB_ENV, "utf8"), "LARK_MESSAGE_ID=om_session\n");
  assert.equal(await readFile(context.environment.GITHUB_STATE, "utf8"), "message_id=om_session\n");
  await rm(context.directory, { recursive: true });
});

test("online updates the existing card without registering another cleanup", async () => {
  const context = await actionEnvironment("online");
  context.environment.LARK_MESSAGE_ID = "om_session";
  const sessionDirectory = join(context.directory, "private-runner-session", "t3code");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "t3-url"), "https://runner.trycloudflare.com\n");
  await writeFile(join(sessionDirectory, "pairing-url"), "https://app.t3.codes/pair#pairing-secret\n");
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return response(requests.length === 1
      ? { code: 0, tenant_access_token: "tenant-token" }
      : { code: 0 });
  };

  await run(context.environment, fetch);

  assert.equal(
    requests[1].url,
    "https://open.larksuite.com/open-apis/im/v1/messages/om_session",
  );
  assert.equal(requests[1].options.method, "PATCH");
  const updated = JSON.parse(requests[1].options.body);
  const card = JSON.parse(updated.content);
  assert.equal(card.config.enable_forward, false);
  assert.equal(card.config.summary.content, "Private T3 session: Online");
  assert.equal(card.header.template, "green");
  assert.equal(card.header.title.content, "Private T3 session");
  assert.equal(card.header.subtitle.content, "Development environment ready");
  assert.deepEqual(card.header.text_tag_list, [
    { tag: "text_tag", text: { tag: "plain_text", content: "ONLINE" }, color: "green" },
  ]);
  assert.deepEqual(
    cardFacts(card),
    [
      { label: "Target", value: "repo-01" },
      { label: "Run", value: "#123456" },
      { label: "SSH host", value: "Not available" },
      { label: "Attempt", value: "2" },
    ],
  );
  const actions = cardActions(card);
  assert.deepEqual(actions.map(({ elements }) => elements[0].text.content), [
    "Open T3",
    "Pair T3",
    "GitHub run",
  ]);
  assert.equal(actions[0].background_style, "green");
  assert.equal(actions[0].behaviors[0].default_url, "https://runner.trycloudflare.com");
  assert.equal(actions[1].behaviors[0].default_url, "https://app.t3.codes/pair#pairing-secret");
  assert.equal(await readFile(context.environment.GITHUB_STATE, "utf8"), "");
  await cleanup(context.environment, fetch);
  assert.equal(requests.length, 2);
  await rm(context.directory, { recursive: true });
});

test("post updates the owning card to Offline and omits temporary access", async () => {
  const context = await actionEnvironment("starting");
  context.environment.STATE_message_id = "om_session";
  context.environment.SESSION_T3_URL = "https://runner.trycloudflare.com";
  context.environment.SESSION_PAIRING_URL = "https://app.t3.codes/pair#pairing-secret";
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return response(requests.length === 1
      ? { code: 0, tenant_access_token: "tenant-token" }
      : { code: 0 });
  };

  await cleanup(context.environment, fetch);

  assert.equal(
    requests[1].url,
    "https://open.larksuite.com/open-apis/im/v1/messages/om_session",
  );
  const updated = JSON.parse(requests[1].options.body);
  const card = JSON.parse(updated.content);
  assert.equal(card.config.summary.content, "Private T3 session: Offline");
  assert.equal(card.header.template, "grey");
  assert.equal(card.header.title.content, "Private T3 session");
  assert.equal(card.header.subtitle.content, "Session ended · Temporary access removed");
  assert.deepEqual(card.header.text_tag_list, [
    { tag: "text_tag", text: { tag: "plain_text", content: "OFFLINE" }, color: "neutral" },
  ]);
  assert.deepEqual(
    cardFacts(card),
    [
      { label: "Target", value: "repo-01" },
      { label: "Run", value: "#123456" },
      { label: "Attempt", value: "2" },
      { label: "Access", value: "Removed" },
    ],
  );
  assert.deepEqual(
    cardActions(card).map(({ elements }) => elements[0].text.content),
    ["GitHub run"],
  );
  assert.doesNotMatch(JSON.stringify(card), /trycloudflare/);
  assert.doesNotMatch(JSON.stringify(card), /pairing-secret/);
  await rm(context.directory, { recursive: true });
});
