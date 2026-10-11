import test from "node:test";
import assert from "node:assert/strict";
import { agentInput } from "../apps/chatgpt-app/src/environment-operation-service.ts";
import { environmentTools } from "../apps/chatgpt-app/src/environment-tools.ts";
import { z } from "../apps/chatgpt-app/node_modules/zod/index.js";

test("agent prompt schema preserves nonblank text across search and whole-string validators", () => {
  const tool = environmentTools().find(tool => tool.name === "agent")!;
  const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  const { properties: { prompt: { pattern } } } = z.object({ properties: z.object({
    prompt: z.object({ pattern: z.string() }),
  }) }).parse(tool.inputSchema);
  const expression = new RegExp(pattern);
  const environmentId = `env_${"a".repeat(32)}`;

  // JSON Schema searches for a match; some consumers require the entire value.
  // Check match coverage without relying on JavaScript's permissive final `$`.
  for (const prompt of ["a", "hi", "你好", "hello world", "first\nsecond", "\n hi \r\n", "😀"]) {
    const input = { environmentId, prompt };
    assert.equal(agentInput.parse(input).prompt, prompt);
    assert.equal((schema.parse(input) as { prompt: string }).prompt, prompt);
    const match = expression.exec(prompt);
    assert.ok(match, JSON.stringify(prompt));
    assert.equal(match.index, 0);
    assert.equal(match[0], prompt);
  }

  for (const prompt of ["", " ", "\t\r\n", "\u00a0", "\u3000", " \n\t\u00a0\u3000"]) {
    const input = { environmentId, prompt };
    assert.equal(agentInput.safeParse(input).success, false, JSON.stringify(prompt));
    assert.equal(schema.safeParse(input).success, false, JSON.stringify(prompt));
    assert.equal(expression.test(prompt), false, JSON.stringify(prompt));
  }
});
