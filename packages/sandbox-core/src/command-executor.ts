export interface SandboxCommandExecutionRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * Cooperative cancellation for adapters that can prove the guest process has
   * stopped before resolving. A transport abort by itself is not that proof.
   */
  readonly signal?: AbortSignal;
  /**
   * Ordinary execution is command-only. Provider setup needing structured
   * non-secret input must define a narrower allowlisted request instead of a
   * generic env/stdin/argv escape hatch.
   */
  readonly env?: never;
  readonly stdin?: never;
  readonly argv?: never;
  readonly authHeader?: never;
  readonly credential?: never;
  readonly secret?: never;
}

/**
 * Workspace Git commands are stricter than general provider setup commands:
 * credentials must already have become a temporary file path, so no generic
 * environment/stdin/argv escape hatch is accepted at this boundary.
 */
export type SandboxWorkspaceCommandExecutionRequest =
  SandboxCommandExecutionRequest;

export interface SandboxCommandExecutionResult {
  readonly exitCode: number;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface SandboxCommandExecutor {
  exec(
    request: SandboxCommandExecutionRequest,
  ): Promise<SandboxCommandExecutionResult>;
}

export interface SandboxWorkspaceCommandExecutor {
  exec(
    request: SandboxWorkspaceCommandExecutionRequest,
  ): Promise<SandboxCommandExecutionResult>;
}

export type SandboxCommandRunner = (
  request: SandboxCommandExecutionRequest,
) => Promise<unknown>;

export type SandboxWorkspaceCommandRunner = (
  request: SandboxWorkspaceCommandExecutionRequest,
) => Promise<unknown>;

export interface NormalizeSandboxCommandResultOptions {
  readonly scrubOutput?: boolean;
}

export function createSandboxCommandExecutor(
  run: SandboxCommandRunner,
  options: NormalizeSandboxCommandResultOptions = {},
): SandboxCommandExecutor {
  return {
    async exec(request) {
      return normalizeSandboxCommandResult(await run(request), options);
    },
  };
}

export function createSandboxWorkspaceCommandExecutor(
  run: SandboxWorkspaceCommandRunner,
  options: NormalizeSandboxCommandResultOptions = {},
): SandboxWorkspaceCommandExecutor {
  return {
    async exec(request) {
      return normalizeSandboxCommandResult(await run(request), options);
    },
  };
}

export function normalizeSandboxCommandResult(
  raw: unknown,
  options: NormalizeSandboxCommandResultOptions = {},
): SandboxCommandExecutionResult {
  const top = (raw ?? {}) as Record<string, unknown>;
  const data = (top.data ?? top) as Record<string, unknown>;
  const stdout = stringValue(data.stdout);
  const stderr = stringValue(data.stderr);
  const rawOutput = stringValue(data.output) || stderr || stdout;
  const output = options.scrubOutput
    ? scrubSandboxCommandOutput(rawOutput)
    : rawOutput;
  return {
    exitCode: coerceExitCode(data.exit_code ?? data.exitCode ?? data.code),
    output,
    stdout: options.scrubOutput ? scrubSandboxCommandOutput(stdout) : stdout,
    stderr: options.scrubOutput ? scrubSandboxCommandOutput(stderr) : stderr,
    timedOut:
      data.timedOut === true ||
      data.timeout === true ||
      data.timed_out === true,
  };
}

export function buildSandboxCommandLine(
  request: SandboxCommandExecutionRequest,
): string {
  return request.cwd
    ? `cd ${shellQuote(request.cwd)} && ${request.command}`
    : request.command;
}

export function scrubSandboxCommandOutput(output: string): string {
  return output
    .replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://***:***@')
    .replace(/(Authorization:\s*Basic\s+)\S+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function coerceExitCode(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

function singleQuoteValue(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function shellQuote(value: string): string {
  return `'${singleQuoteValue(value)}'`;
}
