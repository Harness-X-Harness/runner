const { run } = require("./index.js");

async function cleanup(environment = process.env, fetchImpl = fetch) {
  if (!environment.STATE_message_id) {
    return;
  }
  await run(
    {
      ...environment,
      INPUT_STATUS: "offline",
      LARK_MESSAGE_ID: environment.STATE_message_id,
    },
    fetchImpl,
  );
}

module.exports = { cleanup };

if (require.main === module) {
  cleanup();
}
