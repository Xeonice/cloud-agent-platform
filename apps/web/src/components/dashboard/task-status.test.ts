/**
 * `cancelled` status presentation (task-guardrail-controls 5.5). Pure maps, no
 * DOM — runs in the node-env vitest suite. Guards that the operator-stop terminal
 * renders distinctly (neutral, settled) in BOTH the dashboard queue and the
 * history result column, and is treated as terminal by `isOpenTask`.
 */
import { describe, it, expect } from "vitest";

import {
  presentTaskStatus,
  TASK_STATUS_PRESENTATION,
  isOpenTask,
} from "./task-status";
import { presentHistoryResult } from "../history/history-result";

describe("cancelled status presentation", () => {
  it("dashboard presents cancelled as a settled, neutral, connectable row", () => {
    const p = presentTaskStatus("cancelled");
    expect(p.label).toBe("已取消");
    expect(p.state).toBe("done");
    expect(p.variant).toBe("neutral");
    expect(p.connectable).toBe(true);
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
