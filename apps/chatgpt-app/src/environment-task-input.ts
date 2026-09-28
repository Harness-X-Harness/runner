import { z } from "zod";

export const inputRequest = z.object({ method: z.literal("elicitation/create"), params: z.object({
  mode: z.literal("form"), message: z.string(), requestedSchema: z.record(z.string(), z.unknown()),
}).strict() }).strict();
const response = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), content: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ action: z.literal("decline") }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
]);
export type InputRecord = { request: z.infer<typeof inputRequest>; response?: z.infer<typeof response> };
export function inputAnswer(request: InputRecord["request"], value: unknown): NonNullable<InputRecord["response"]> {
  const answer = response.parse(value);
  if (answer.action !== "accept") return answer;
  const schema = z.fromJSONSchema(request.params.requestedSchema as Parameters<typeof z.fromJSONSchema>[0]);
  return { action: "accept", content: z.record(z.string(), z.unknown()).parse(schema.parse(answer.content)) };
}
