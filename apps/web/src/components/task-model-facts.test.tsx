import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SessionHistory } from "@cap/contracts";
import {
  actualModelFromHistory,
  TaskModelFacts,
} from "./task-model-facts";

describe("TaskModelFacts", () => {
  it("shows requested aliases separately from runtime-reported actual models", () => {
    const html = renderToStaticMarkup(
      <TaskModelFacts
        requestedModel="fixture/alias.v1"
        actualModel="fixture/concrete.v2"
      />,
    );
    expect(html).toContain("请求模型");
    expect(html).toContain("fixture/alias.v1");
    expect(html).toContain("实际模型");
    expect(html).toContain("fixture/concrete.v2");
    expect(html).toContain("运行时报告值与请求不同");
  });

  it("shows default intent without inventing an actual model", () => {
    const html = renderToStaticMarkup(
      <TaskModelFacts requestedModel={null} />,
    );
    expect(html).toContain("运行时默认");
    expect(html).not.toContain("实际模型");
  });

  it("reads actual evidence only from available session metadata", () => {
    const available = {
      status: "available",
      turns: [],
      meta: { taskId: "task-1", model: "fixture/observed" },
      isInterrupted: false,
    } satisfies SessionHistory;
    expect(actualModelFromHistory(available)).toBe("fixture/observed");
    expect(
      actualModelFromHistory({ status: "expired" } satisfies SessionHistory),
    ).toBeNull();
  });
});
