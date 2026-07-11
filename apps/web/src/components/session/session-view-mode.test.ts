/**
 * Pure-logic test for `sessionViewMode` (headless-task-conversation-view): the
 * session page's terminal-vs-conversation branch. Runs in vitest's node env (no
 * DOM) — the repo convention of testing the pure glue the page composes.
 */
import { describe, it, expect } from "vitest";

import { sessionTaskState, sessionViewMode } from "./session-view-mode";

describe("sessionViewMode", () => {
  it("a RUNNING headless task → live polled conversation (no terminal)", () => {
    expect(sessionViewMode("running", "headless-exec")).toBe("headless-live");
    expect(sessionViewMode("awaiting_input", "headless-exec")).toBe(
      "headless-live",
    );
  });

  it("a RUNNING interactive task → live terminal (unchanged)", () => {
    expect(sessionViewMode("running", "interactive-pty")).toBe("live-terminal");
    expect(sessionViewMode("awaiting_input", "interactive-pty")).toBe(
      "live-terminal",
    );
  });

  it("a running task with no executionMode defaults to the live terminal", () => {
    // A null/undefined mode is the interactive default — never accidentally headless.
    expect(sessionViewMode("running", null)).toBe("live-terminal");
    expect(sessionViewMode("running", undefined)).toBe("live-terminal");
  });

  it("a FINISHED task always replays, regardless of mode", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "agent_failed_to_start",
    ] as const) {
      expect(sessionViewMode(status, "headless-exec")).toBe("finished-replay");
      expect(sessionViewMode(status, "interactive-pty")).toBe("finished-replay");
    }
  });

  it("a pre-running task waits (no sandbox yet), regardless of mode", () => {
    expect(sessionViewMode("pending", "headless-exec")).toBe("pre-running");
    expect(sessionViewMode("queued", "interactive-pty")).toBe("pre-running");
  });
});

describe("sessionTaskState", () => {
  it("renders both task failure terminals as failures", () => {
    expect(sessionTaskState("failed")).toBe("failed");
    expect(sessionTaskState("agent_failed_to_start")).toBe("failed");
  });

  it("keeps successful and operator terminal states stopped", () => {
    expect(sessionTaskState("completed")).toBe("stopped");
    expect(sessionTaskState("cancelled")).toBe("stopped");
  });
});
