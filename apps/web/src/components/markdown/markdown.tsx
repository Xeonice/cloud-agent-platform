/**
 * `Markdown` — a deliberately minimal, SSR-safe markdown renderer for TRUSTED,
 * app-authored content (add-forge-token-help-docs).
 *
 * Renders a markdown string with `react-markdown` + `remark-gfm` and NO
 * `rehype-raw` / `rehype-sanitize`: react-markdown's default behavior escapes any
 * embedded raw HTML to inert text rather than parsing it into live DOM, and that
 * default-escaping IS the security guardrail (no `<script>` can execute). Adding
 * `rehype-raw` would be the only thing that re-enables raw HTML — so we never do.
 *
 * Styling is done through a `components={{...}}` map onto the console's existing
 * design tokens (NOT `@tailwindcss/typography`): a handful of elements need rules
 * and the tokens already exist. Headings get a slugified `id` so a `#<slug>` deep
 * link (e.g. `#github`) scrolls to the matching section.
 *
 * Pure render: no fetch, no `window` / clock / random — safe under SSR.
 */
import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Flatten a React node tree to its text content (for heading slugs). */
function textOf(node: React.ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

/** `GitHub` -> `github`, `GitLab` -> `gitlab` (matches the canonical forge kinds). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="m-0 mb-2 text-[22px] font-semibold text-ink">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2
      id={slugify(textOf(children))}
      className="mt-9 mb-3 scroll-mt-24 border-t border-border pt-7 text-[18px] font-semibold text-ink"
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      id={slugify(textOf(children))}
      className="mt-5 mb-2 scroll-mt-24 text-[14px] font-semibold text-ink"
    >
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="my-2.5 text-[13px] leading-[1.7] text-foreground">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2.5 grid list-disc gap-1.5 pl-5 text-[13px] leading-[1.7] text-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2.5 grid list-decimal gap-1.5 pl-5 text-[13px] leading-[1.7] text-foreground">
      {children}
    </ol>
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
    <blockquote className="my-3 border-l-2 border-border bg-secondary/40 py-1.5 pr-3 pl-3.5 text-[13px] leading-[1.7] text-muted-foreground [&_p]:text-muted-foreground">
      {children}
    </blockquote>
  ),
  // Fenced code (` ```bash `) arrives with a `language-*` className and is wrapped
  // in <pre>; inline `code` has no className. Differentiate on that.
  code: ({ className, children }) =>
    className ? (
      <code className="font-mono text-[12.5px] text-foreground">{children}</code>
    ) : (
      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-foreground">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-lg bg-[#0d1117] p-3.5 text-[12.5px] leading-[1.6] text-[#e6edf3] [&_code]:text-[#e6edf3]">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border bg-secondary/50 px-3 py-1.5 text-left font-semibold text-ink">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-1.5 text-foreground">
      {children}
    </td>
  ),
  hr: () => <hr className="my-6 border-border" />,
};

/** Render a trusted markdown string with the console's token styling. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="max-w-[760px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
