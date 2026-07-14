import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { SessionHistory, SessionTurn } from "@cap/contracts";
import { SessionReplay } from "./session-replay";

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: vi.fn() };
});

const useQueryMock = useQuery as unknown as Mock;

function availableHistory(turns: SessionTurn[]): SessionHistory {
  return {
    status: "available",
    turns,
    meta: { taskId: "task-md", model: "fixture/concrete.v2" },
    isInterrupted: false,
  };
}

function renderReplay(history: SessionHistory): string {
  useQueryMock.mockReturnValue({ data: history, isLoading: false });
  return renderToStaticMarkup(
    React.createElement(SessionReplay, {
      taskId: "task-md",
      requestedModel: "fixture/alias.v1",
      presentationState: "completed",
      executionMode: "headless-exec",
    }),
  );
}

function renderLiveReplay(history: SessionHistory): string {
  useQueryMock.mockReturnValue({ data: history, isLoading: false });
  return renderToStaticMarkup(
    React.createElement(SessionReplay, {
      taskId: "task-md",
      requestedModel: "fixture/alias.v1",
      live: true,
      executionMode: "interactive-pty",
    }),
  );
}

describe("SessionReplay markdown rendering", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
  });

  it("renders user, commentary, and final-answer text as hardened GFM markdown", () => {
    const html = renderReplay(
      availableHistory([
        {
          kind: "user",
          text: "**用户重点** 和 `npm test`\n\n- 一\n- 二",
        },
        {
          kind: "assistant",
          isFinalAnswer: false,
          text: "参考 [文档](https://example.com)\n\n```ts\nconst ok = true;\n```",
        },
        {
          kind: "assistant",
          isFinalAnswer: true,
          text: "**项目结构**\n\n| 项 | 值 |\n| --- | --- |\n| build | ok |",
        },
      ]),
    );

    expect(html).toContain("操作员指令");
    expect(html).toContain("<strong");
    expect(html).toContain("用户重点");
    expect(html).toContain("<code");
    expect(html).toContain("npm test");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");

    expect(html).toContain("Codex · 过程");
    expect(html).toContain("italic");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<pre");
    expect(html).toContain("const ok = true;");

    expect(html).toContain("bg-success-soft");
    expect(html).toContain("✓ 最终回答");
    expect(html).toContain("项目结构");
    expect(html).toContain("<table");
    expect(html).not.toContain("**项目结构**");
  });

  it("keeps tool args and output verbatim instead of markdown-rendering them", () => {
    const html = renderReplay(
      availableHistory([
        {
          kind: "tool",
          name: "exec_command",
          args: "echo **not bold** && echo [not link](https://example.com)",
          output: "| not | table |\n`not code`",
          tokenCount: 42,
        },
      ]),
    );

    expect(html).toContain("exec_command");
    expect(html).toContain("echo **not bold**");
    expect(html).toContain("[not link](https://example.com)");
    expect(html).toContain("| not | table |");
    expect(html).toContain("`not code`");
    expect(html).toContain("42 tok");
    expect(html).not.toContain("<strong>not bold</strong>");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<code");
  });

  it("uses live polling and hides terminal-record replay for running interactive history", () => {
    const html = renderLiveReplay(
      availableHistory([
        {
          kind: "assistant",
          isFinalAnswer: false,
          text: "正在检查仓库。",
        },
      ]),
    );
    const queryOptions = useQueryMock.mock.calls[0]?.[0];

    expect(queryOptions).toMatchObject({ refetchInterval: 1500 });
    expect(html).toContain("运行中 · 实时 · 1 条记录");
    expect(html).toContain("正在检查仓库。");
    expect(html).toContain("对话记录");
    expect(html).not.toContain("终端记录");
  });

  it("keeps requested and runtime-reported actual models separate", () => {
    const html = renderReplay(availableHistory([]));
    expect(html).toContain("请求模型");
    expect(html).toContain("fixture/alias.v1");
    expect(html).toContain("实际模型");
    expect(html).toContain("fixture/concrete.v2");
  });
});
