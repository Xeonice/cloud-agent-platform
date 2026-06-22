/**
 * Render test for the `/tasks/$taskId/transcript` route's per-turn renderer
 * (`TxRow`) — unify-transcript-parsers Track 6 frontend goal. The parser side
 * now feeds the console a `SessionTurn[]` whose Part-2 additions are tool turns
 * (name + args + output) and reasoning assistant turns (`isFinalAnswer:false`,
 * rendered as 「推理」). This asserts the route actually RENDERS that turn list:
 * a tool card, a 推理 commentary turn, and a final answer each emit their
 * distinguishing markup off a fixture — the contract `SessionTurn` shape the
 * fixed parsers produce.
 *
 * Uses `react-dom/server` `renderToStaticMarkup` so the render needs no DOM /
 * `window` and runs in the repo's node-env vitest suite (no jsdom /
 * @testing-library dependency added). The route's DATA wiring (`taskId` →
 * queries) stays covered by the Playwright visual gate; this owns the per-kind
 * render off the typed turns.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

import type { SessionTurn } from "@cap/contracts";
import { TxRow } from "./$taskId_.transcript";

/** A representative SessionTurn[] the fixed parsers emit (codex + claude shapes). */
const toolTurn: SessionTurn = {
  kind: "tool",
  name: "exec_command",
  args: "ls src",
  output: "app.tsx\nlogin.tsx",
  at: "2026-06-12T09:30:35Z",
};
const reasoningTurn: SessionTurn = {
  kind: "assistant",
  text: "先看一下相关文件。",
  isFinalAnswer: false,
  at: "2026-06-12T09:30:10Z",
};
const finalTurn: SessionTurn = {
  kind: "assistant",
  text: "已修复登录页样式。",
  isFinalAnswer: true,
  at: "2026-06-12T09:31:00Z",
};

function renderTurns(turns: SessionTurn[]): string {
  return renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      ...turns.map((ev, i) => React.createElement(TxRow, { key: i, ev })),
    ),
  );
}

