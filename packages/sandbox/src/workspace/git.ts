import {
  normalizeSandboxCommandResult,
  scrubSandboxCommandOutput,
  type GitCloneSpec,
} from '@cap/sandbox-core';

export interface DeliverGitWorkspaceCommandArgs {
  readonly workspaceDir: string;
  readonly authHeader: string;
  readonly branch: string;
  readonly commitMessage: string;
}

export interface GitWorkspaceDeliveryCommands {
  readonly status: string;
  readonly writeCommitMessage: string;
  readonly commit: string;
  readonly revParse: string;
  readonly push: string;
}

export function buildGitCloneCommand(spec: GitCloneSpec, workspaceDir: string): string {
  return spec.authHeader
    ? `git -c ${shellQuote(`http.extraHeader=${spec.authHeader}`)} clone -- ${shellQuote(
        spec.url,
      )} ${shellQuote(workspaceDir)}`
    : `git clone -- ${shellQuote(spec.url)} ${shellQuote(workspaceDir)}`;
}

export function buildGitDeliveryCommands(
  args: DeliverGitWorkspaceCommandArgs,
): GitWorkspaceDeliveryCommands {
  const ident =
    `-c ${shellQuote('user.name=cap-bot')} -c ${shellQuote(
      'user.email=cap-bot@users.noreply.github.com',
    )}`;
  const msgPath = '/tmp/cap-commit-msg';
  const commitMessageB64 = Buffer.from(args.commitMessage, 'utf8').toString('base64');
  return {
    status: `git -C ${shellQuote(args.workspaceDir)} status --porcelain`,
    writeCommitMessage: `printf %s ${shellQuote(commitMessageB64)} | base64 -d > ${shellQuote(
      msgPath,
    )}`,
    commit:
      `git -C ${shellQuote(args.workspaceDir)} checkout -B ${shellQuote(args.branch)} && ` +
      `git -C ${shellQuote(args.workspaceDir)} add -A && ` +
      `git -C ${shellQuote(args.workspaceDir)} ${ident} commit -F ${shellQuote(msgPath)}`,
    revParse: `git -C ${shellQuote(args.workspaceDir)} rev-parse HEAD`,
    push:
      `git -C ${shellQuote(args.workspaceDir)} -c ${shellQuote(
        `http.extraHeader=${args.authHeader}`,
      )} push --force-with-lease origin ${shellQuote(args.branch)}`,
  };
}

export function scrubSandboxExecSecrets(output: string): string {
  return scrubSandboxCommandOutput(output);
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export function parseSandboxExecResult(raw: unknown): SandboxExecResult {
  const result = normalizeSandboxCommandResult(raw);
  return { exitCode: result.exitCode, output: result.output };
}

function singleQuoteValue(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function shellQuote(value: string): string {
  return `'${singleQuoteValue(value)}'`;
}
