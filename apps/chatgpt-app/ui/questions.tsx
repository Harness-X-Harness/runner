import { useState } from "react";
import { answerContent, questionFields, type Question } from "./view.ts";

export function QuestionForm({ question, disabled, answer }: { question: Question; disabled: boolean;
  answer: (question: Question, response: { action: "accept"; content: Record<string, unknown> } | { action: "decline" }) => void }) {
  const [error, setError] = useState("");
  const fields = questionFields(question);
  if (!fields) return <p>{question.message} — Use “Answer in ChatGPT” for this input format.</p>;
  return <form onSubmit={event => {
    event.preventDefault(); setError("");
    try { answer(question, { action: "accept", content: answerContent(question, new FormData(event.currentTarget)) }); }
    catch { setError("Check your answer against the requested fields."); }
  }}>
    <fieldset disabled={disabled}><legend>{question.message}</legend>
      {fields.map(field => <label key={field.name}>{field.title ?? field.name}{field.required ? " *" : ""}
        {field.enum ? <select name={field.name} required={field.required} defaultValue=""><option value="" disabled={field.required}>Choose…</option>
          {field.enum.map((value, i) => <option key={i} value={i}>{String(value)}</option>)}</select>
          : field.type === "array" ? <select multiple name={field.name} required={field.required}>{field.items!.enum.map(value => <option key={value}>{value}</option>)}</select>
          : <input name={field.name} type={field.type === "boolean" ? "checkbox" : field.type === "string" ? "text" : "number"}
            required={field.type !== "boolean" && field.required} minLength={field.minLength} maxLength={field.maxLength}
            min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} />}
        {field.description && <small>{field.description}</small>}
      </label>)}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button type="submit">Send answer</button><button type="button" onClick={() => answer(question, { action: "decline" })}>Decline question</button></div>
    </fieldset>
  </form>;
}
