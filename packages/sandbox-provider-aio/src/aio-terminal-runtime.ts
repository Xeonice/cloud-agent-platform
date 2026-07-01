export type AioExecutionMode = 'interactive-pty' | 'headless-exec';

export interface AioTerminalStartup {
  readonly replyToStartupDSR: boolean;
  readonly promptSubmit: 'none' | 'cr-on-quiesce';
  readonly quiesceMs?: number;
}

export interface AioLaunchContext {
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly sessionId?: string;
}

export interface AioSandboxExec {
  exec(command: string): Promise<{ stdout: string; code: number | null }>;
}

export type AioExitSignal =
  | { readonly status: 'running' }
  | { readonly status: 'done' };

export interface AioTerminalRuntime {
  readonly id: string;
  readonly terminalStartup: AioTerminalStartup;
  buildLaunchLine(ctx: AioLaunchContext): string;
  buildHeadlessLine?(ctx: AioLaunchContext): string;
  detectExit(exec: AioSandboxExec, ctx: AioLaunchContext): Promise<AioExitSignal>;
}

export interface AioTerminalExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export type AioLegacySandboxExec = (
  command: string,
) => Promise<AioTerminalExecResult>;

export function toAioTerminalRuntimeExec(
  exec: AioLegacySandboxExec,
): AioSandboxExec {
  return {
    async exec(command): Promise<{ stdout: string; code: number | null }> {
      const { exitCode, output } = await exec(command);
      return { stdout: output, code: Number.isNaN(exitCode) ? null : exitCode };
    },
  };
}

export function aioSessionIdForTask(taskId: string): string {
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
