import { useState } from "react";
import { Root as Label } from "@radix-ui/react-label";
import { Button } from "./components/button.tsx";
import { ConfirmDialog } from "./components/confirm-dialog.tsx";
import { answerContent, questionFields, type Question } from "./view.ts";

export function QuestionForm({ question, disabled, answer }: { question: Question; disabled: boolean;
  answer: (question: Question, response: { action: "accept"; content: Record<string, unknown> } | { action: "decline" }) => void }) {
  const [error, setError] = useState("");
  const [decline, setDecline] = useState(false);
  const fields = questionFields(question);
  if (!fields) return <p className="px-panel">{question.message}</p>;
  return <form className="px-panel" onSubmit={event => {
    event.preventDefault(); setError("");
    try { answer(question, { action: "accept", content: answerContent(question, new FormData(event.currentTarget)) }); }
    catch { setError("请检查此项。"); }
  }}>
    <fieldset disabled={disabled}>
      <legend>{question.message}</legend>
      {fields.map(field => {
        const id = `${question.id}-${field.name}`;
        return <div className="px-field" key={field.name}>
          <Label className="px-label" htmlFor={id}>{field.title ?? field.name}{field.required ? " *" : ""}</Label>
          {field.enum ? <select id={id} name={field.name} required={field.required} defaultValue="">
            <option value="" disabled={field.required}>请选择</option>
            {field.enum.map((value, index) => <option key={index} value={index}>{String(value)}</option>)}
          </select>
            : field.type === "array" ? <select id={id} multiple name={field.name} required={field.required}>{field.items!.enum.map(value => <option key={value}>{value}</option>)}</select>
            : <input id={id} name={field.name} type={field.type === "boolean" ? "checkbox" : field.type === "string" ? "text" : "number"}
              required={field.type !== "boolean" && field.required} minLength={field.minLength} maxLength={field.maxLength}
              min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} />}
          {field.description && <small>{field.description}</small>}
        </div>;
      })}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <Button type="submit" variant="primary">提交</Button>
        <Button type="button" variant="quiet" onClick={() => setDecline(true)}>拒绝</Button>
      </div>
    </fieldset>
    <ConfirmDialog open={decline} title="拒绝此问题？" description="拒绝后无法再次回答。"
      confirmLabel="拒绝" cancelLabel="取消" danger onOpenChange={setDecline}
      onConfirm={() => answer(question, { action: "decline" })} />
  </form>;
}
