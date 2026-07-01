import type {
  GitCloneSpec,
  SandboxCommandExecutor,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
} from '@cap/sandbox-core';

export async function deliverGitWorkspaceChanges(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly args: SandboxDeliverWorkspaceArgs;
}): Promise<SandboxDeliverWorkspaceResult> {
  const status = await args.executor.exec({
    command: 'git status --porcelain',
    cwd: args.workspacePath,
  });
  if (status.exitCode !== 0) {
    return failure(`git status failed: ${status.output}`);
  }
  if (!status.output.trim()) {
    return { hadChanges: false, commitSha: null, error: null };
  }

  const add = await args.executor.exec({
    command: 'git add -A',
    cwd: args.workspacePath,
  });
  if (add.exitCode !== 0) return failure(`git add failed: ${add.output}`);

  const commit = await args.executor.exec({
    command: `git commit -m ${shellQuote(args.args.commitMessage)}`,
    cwd: args.workspacePath,
  });
  if (commit.exitCode !== 0) return failure(`git commit failed: ${commit.output}`);

  const sha = await args.executor.exec({
    command: 'git rev-parse HEAD',
    cwd: args.workspacePath,
  });
  if (sha.exitCode !== 0) return failure(`git rev-parse failed: ${sha.output}`);

  const push = await args.executor.exec({
    command: `git -c http.extraHeader=${shellQuote(args.args.authHeader)} push origin HEAD:${shellQuote(args.args.branch)}`,
    cwd: args.workspacePath,
  });
  if (push.exitCode !== 0) return failure(`git push failed: ${push.output}`);

  return {
    hadChanges: true,
    commitSha: sha.output.trim() || null,
    error: null,
  };
}

export async function materializeGitWorkspace(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly cloneSpec: GitCloneSpec;
}): Promise<void> {
  const parent = dirname(args.workspacePath);
  const clone = await args.executor.exec({
    command: [
      `rm -rf ${shellQuote(args.workspacePath)}`,
      `mkdir -p ${shellQuote(parent)}`,
      `git ${gitAuthOption(args.cloneSpec.authHeader)} clone --recursive ${shellQuote(args.cloneSpec.url)} ${shellQuote(args.workspacePath)}`,
    ].join(' && '),
  });
  if (clone.exitCode !== 0) {
    throw new Error(`BoxLite git materialization failed: ${clone.output}`);
  }
}

export function requireGitCloneSpec(raw: unknown): GitCloneSpec {
  if (!raw || typeof raw !== 'object' || typeof (raw as { url?: unknown }).url !== 'string') {
    throw new Error('BoxLite git materialization requires a clone spec with a url');
  }
  const record = raw as { readonly url: string; readonly authHeader?: unknown };
  return {
    url: record.url,
    authHeader: typeof record.authHeader === 'string' ? record.authHeader : undefined,
  };
}

function failure(error: string): SandboxDeliverWorkspaceResult {
  return { hadChanges: false, commitSha: null, error };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitAuthOption(authHeader: string | undefined): string {
  return authHeader ? `-c http.extraHeader=${shellQuote(authHeader)}` : '';
}

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}
