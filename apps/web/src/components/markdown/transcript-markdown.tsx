/**
 * `TranscriptMarkdown` — a GFM renderer for UNTRUSTED agent/operator turn text in
 * the session transcript (render-transcript-markdown). The deliberately-separate
 * sibling of the TRUSTED `markdown.tsx` (forge-token help): an agent's turn text is
 * untrusted model output, so this renderer hardens against it rather than sharing a
 * `trusted` flag (which would muddy the security boundary and risk an unsafe default).
 *
 * Hardening = react-markdown's safe-by-default posture, NO plugins beyond remark-gfm:
 *   - NO `rehype-raw` → embedded raw HTML (e.g. `<script>`) is escaped to inert text,
 *     never parsed into live DOM. This default IS the guardrail.
 *   - default `urlTransform` retained (NOT overridden) → `javascript:` / `data:` /
 *     `vbscript:` link URLs are stripped.
 *   - `disallowedElements={['img']}` → an agent-supplied `![](url)` never loads a
 *     remote / tracking image.
 *   - NO heading slug/anchor `id`s (headings render as plain styled text) — transcript
 *     has no anchor-nav need and untrusted ids are meaningless / collision-prone.
 *
 * Styling is compact (inherits the row wrapper's font-size/color; marginless blocks)
 * so it sits inside the timeline row — NOT the trusted component's prose spacing. GFM
 * tables render inside an `overflow-x:auto` wrapper so a wide table never breaks the
 * narrow timeline layout. Pure render, SSR-safe (no fetch / window / clock / random).
 */
import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // Marginless paragraphs — the row wrapper owns font-size/leading/color; we only
  // add tight inter-block spacing so multi-paragraph text reads as stacked lines.
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="opacity-70">{children}</del>,
  ul: ({ children }) => (
    <ul className="my-1 grid list-disc gap-0.5 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 grid list-decimal gap-0.5 pl-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all font-medium text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2.5 text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  // Headings: plain styled text, NO id (no slug/anchor machinery for untrusted text).
  h1: ({ children }) => <div className="mt-2 mb-1 font-semibold first:mt-0">{children}</div>,
  h2: ({ children }) => <div className="mt-2 mb-1 font-semibold first:mt-0">{children}</div>,
  h3: ({ children }) => <div className="mt-2 mb-1 font-semibold first:mt-0">{children}</div>,
  h4: ({ children }) => <div className="mt-2 mb-1 font-semibold first:mt-0">{children}</div>,
  h5: ({ children }) => <div className="mt-2 mb-1 font-semibold first:mt-0">{children}</div>,
  h6: ({ children }) => <div className="mt-2 mb-1 font-semibold first:mt-0">{children}</div>,
  hr: () => <hr className="my-2 border-border" />,
  // Fenced code (` ```… `, carries a `language-*` className, wrapped in <pre>) vs
  // inline `code` (no className).
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.92em] not-italic">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-md bg-terminal-bg px-3 py-2.5 font-mono text-xs not-italic leading-normal text-terminal-fg first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  // GFM table inside an overflow-x:auto wrapper so a wide table never breaks the
  // narrow timeline column.
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-[0.92em] not-italic">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border bg-secondary/50 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

/**
 * Render an untrusted agent/operator turn-text markdown string. Inherits the
 * surrounding row wrapper's font-size + color; only structural + hardening rules live
 * here. `disallowedElements={['img']}` + the absent `rehype-raw` are the two
 * load-bearing safety choices — do not add `rehype-raw` and do not drop the img block.
 */
export function TranscriptMarkdown({ source }: { source: string }) {
  return (
    <div className="min-w-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
