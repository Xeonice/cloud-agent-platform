import {
  createSandboxRuntimePrivateFile,
  type SandboxCommandExecutor,
  type SandboxRuntimePrivateFile,
} from '@cap/sandbox-core';

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
  /** Opaque files consumed only by the selected provider's private archive port. */
  readonly privateFiles: readonly SandboxRuntimePrivateFile[];
}

export function buildSandboxImageParameterSetupCommands(
  profile: SandboxHostImageParameterProfile | null | undefined,
): readonly SandboxImageParameterSetupCommand[] {
  const parameters = normalizeParameters(profile);
  if (parameters.length === 0) return [];
  const envFile = parameters
    .map((parameter) => `export ${parameter.name}=${shellQuote(parameter.value)}`)
    .join('\n') + '\n';
  return [
    {
      command:
        `test -s '${SANDBOX_IMAGE_ENV_PATH}' && ` +
        `test "$(stat -c %a '${SANDBOX_IMAGE_ENV_PATH}')" = 600`,
      tolerateUnresolvedExit: false,
      privateFiles: [
        createSandboxRuntimePrivateFile(SANDBOX_IMAGE_ENV_PATH, envFile),
      ],
    },
  ];
}

export function buildSandboxImageParameterCleanupCommands(): readonly string[] {
  return [
    `rm -f '${SANDBOX_IMAGE_ENV_PATH}' && ` +
      `test ! -e '${SANDBOX_IMAGE_ENV_PATH}'`,
  ];
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
  try {
    await removeSandboxImageParameterFile(args);
  } catch (err) {
    args.warn?.(
      `image parameter cleanup for task ${args.taskId} failed (not fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Remove the private image environment and prove absence. AIO retention calls
 * this strict form: failure must force removal of the whole sandbox instead of
 * stopping and retaining a token-bearing filesystem.
 */
export async function removeSandboxImageParameterFile(args: {
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
}): Promise<void> {
  for (const command of buildSandboxImageParameterCleanupCommands()) {
    let result;
    try {
      result = await args.executor.exec({
        command,
        timeoutMs: SANDBOX_IMAGE_PARAMETER_TIMEOUT_MS,
      });
    } catch {
      throw new Error(
        `image parameter cleanup for task ${args.taskId} did not settle`,
      );
    }
    if (result.exitCode !== 0 || result.timedOut === true) {
      throw new Error(
        `image parameter cleanup for task ${args.taskId} was not confirmed`,
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
