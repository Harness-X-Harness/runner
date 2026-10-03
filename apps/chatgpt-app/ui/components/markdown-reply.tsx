import { memo } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

// Keep an unchanged reply's scroll regions when the composer or snapshot clock updates.
export const MarkdownReply = memo(function MarkdownReply({ text, onOpenLink }: { text: string; onOpenLink?: (url: string) => void }) {
  return <div className="result">
    <Markdown remarkPlugins={[remarkGfm]} skipHtml
      urlTransform={url => /^https?:\/\//i.test(url) ? defaultUrlTransform(url) : undefined}
      components={{
        img: ({ alt }) => <span className="muted">{alt}</span>,
        input: ({ checked }) => <span className="task-check" data-checked={Boolean(checked)} role="img" aria-label={checked ? "已完成" : "未完成"}>
          {checked && <svg viewBox="0 0 12 12" aria-hidden="true" shapeRendering="crispEdges"><path fill="currentColor" d="M1 5h2v2h2V5h2V3h2V1h2v4H9v2H7v2H5v2H3V9H1z" /></svg>}
        </span>,
        a: ({ href, title, children }) => href && onOpenLink
          ? <a href={href} title={title} onClick={event => { event.preventDefault(); onOpenLink(href); }}>{children}</a>
          : <span title={href ?? title}>{children}</span>,
        pre: ({ children }) => <pre tabIndex={0} role="region" aria-label="代码块">{children}</pre>,
        table: ({ children }) => <div className="markdown-table" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>,
      }}>{text}</Markdown>
  </div>;
});
