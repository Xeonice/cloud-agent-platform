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
 * The label text itself lives in the contracts RUNTIME_METADATA policy table
 * (unlock-extension-axes V.8): this file keeps the console's ABSENT/unknown
 * semantics but no longer owns a second copy of the per-runtime copy, so a
 * third runtime's label arrives with its metadata row and no console edit.
 *
 * A null/undefined runtime (legacy rows, or an omitted-on-create value) defaults
 * to `Codex`, matching the backend `DEFAULT_TASK_RUNTIME = 'codex'` semantics.
 */
import {
  DEFAULT_AGENT_RUNTIME_ID,
  RUNTIME_METADATA,
  type Runtime,
} from "@cap-console/contracts";

/**
 * Agent display name from the persisted runtime.
 *
 * ABSENT (null/undefined — legacy rows, omitted on create) keeps the documented
 * `codex` default. An id this console has no copy for renders AS ITSELF: showing
 * it as "Codex" told the operator their claude task ran codex, which is worse
 * than an unfamiliar word on screen.
 */
export function agentLabel(runtime: Runtime | null | undefined): string {
  if (runtime === null || runtime === undefined) {
    return RUNTIME_METADATA[DEFAULT_AGENT_RUNTIME_ID].label;
  }
  return RUNTIME_METADATA[runtime]?.label ?? runtime;
}
