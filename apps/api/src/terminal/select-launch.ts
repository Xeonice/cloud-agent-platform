/**
 * Pure launch-line selection (add-headless-execution-track). Extracted from
 * `AioPtyClient.launchAgent` so the interactive-vs-headless decision — the riskiest
 * branch in the live launch path — is unit-testable WITHOUT a WebSocket / container.
 * The pty client calls this and only does the I/O (sendInput/attach) around the result.
 */
import type {
  AgentRuntime,
  ExecutionMode,
  LaunchContext,
  TerminalStartup,
} from '../agent-runtime/agent-runtime.port';

export interface LaunchPlan {
  /** The detached-tmux launch line to send over the WS shell. */
  readonly line: string;
  /** The DSR/CR startup policy the shared pty mechanism reads. */
  readonly terminalStartup: TerminalStartup;
  /** Whether the cr-on-quiesce auto-submit timer should arm (NEVER for headless). */
  readonly armAutoSubmit: boolean;
}

/**
 * Decide how to launch a RESOLVED runtime given the task's execution mode.
 *
 * - `headless-exec` (programmatic) + a runtime that provides `buildHeadlessLine` →
 *   the non-interactive one-shot (`codex exec --json` / `claude -p`), which EXITS on
 *   completion. It needs NO DSR/CR startup handshake and NO autosubmit.
 * - otherwise (`interactive-pty`, or a runtime with no headless builder) → the
 *   interactive TUI launch line with the runtime's DECLARED `terminalStartup`, exactly
 *   as before this change (byte-identical for the console path).
 *
 * @param wantAutoSubmit whether the caller is a DEFINITIVE fresh launch (true) vs an
 *   inconclusive fallback (false); intersected with the declared policy.
 */
export function selectLaunch(
  runtime: AgentRuntime,
  executionMode: ExecutionMode,
  ctx: LaunchContext,
  wantAutoSubmit: boolean,
): LaunchPlan {
  const headless =
    executionMode === 'headless-exec' &&
    typeof runtime.buildHeadlessLine === 'function';
  const line = headless
    ? runtime.buildHeadlessLine!(ctx)
    : runtime.buildLaunchLine(ctx);
  const terminalStartup: TerminalStartup = headless
    ? { replyToStartupDSR: false, promptSubmit: 'none' }
    : runtime.terminalStartup;
  const armAutoSubmit =
    !headless &&
    wantAutoSubmit &&
    runtime.terminalStartup.promptSubmit === 'cr-on-quiesce';
  return { line, terminalStartup, armAutoSubmit };
}
