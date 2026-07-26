import type {
  TaskModelIntent,
  TaskModelLaunchMaterial,
} from '@cap/sandbox-core';

/**
 * Canonical interactive Codex argv shared by the runtime policy and the
 * provider-neutral compatibility launch seam. Codex is allowed to use its
 * native terminal mode; CAP retains only the task-sandbox YOLO policy and the
 * canonical workspace selection.
 */
export const DEFAULT_CODEX_INTERACTIVE_LAUNCH_ARGV =
  'codex -C /home/gem/workspace --dangerously-bypass-approvals-and-sandbox';

const FORBIDDEN_CODEX_INTERACTIVE_FLAGS = [
  '--no-alt-screen',
  '--ask-for-approval',
  '--sandbox',
  '--dangerously-bypass-hook-trust',
  '--full-auto',
] as const;

/**
 * Fail closed on a stale operator override instead of silently restoring the
 * old inline/pre-YOLO launch policy. The value is a trusted shell fragment, so
 * this validation intentionally checks policy anchors rather than attempting
 * to reinterpret or rewrite shell quoting.
 */
export function assertNativeCodexInteractiveLaunchArgv(argv: string): string {
  if (!argv.includes('--dangerously-bypass-approvals-and-sandbox')) {
    throw new Error(
      'Interactive Codex launch must retain --dangerously-bypass-approvals-and-sandbox',
    );
  }
  const forbidden = FORBIDDEN_CODEX_INTERACTIVE_FLAGS.find((flag) =>
    argv.includes(flag),
  );
  if (forbidden) {
    throw new Error(
      `Interactive Codex launch contains forbidden legacy flag ${forbidden}`,
    );
  }
  return argv;
}

export type SandboxTerminalExecutionMode = 'interactive-pty' | 'headless-exec';

export interface SandboxTerminalStartup {
  readonly replyToStartupDSR: boolean;
  readonly promptSubmit: 'none' | 'cr-on-quiesce';
  readonly quiesceMs?: number;
}

export interface SandboxTerminalLaunchContext {
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly sessionId?: string;
  readonly model: TaskModelLaunchMaterial;
}

export interface SandboxResolvedTaskLaunchContext {
  readonly runtime: SandboxTerminalRuntime;
  readonly executionMode: SandboxTerminalExecutionMode;
  readonly modelIntent: TaskModelIntent;
}

export interface SandboxTerminalExec {
  exec(command: string): Promise<{ stdout: string; code: number | null }>;
}

export type SandboxTerminalExitSignal =
  | { readonly status: 'running' }
  | { readonly status: 'done' };

export interface SandboxTerminalRuntime {
  readonly id: string;
  readonly terminalStartup: SandboxTerminalStartup;
  buildLaunchLine(ctx: SandboxTerminalLaunchContext): string;
  buildHeadlessLine?(ctx: SandboxTerminalLaunchContext): string;
  detectExit(
    exec: SandboxTerminalExec,
    ctx: SandboxTerminalLaunchContext,
  ): Promise<SandboxTerminalExitSignal>;
}

export interface SandboxTerminalExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export type SandboxLegacyTerminalExec = (
  command: string,
) => Promise<SandboxTerminalExecResult>;

export function toSandboxTerminalRuntimeExec(
  exec: SandboxLegacyTerminalExec,
): SandboxTerminalExec {
  return {
    async exec(command): Promise<{ stdout: string; code: number | null }> {
      const { exitCode, output } = await exec(command);
      return { stdout: output, code: Number.isNaN(exitCode) ? null : exitCode };
    },
  };
}

export function terminalSessionIdForTask(taskId: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = 0; i < taskId.length; i += 1) {
    const c = taskId.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 1) | 1), 0x01000193) >>> 0;
  }
  const hex = (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0')
  ).slice(0, 32);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}
