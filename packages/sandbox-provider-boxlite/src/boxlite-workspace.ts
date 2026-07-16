import type {
  GitCloneSpec,
  SandboxCommandExecutor,
  SandboxDeliverWorkspaceArgs,
  SandboxDeliverWorkspaceResult,
} from '@cap/sandbox-core';

export async function deliverGitWorkspaceChanges(_args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly args: SandboxDeliverWorkspaceArgs;
}): Promise<SandboxDeliverWorkspaceResult> {
  return failure('Legacy provider-local Git delivery is disabled');
}

export async function materializeGitWorkspace(args: {
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly cloneSpec: GitCloneSpec;
}): Promise<void> {
  if (args.cloneSpec.authHeader !== undefined) {
    throw new Error('Legacy raw-header Git clone is disabled');
  }
  const parent = dirname(args.workspacePath);
  const clone = await args.executor.exec({
    command: [
      `rm -rf ${shellQuote(args.workspacePath)}`,
      `mkdir -p ${shellQuote(parent)}`,
      `git clone --recursive ${shellQuote(args.cloneSpec.url)} ${shellQuote(args.workspacePath)}`,
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

function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}
