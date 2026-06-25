import type { CloneSpec } from './provision-lookup.port';
import {
  buildGitCloneCommand as buildCoreGitCloneCommand,
  buildGitDeliveryCommands,
  parseSandboxExecResult,
  scrubSandboxExecSecrets,
} from '@cap/sandbox';
import type {
  DeliverWorkspaceArgs,
  DeliverWorkspaceResult,
} from './sandbox-provider.port';

export interface AioExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface MaterializeGitWorkspaceArgs {
  readonly baseUrl: string;
  readonly taskId: string;
  readonly spec: CloneSpec;
  readonly workspaceDir: string;
}

export interface DeliverGitWorkspaceArgs {
  readonly baseUrl: string;
  readonly taskId: string;
  readonly workspaceDir: string;
  readonly timeoutMs: number;
  readonly deliver: DeliverWorkspaceArgs;
}

/**
 * Materialize a task repository into a sandbox workspace. This is intentionally
 * outside the provider class: the provider owns the execution capsule, while
 * workspace materialization is a separate bridge step, mirroring Sandbank's
 * workspace/sandbox split at our current git-clone boundary.
 */
export async function materializeGitWorkspace(
  args: MaterializeGitWorkspaceArgs,
): Promise<void> {
  const command = buildGitCloneCommand(args.spec, args.workspaceDir);
  let result: AioExecResult;
  try {
    result = await runAioShellExec(args.baseUrl, command);
  } catch (err) {
    throw new Error(
      `git clone into AIO sandbox for task ${args.taskId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const { exitCode, output } = result;
  if (exitCode !== 0) {
    const scrubbed = scrubAioExecSecrets(output);
    throw new Error(
      `git clone into AIO sandbox for task ${args.taskId} failed: exit_code ${exitCode}` +
        (scrubbed ? ` — ${scrubbed.trim()}` : ''),
    );
  }
}

/**
 * Push sandbox workspace changes back to the task forge. This is the output side
 * of the same workspace bridge as {@link materializeGitWorkspace}: provider code
 * supplies the live sandbox URL, while this helper owns git status/commit/push.
 */
export async function deliverGitWorkspaceChanges(
  args: DeliverGitWorkspaceArgs,
): Promise<DeliverWorkspaceResult> {
  const commands = buildGitDeliveryCommands({
    workspaceDir: args.workspaceDir,
    authHeader: args.deliver.authHeader,
    branch: args.deliver.branch,
    commitMessage: args.deliver.commitMessage,
  });
  const run = (command: string) =>
    runAioShellExec(args.baseUrl, command, args.timeoutMs);

  try {
    const status = await run(commands.status);
    if (status.exitCode !== 0) {
      return {
        hadChanges: false,
        commitSha: null,
        error: `git status exit ${status.exitCode}`,
      };
    }
    if (status.output.trim().length === 0) {
      return { hadChanges: false, commitSha: null, error: null };
    }

    const wrote = await run(commands.writeCommitMessage);
    if (wrote.exitCode !== 0) {
      return {
        hadChanges: true,
        commitSha: null,
        error: 'failed to stage commit message',
      };
    }

    const committed = await run(commands.commit);
    if (committed.exitCode !== 0) {
      return {
        hadChanges: true,
        commitSha: null,
        error: scrubAioExecSecrets(committed.output).trim() || 'commit failed',
      };
    }

    const sha = await run(commands.revParse);
    const commitSha =
      sha.exitCode === 0 ? sha.output.trim().split(/\s+/)[0] || null : null;

    const pushed = await run(commands.push);
    if (pushed.exitCode !== 0) {
      return {
        hadChanges: true,
        commitSha,
        error: scrubAioExecSecrets(pushed.output).trim() || 'push failed',
      };
    }
    return { hadChanges: true, commitSha, error: null };
  } catch (err) {
    return {
      hadChanges: false,
      commitSha: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildGitCloneCommand(spec: CloneSpec, workspaceDir: string): string {
  return buildCoreGitCloneCommand(spec, workspaceDir);
}

export async function runAioShellExec(
  baseUrl: string,
  command: string,
  timeoutMs?: number,
): Promise<AioExecResult> {
  const res = await fetch(`${baseUrl}/v1/shell/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
    signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`/v1/shell/exec responded ${res.status}`);
  }
  return parseAioExecResult(await res.json().catch(() => undefined));
}

/**
 * Parse an AIO `/v1/shell/exec` response into `{exitCode, output}`. The live AIO
 * server nests command result under `data`, but older mocks may return a flat
 * shape. Missing/unparseable codes stay NaN so callers fail closed.
 */
export function parseAioExecResult(raw: unknown): AioExecResult {
  return parseSandboxExecResult(raw);
}

export function scrubAioExecSecrets(output: string): string {
  return scrubSandboxExecSecrets(output);
}
