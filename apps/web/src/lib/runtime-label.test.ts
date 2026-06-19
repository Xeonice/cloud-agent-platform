/**
 * Shared runtime-label mapping test (fix-session-runtime-tag). Pure, node-env.
 * Pins the single source that history + session detail both consume so the two
 * surfaces cannot drift back apart.
 */
import { describe, it, expect } from "vitest";

import { agentLabel } from "./runtime-label";

describe("agentLabel", () => {
  it("maps claude-code → Claude Code", () => {
    expect(agentLabel("claude-code")).toBe("Claude Code");
  });

  it("maps codex → Codex", () => {
    expect(agentLabel("codex")).toBe("Codex");
  });

  it("defaults null/undefined → Codex (DEFAULT_TASK_RUNTIME semantics)", () => {
    expect(agentLabel(null)).toBe("Codex");
    expect(agentLabel(undefined)).toBe("Codex");
  });
});