describe("transcript TxRow renders the SessionTurn[] turn list", () => {
  it("renders a tool turn as a tool card carrying name + args + collapsible output", () => {
    const html = renderToStaticMarkup(React.createElement(TxRow, { ev: toolTurn }));
    // tool name + the human-readable command (NOT a raw JSON args blob)
    expect(html).toContain("exec_command");
    expect(html).toContain("ls src");
    // the paired output renders inside a collapsible <details>
    expect(html).toContain("<details");
    expect(html).toContain("输出");
    expect(html).toContain("app.tsx\nlogin.tsx");
  });

  it("renders an assistant{isFinalAnswer:false} turn as a 推理 commentary turn", () => {
    const html = renderToStaticMarkup(React.createElement(TxRow, { ev: reasoningTurn }));
    expect(html).toContain("推理");
    expect(html).toContain("先看一下相关文件。");
    // a reasoning turn is NOT the final-answer bubble
    expect(html).not.toContain("最终回答");
  });

  it("renders an assistant{isFinalAnswer:true} turn as the 最终回答 bubble", () => {
    const html = renderToStaticMarkup(React.createElement(TxRow, { ev: finalTurn }));
    expect(html).toContain("最终回答");
    expect(html).toContain("已修复登录页样式。");
    // the final answer is NOT the 推理 channel
    expect(html).not.toContain("推理");
  });

  it("renders the whole turn list together — tool card + 推理 + final answer all present", () => {
    const html = renderTurns([reasoningTurn, toolTurn, finalTurn]);
    expect(html).toContain("推理");
    expect(html).toContain("exec_command");
    expect(html).toContain("ls src");
    expect(html).toContain("最终回答");
    // one row per turn (each TxRow is a top-level grid row)
    expect(html.match(/grid-cols-\[56px/g) ?? []).toHaveLength(3);
  });

  it("renders a tool turn with no paired output WITHOUT a <details> block (honest null output)", () => {
    const unmatched: SessionTurn = { kind: "tool", name: "Read", args: "/home/gem/login.tsx", output: null };
    const html = renderToStaticMarkup(React.createElement(TxRow, { ev: unmatched }));
    expect(html).toContain("Read");
    expect(html).toContain("/home/gem/login.tsx");
    expect(html).not.toContain("<details");
  });
});

// ---------------------------------------------------------------------------
// render-transcript-markdown: turn text renders as HARDENED GFM markdown
// ---------------------------------------------------------------------------

/** A final-answer assistant turn carrying `text` markdown (the markdown-bearing kind). */
const mdTurn = (text: string): SessionTurn => ({
  kind: "assistant",
  text,
  isFinalAnswer: true,
  at: "2026-06-12T09:31:00Z",
});

describe("transcript turn text renders as hardened GFM markdown", () => {
  it("renders bold, lists, and inline code as formatted markup (raw ** / backticks gone)", () => {
    const html = renderToStaticMarkup(
      React.createElement(TxRow, { ev: mdTurn("**重点** 和 `code`\n\n- 一\n- 二") }),
    );
    expect(html).toContain("<strong");
    expect(html).toContain("重点");
    expect(html).toContain("<code");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).not.toContain("**重点**");
    expect(html).not.toContain("`code`");
  });

  it("renders a fenced code block as <pre><code> and a GFM table inside an overflow-x:auto wrapper", () => {
    const html = renderToStaticMarkup(
      React.createElement(TxRow, {
        ev: mdTurn("```\nx=1\n```\n\n| 项 | 值 |\n|----|----|\n| a | 1 |"),
      }),
    );
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain("x=1");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("overflow-x-auto");
  });

  it("preserves the reasoning italic wrapper and the final-answer bubble around rendered markdown", () => {
    const reasoning = renderToStaticMarkup(
      React.createElement(TxRow, { ev: { kind: "assistant", text: "**步骤 1**", isFinalAnswer: false } }),
    );
    expect(reasoning).toContain("italic");
    expect(reasoning).toContain("<strong");
    const final = renderToStaticMarkup(
      React.createElement(TxRow, { ev: { kind: "assistant", text: "**完成**", isFinalAnswer: true } }),
    );
    expect(final).toContain("bg-success-soft");
    expect(final).toContain("<strong");
  });

  // --- untrusted hardening (agent output is untrusted) ---
  it("escapes embedded raw HTML to inert text (no live <script>)", () => {
    const html = renderToStaticMarkup(
      React.createElement(TxRow, { ev: mdTurn("<script>alert(1)</script> 之后") }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("blocks an agent-supplied remote image (no <img>)", () => {
    const html = renderToStaticMarkup(
      React.createElement(TxRow, { ev: mdTurn("![x](http://evil.example/track.png)") }),
    );
    expect(html).not.toContain("<img");
  });

  it("strips a javascript: link href via the default urlTransform", () => {
    const html = renderToStaticMarkup(
      React.createElement(TxRow, { ev: mdTurn("[点我](javascript:alert(1))") }),
    );
    expect(html).not.toContain('href="javascript:');
  });

  it("emits no heading slug/anchor id for an untrusted heading", () => {
    const html = renderToStaticMarkup(React.createElement(TxRow, { ev: mdTurn("# 我的标题") }));
    expect(html).toContain("我的标题");
    expect(html).not.toContain('id="');
  });

  it("leaves tool args + output verbatim (NOT markdown-rendered)", () => {
    const html = renderToStaticMarkup(
      React.createElement(TxRow, {
        ev: {
          kind: "tool",
          name: "Bash",
          args: "echo **not bold**",
          output: "| not | table |",
          at: "2026-06-12T09:30:35Z",
        },
      }),
    );
    expect(html).toContain("echo **not bold**"); // literal, not <strong>
    expect(html).not.toContain("<strong");
    expect(html).not.toContain("<table");
  });
});
