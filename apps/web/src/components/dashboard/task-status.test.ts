/**
 * Task-status presentation + action-descriptor map (task-guardrail-controls 5.5;
 * console-design-pixel-merge 4.1). Pure maps, no DOM — runs in the node-env
 * vitest suite. Guards:
 *  - the exhaustive status→action descriptor (D3): every `TaskStatus` member
 *    carries the design-revision action, and the queued/pending 等待 runner
 *    affordance is plain non-primary styling data — there is NO disabled flag
 *    in the descriptor shape (rows render it as a real link);
 *  - the `cancelled` operator-stop terminal renders distinctly (neutral,
 *    settled) in BOTH the dashboard inbox and the history result column, and is
 *    treated as terminal by `isOpenTask`.
 */
import { describe, it, expect } from "vitest";

import {
  presentTaskStatus,
  TASK_STATUS_PRESENTATION,
  isOpenTask,
} from "./task-status";
import { presentHistoryResult } from "../history/history-result";

describe("status → action descriptor (console-design-pixel-merge D3)", () => {
  it("awaiting_input gets the primary 处理输入 action", () => {
    expect(presentTaskStatus("awaiting_input").action).toEqual({
      label: "处理输入",
      emphasis: "primary",
    });
  });

  it("running gets the 接管会话 action", () => {
    expect(presentTaskStatus("running").action).toEqual({
      label: "接管会话",
      emphasis: "neutral",
    });
  });

  it("completed gets the ghost 查看记录 action", () => {
    expect(presentTaskStatus("completed").action).toEqual({
      label: "查看记录",
      emphasis: "ghost",
    });
  });

  it("failed (and agent_failed_to_start) get the ghost 查看错误 action", () => {
    expect(presentTaskStatus("failed").action).toEqual({
      label: "查看错误",
      emphasis: "ghost",
    });
    expect(presentTaskStatus("agent_failed_to_start").action).toEqual({
      label: "查看错误",
      emphasis: "ghost",
    });
  });

  it("queued/pending get the navigable, non-primary 等待 runner action (never a disabled flag)", () => {
    for (const status of ["queued", "pending"] as const) {
      const action = presentTaskStatus(status).action;
      expect(action).toEqual({ label: "等待 runner", emphasis: "waiting" });
      // The descriptor shape carries NO disabled affordance — D3 overturned
      // the prior `connectable: false` mapping.
      expect(action).not.toHaveProperty("disabled");
    }
    expect(presentTaskStatus("queued")).not.toHaveProperty("connectable");
  });

  it("every TaskStatus member carries a labeled action", () => {
    for (const presentation of Object.values(TASK_STATUS_PRESENTATION)) {
      expect(presentation.action.label.length).toBeGreaterThan(0);
      expect(["primary", "neutral", "ghost", "waiting"]).toContain(
        presentation.action.emphasis,
      );
    }
  });
});

describe("cancelled status presentation", () => {
  it("dashboard presents cancelled as a settled, neutral row with the 查看记录 action", () => {
    const p = presentTaskStatus("cancelled");
    expect(p.label).toBe("已取消");
    expect(p.state).toBe("done");
    expect(p.variant).toBe("neutral");
    expect(p.action).toEqual({ label: "查看记录", emphasis: "ghost" });
  });

  it("cancelled is terminal (not an open task)", () => {
    expect(isOpenTask("cancelled")).toBe(false);
  });

  it("history result presents cancelled as 已取消 / neutral (a stop, not a failure)", () => {
    const h = presentHistoryResult("cancelled");
    expect(h.label).toBe("已取消");
    expect(h.variant).toBe("neutral");
  });

  it("the presentation map carries a cancelled entry", () => {
    expect(TASK_STATUS_PRESENTATION.cancelled).toBeDefined();
  });
});
