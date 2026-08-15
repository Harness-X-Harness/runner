const { watch } = require("node:fs");
const { chmod, readFile, writeFile } = require("node:fs/promises");
const { on } = require("node:events");

async function waitForMatch(path, pattern) {
  const watcher = watch(path);
  const changes = on(watcher, "change");

  try {
    for (;;) {
      const match = (await readFile(path, "utf8")).match(pattern);
      if (match) return match[1] ?? match[0];
      await changes.next();
    }
  } finally {
    await changes.return();
    watcher.close();
  }
}

async function main() {
  const value = await waitForMatch(
    process.env.INPUT_PATH,
    new RegExp(process.env.INPUT_PATTERN, "m"),
  );

  const masked = value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  process.stdout.write(`::add-mask::${masked}\n`);
  await writeFile(process.env.INPUT_DESTINATION, `${value}\n`, { mode: 0o600 });
  await chmod(process.env.INPUT_DESTINATION, 0o600);
}

if (require.main === module) void main();

module.exports = { waitForMatch };
