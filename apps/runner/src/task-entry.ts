/**
 * @cap/runner — task entry (Track 4: terminal-execution, tasks 4.1–4.4).
 *
 * This is the per-task entry point. It:
 *   4.1 accepts a task id/config and creates the isolated, per-task
 *       `workspaces/<id>` directory (distinct per task);
 *   4.2 spawns the INTERACTIVE `codex` CLI under node-pty with `cwd` set to
 *       that workspace and `TERM=xterm-256color` (see ./pty/spawn-codex.ts);
 *   4.3 pumps raw PTY bytes append-only into `workspaces/<id>/session.log`
 *       (see ./session-log.ts);
 *   4.4 enforces a bounded startup window and reports a DISTINCT
 *       agent-failed-to-start condition rather than hanging
 *       (see ./startup-window.ts).
 *
 * Per the partition note, the orchestrator-side wiring and the SandboxProvider
 * port refactor of these provisioning call sites land in Track 14; this module
 * owns only the runner-local task lifecycle.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { spawnCodexPty, type CodexPtyHandle } from './pty/spawn-codex.js';
import { SessionLog } from './session-log.js';
import {
  DockerRunnerSandboxProvider,
  sandboxModeArgs,
  type SandboxProvider,
} from './sandbox/sandbox-provider.port.js';
import {
  StartupWindow,
  AGENT_FAILED_TO_START,
  type AgentFailedToStartReason,
  type StartupOutcome,
} from './startup-window.js';

/**
 * The directory (relative to the runner process cwd by default) under which
 * every task's isolated `<id>` workspace is created. Absolute when supplied via
 * config; otherwise resolved against `process.cwd()`.
 */
export const DEFAULT_WORKSPACES_ROOT = 'workspaces';

/**
 * Inbound task configuration handed to the runner entry. Only `taskId` is
 * required; the rest carry the spawn parameters and tunables.
 */
