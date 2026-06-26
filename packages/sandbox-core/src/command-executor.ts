export interface SandboxCommandExecutionRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

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

export type SandboxCommandRunner = (
  request: SandboxCommandExecutionRequest,
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
