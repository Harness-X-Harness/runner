import * as acp from "@agentclientprotocol/sdk";
import { z } from "zod";

// xai-org/grok-build: ask_user_question/{mod,types}.rs; current array-valued answers.
const requestSchema = z.object({ sessionId: z.string(), toolCallId: z.string(), mode: z.enum(["default", "plan"]),
  questions: z.array(z.object({ question: z.string().min(1), multiSelect: z.boolean().nullish(),
    options: z.array(z.object({ label: z.string().min(1), description: z.string(), preview: z.string().nullish() })),
  })).min(1),
});

export async function answerGrokQuestion(value: unknown,
  elicit: (request: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>) {
  const request = requestSchema.parse(value);
  if (new Set(request.questions.map(question => question.question)).size !== request.questions.length) throw new Error("DUPLICATE_QUESTION");
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  request.questions.forEach((question, index) => {
    const options = [...new Set([...question.options.map(option => option.label), "Other"])];
    const description = question.options.map(option => `${option.label}: ${option.description}${option.preview ? `\n${option.preview}` : ""}`).join("\n");
    properties[`q${index}`] = question.multiSelect
      ? { type: "array", title: question.question, description, items: { type: "string", enum: options }, minItems: 1 }
      : { type: "string", title: question.question, description, enum: options };
    properties[`q${index}_notes`] = { type: "string", title: `${question.question} — notes`, description: "Free text for Other, or notes about the selected answer." };
  });
  const answer = await elicit({ sessionId: request.sessionId, mode: "form", message: "Grok has questions.",
    requestedSchema: { type: "object", properties } });
  if (!acp.CreateElicitationResponse.isAccept(answer)) return { outcome: "cancelled" };
  const content = z.record(z.string(), z.unknown()).parse(answer.content);
  const answers: Record<string, string[]> = Object.create(null);
  const annotations: Record<string, { notes?: string; preview?: string }> = Object.create(null);
  request.questions.forEach((question, index) => {
    const raw = content[`q${index}`];
    const notes = z.string().optional().parse(content[`q${index}_notes`]);
    if (raw === undefined && !notes) return;
    const selected = raw === undefined ? ["Other"] : question.multiSelect ? z.array(z.string()).parse(raw) : [z.string().parse(raw)];
    if (selected.some(label => label !== "Other" && !question.options.some(option => option.label === label))) throw new Error("INVALID_QUESTION_ANSWER");
    answers[question.question] = selected;
    const preview = !question.multiSelect ? question.options.find(option => option.label === selected[0])?.preview : undefined;
    if (notes || preview) annotations[question.question] = { ...(notes ? { notes } : {}), ...(preview ? { preview } : {}) };
  });
  return { outcome: "accepted", answers, ...(Object.keys(annotations).length ? { annotations } : {}) };
}
