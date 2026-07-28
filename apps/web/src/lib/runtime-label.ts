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

/**
 * Display names for the runtimes this console ships copy for. A total mapping,
 * so adding a runtime to the contract without adding its label is a build error
 * rather than a UI that silently calls it "Codex".
 */
const AGENT_LABELS: Record<Runtime, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

/**
 * Agent display name from the persisted runtime.
 *
 * ABSENT (null/undefined — legacy rows, omitted on create) keeps the documented
 * `codex` default. An id this console has no copy for renders AS ITSELF: showing
 * it as "Codex" told the operator their claude task ran codex, which is worse
 * than an unfamiliar word on screen.
 */
export function agentLabel(runtime: Runtime | null | undefined): string {
  if (runtime === null || runtime === undefined) return AGENT_LABELS.codex;
  return AGENT_LABELS[runtime] ?? runtime;
}
