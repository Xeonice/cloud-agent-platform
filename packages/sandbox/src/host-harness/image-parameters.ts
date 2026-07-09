import type { SandboxCommandExecutor } from '@cap/sandbox-core';

export const SANDBOX_IMAGE_ENV_DIR = '/home/gem/.cap';
export const SANDBOX_IMAGE_ENV_PATH = `${SANDBOX_IMAGE_ENV_DIR}/image-env`;
export const SANDBOX_IMAGE_PARAMETER_TIMEOUT_MS = 10_000;

export interface SandboxHostImageParameter {
  readonly name: string;
  readonly value: string;
  readonly secret?: boolean;
}

export interface SandboxHostImageParameterProfile {
  readonly parameters: readonly SandboxHostImageParameter[];
}

export interface SandboxImageParameterSetupCommand {
  readonly command: string;
  readonly tolerateUnresolvedExit: boolean;
}

export function buildSandboxImageParameterSetupCommands(
  profile: SandboxHostImageParameterProfile | null | undefined,
): readonly SandboxImageParameterSetupCommand[] {
  const parameters = normalizeParameters(profile);
  if (parameters.length === 0) return [];
  const envFile = parameters
    .map((parameter) => `export ${parameter.name}=${shellQuote(parameter.value)}`)
    .join('\n') + '\n';
  const envB64 = Buffer.from(envFile, 'utf8').toString('base64');
  return [
    {
      command:
        `mkdir -p '${SANDBOX_IMAGE_ENV_DIR}' && ` +
        `printf %s '${envB64}' | base64 -d > '${SANDBOX_IMAGE_ENV_PATH}' && ` +
        `chmod 600 '${SANDBOX_IMAGE_ENV_PATH}'`,
      tolerateUnresolvedExit: false,
    },
  ];
}

export function buildSandboxImageParameterCleanupCommands(): readonly string[] {
  return [`rm -f '${SANDBOX_IMAGE_ENV_PATH}' 2>/dev/null; true`];
}

export function scrubSandboxImageParameterSecrets(
  output: string,
  profile: SandboxHostImageParameterProfile | null | undefined,
): string {
  const secrets = normalizeParameters(profile).filter((parameter) => parameter.secret);
  if (secrets.length === 0 || output.length === 0) return output;
  let scrubbed = output;
  for (const parameter of secrets) {
    scrubbed = scrubLiteral(scrubbed, parameter.value);
    scrubbed = scrubLiteral(
      scrubbed,
      Buffer.from(parameter.value, 'utf8').toString('base64'),
    );
  }
  return scrubbed;
}

export async function removeSandboxImageParameterFileBestEffort(args: {
  readonly executor: SandboxCommandExecutor;
  readonly warn?: (message: string) => void;
  readonly taskId: string;
}): Promise<void> {
  for (const command of buildSandboxImageParameterCleanupCommands()) {
    try {
      const result = await args.executor.exec({
        command,
        timeoutMs: SANDBOX_IMAGE_PARAMETER_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        args.warn?.(
          `image parameter cleanup for task ${args.taskId} exited ${result.exitCode} (not fatal)`,
        );
      }
    } catch (err) {
      args.warn?.(
        `image parameter cleanup for task ${args.taskId} failed (not fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function normalizeParameters(
  profile: SandboxHostImageParameterProfile | null | undefined,
): readonly SandboxHostImageParameter[] {
  const seen = new Set<string>();
  const parameters: SandboxHostImageParameter[] = [];
  for (const parameter of profile?.parameters ?? []) {
    if (!isValidEnvName(parameter.name) || seen.has(parameter.name)) continue;
    seen.add(parameter.name);
    parameters.push(parameter);
  }
  return parameters;
}

function isValidEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function scrubLiteral(output: string, value: string): string {
  if (!value) return output;
  return output.split(value).join('***');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
