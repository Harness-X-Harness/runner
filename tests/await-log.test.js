const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { appendFile, mkdtemp, readFile, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const { waitForMatch } = require("../.github/actions/await-log/index.js");
const execFileAsync = promisify(execFile);

test("waits for and returns the first capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "await-log-"));
  const log = join(directory, "service.log");
  await writeFile(log, "starting\n");

  const value = waitForMatch(log, /^URL: (https:\/\/\S+)$/m);
  await appendFile(log, "URL: https://example.test\n");

  assert.equal(await value, "https://example.test");
  await rm(directory, { recursive: true });
});

test("masks and writes the resolved value with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "await-log-action-"));
  const log = join(directory, "service.log");
  const destination = join(directory, "value");
  await writeFile(log, "URL: https://example.test\n");

  const { stdout } = await execFileAsync(
    process.execPath,
    [join(__dirname, "../.github/actions/await-log/index.js")],
    {
      env: {
        ...process.env,
        INPUT_PATH: log,
        INPUT_PATTERN: "^URL: (https://[^\\r\\n]+)$",
        INPUT_DESTINATION: destination,
      },
    },
  );

  assert.equal(stdout, "::add-mask::https://example.test\n");
  assert.equal(await readFile(destination, "utf8"), "https://example.test\n");
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  await rm(directory, { recursive: true });
});