export interface TaskConfig {
  /** Distinct per-task id. Drives the `workspaces/<id>` directory. */
  readonly taskId: string;
  /**
   * Root under which the `<taskId>` workspace directory is created. Defaults to
   * {@link DEFAULT_WORKSPACES_ROOT} resolved against `process.cwd()`.
   */
  readonly workspacesRoot?: string;
  /** Path/name of the interactive `codex` binary. Defaults to `codex`. */
  readonly codexBin?: string;
  /** Extra arguments forwarded to the interactive `codex` invocation. */
  readonly codexArgs?: readonly string[];
  /**
   * The execution sandbox provider (9.1b). The `--sandbox <mode>` flag passed to
   * codex is derived from `getSandboxMode()` rather than hardcoded here, so a
   * future OS-isolating impl needs no change to this provisioning call site.
   * Defaults to {@link DockerRunnerSandboxProvider} (`danger-full-access`).
   */
  readonly sandboxProvider?: SandboxProvider;
  /** Initial PTY geometry. Defaults to 80×24. */
  readonly cols?: number;
  readonly rows?: number;
  /**
   * Bounded startup window in milliseconds. If the process exits non-zero or
   * produces no first interactive frame within this window, the runner reports
   * agent-failed-to-start (task 4.4). Defaults to 30_000ms.
   */
  readonly startupWindowMs?: number;
  /** Extra environment merged over the spawn environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Reporter sink for terminal lifecycle conditions surfaced to the orchestrator.
 * The concrete transport (the dial-back WebSocket from Track 8) is injected; the
 * runner core depends only on this narrow port so it stays testable and is not
 * coupled to the dial-back wiring.
 */
export interface OrchestratorReporter {
  /**
   * Report the DISTINCT agent-failed-to-start condition (task 4.4). MUST be
   * called instead of leaving the task hanging when startup fails.
   */
  reportAgentFailedToStart(detail: AgentFailedToStartDetail): void;
  /** Report that the agent reached an interactive state (startup succeeded). */
  reportStarted?(detail: { readonly taskId: string }): void;
  /** Report normal process exit after a successful start. */
  reportExited?(detail: { readonly taskId: string; readonly exitCode: number }): void;
}

/** Payload for an agent-failed-to-start report. */
export interface AgentFailedToStartDetail {
  readonly taskId: string;
  /**
   * The reported status string. Intentionally equal to the contracts
   * `TaskStatus` literal `'agent_failed_to_start'` so the orchestrator can map
   * it straight onto the task lifecycle without a translation table.
   */
  readonly status: typeof AGENT_FAILED_TO_START;
  /** Why startup was judged to have failed. */
  readonly reason: AgentFailedToStartReason;
  /** Process exit code, when the failure was an early non-zero exit. */
  readonly exitCode?: number;
  readonly message: string;
}

/** Handle returned by {@link startTask}, exposing the running task surface. */
export interface RunningTask {
  readonly taskId: string;
  /** Absolute path to this task's isolated workspace directory. */
  readonly workspaceDir: string;
  /** Absolute path to this task's append-only session log. */
  readonly sessionLogPath: string;
  /** Resolves once the startup window has been decided (started or failed). */
  readonly startup: Promise<StartupOutcome>;
  /** The live PTY handle (used by realtime-terminal in Track 5 / integration). */
  readonly pty: CodexPtyHandle;
  /** Request teardown: kill the PTY and flush/close the session log. */
  stop(): Promise<void>;
}

/**
 * Resolve the absolute, isolated `workspaces/<id>` directory for a task and
 * create it (task 4.1). Two distinct task ids resolve to two distinct paths.
 */
export async function createTaskWorkspace(config: TaskConfig): Promise<string> {
  const root = config.workspacesRoot
    ? path.resolve(config.workspacesRoot)
    : path.resolve(process.cwd(), DEFAULT_WORKSPACES_ROOT);
  const workspaceDir = path.join(root, config.taskId);
  // `recursive: true` is idempotent: re-entry for an existing task does not
  // throw, and the directory is never wiped (preserving an existing session.log).
  await mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

/**
 * Start a task end-to-end: create its isolated workspace, spawn the interactive
 * codex PTY into it, pump raw bytes append-only into `session.log`, and arm the
 * bounded startup window that reports agent-failed-to-start on early
 * exit / no-first-frame.
 */
export async function startTask(
  config: TaskConfig,
  reporter: OrchestratorReporter,
): Promise<RunningTask> {
  // 4.1 — isolated per-task workspace.
  const workspaceDir = await createTaskWorkspace(config);

  // 4.3 — append-only session.log opened up-front so no early byte is dropped.
  const sessionLog = await SessionLog.open(workspaceDir);

  // 9.1b — the sandbox mode is provider-driven, not hardcoded at this call site.
  // The `--sandbox <mode>` flag is derived from the SandboxProvider port and
  // prepended to any caller-supplied interactive args.
  const sandboxProvider = config.sandboxProvider ?? new DockerRunnerSandboxProvider();
  const codexArgs = [
    ...sandboxModeArgs(sandboxProvider.getSandboxMode()),
    ...(config.codexArgs ?? []),
  ];

  // 4.2 — spawn the interactive codex under node-pty (never the headless
  // `exec --json` / `app-server` transports), cwd = workspace, TERM set.
  const pty = spawnCodexPty({
    cwd: workspaceDir,
    codexBin: config.codexBin,
    codexArgs,
    cols: config.cols,
    rows: config.rows,
    env: config.env,
  });

  // 4.4 — bounded startup window watching for early exit / first frame.
  const startupWindow = new StartupWindow(config.startupWindowMs);

  pty.onData((bytes) => {
    // 4.3 — authoritative replay source: append in emission order, never
    // overwrite. The first observed data byte satisfies the "first interactive
    // frame" condition for the startup window.
    sessionLog.append(bytes);
    startupWindow.noteFirstFrame();
  });

  pty.onExit(({ exitCode }) => {
    startupWindow.noteExit(exitCode);
  });

  const startup = startupWindow.outcome.then((outcome): StartupOutcome => {
    if (outcome.ok) {
      reporter.reportStarted?.({ taskId: config.taskId });
    } else {
      // Distinct, non-hanging report (task 4.4).
      reporter.reportAgentFailedToStart({
        taskId: config.taskId,
        status: AGENT_FAILED_TO_START,
        reason: outcome.reason,
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
        message: describeFailure(config.taskId, outcome),
      });
      // Failure path must not leave the child running.
      void teardown(pty, sessionLog);
    }
    return outcome;
  });

  async function stop(): Promise<void> {
    startupWindow.cancel();
    await teardown(pty, sessionLog);
  }

  return {
    taskId: config.taskId,
    workspaceDir,
    sessionLogPath: sessionLog.path,
    startup,
    pty,
    stop,
  };
}

function describeFailure(
  taskId: string,
  outcome: Extract<StartupOutcome, { ok: false }>,
): string {
  switch (outcome.reason) {
    case 'early_exit':
      return `task ${taskId}: codex exited (code ${outcome.exitCode ?? 'unknown'}) before its first interactive frame`;
    case 'startup_timeout':
      return `task ${taskId}: codex produced no interactive frame within the startup window`;
    default: {
      const _exhaustive: never = outcome.reason;
      return _exhaustive;
    }
  }
}

async function teardown(pty: CodexPtyHandle, sessionLog: SessionLog): Promise<void> {
  pty.kill();
  await sessionLog.close();
}
