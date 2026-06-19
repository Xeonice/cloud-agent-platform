/**
 * Shared agent-runtime display label (fix-session-runtime-tag).
 *
 * The SINGLE source mapping a task's persisted `runtime` to a human-readable
 * agent label, consumed by BOTH the history page (`/history`) and the session
 * detail page (`/tasks/$taskId` tag rail + terminal-head `{agent}` segment).
 * Centralizing it here is the whole point: the two surfaces previously drifted
 * (history mapped the runtime correctly while the session detail hardcoded
 * "Codex"), which is the bug this change fixes — a shared helper makes that
 * drift impossible.
 *
 * A null/undefined runtime (legacy rows, or an omitted-on-create value) defaults
 * to `Codex`, matching the backend `DEFAULT_TASK_RUNTIME = 'codex'` semantics.
 */
import type { Runtime } from "@cap/contracts";

/** Agent display name from the persisted runtime (null/absent defaults to Codex). */
export function agentLabel(runtime: Runtime | null | undefined): string {
  return runtime === "claude-code" ? "Claude Code" : "Codex";
}
