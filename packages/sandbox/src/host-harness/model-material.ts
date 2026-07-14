import { TaskModelSelectorSchema } from '@cap/contracts';
import {
  SandboxRuntimeModelSetupError,
  TASK_MODEL_MATERIAL_PATH,
  taskModelLaunchMaterial,
  type SandboxCommandExecutor,
  type TaskModelIntent,
  type TaskModelLaunchMaterial,
} from '@cap/sandbox-core';

export const TASK_MODEL_MATERIAL_TIMEOUT_MS = 10_000;
const TASK_MODEL_MATERIAL_DIR = '/home/gem/.cap';
const TASK_MODEL_MATERIAL_TEMP_PATH = `${TASK_MODEL_MATERIAL_PATH}.tmp`;

export interface TaskModelMaterialCommand {
  readonly command: string;
  readonly timeoutMs: number;
}

/**
 * Build bounded provider-neutral file commands. The selector itself is present
 * only as base64 data; the nested launch command later receives only path and
 * checksum metadata.
 */
export function buildTaskModelMaterialCommands(
  intent: TaskModelIntent,
): readonly TaskModelMaterialCommand[] {
  if (intent.kind === 'runtime-default') return [];
  const parsed = TaskModelSelectorSchema.safeParse(intent.selector);
  if (!parsed.success) {
    throw new SandboxRuntimeModelSetupError('material-write');
  }
  const selector = parsed.data;
  const encoded = Buffer.from(selector, 'utf8').toString('base64');
  const material = taskModelLaunchMaterial({ kind: 'explicit', selector });
  if (material.kind !== 'explicit') {
    throw new SandboxRuntimeModelSetupError('material-write');
  }
  const expected = material.checksum.slice('sha256:'.length);
  return [
    {
      command:
        `command -v base64 >/dev/null 2>&1 && ` +
        `command -v sha256sum >/dev/null 2>&1 && ` +
        `umask 077 && mkdir -p '${TASK_MODEL_MATERIAL_DIR}' && ` +
        `tmp='${TASK_MODEL_MATERIAL_TEMP_PATH}' && rm -f "$tmp" && ` +
        `trap 'rm -f "$tmp"' EXIT HUP INT TERM && ` +
        `printf %s '${encoded}' | base64 -d > "$tmp" && ` +
        `chmod 600 "$tmp" && test -r "$tmp" && test -s "$tmp" && ` +
        `actual="$(sha256sum "$tmp" | awk '{ print $1; exit }')" && ` +
        `test "$actual" = '${expected}' && ` +
        `mv -f "$tmp" '${TASK_MODEL_MATERIAL_PATH}' && ` +
        `trap - EXIT HUP INT TERM`,
      timeoutMs: TASK_MODEL_MATERIAL_TIMEOUT_MS,
    },
    buildTaskModelMaterialVerificationCommand(material),
  ];
}

export function buildTaskModelMaterialVerificationCommand(
  material: Extract<TaskModelLaunchMaterial, { kind: 'explicit' }>,
): TaskModelMaterialCommand {
  const expected = material.checksum.slice('sha256:'.length);
  return {
    command:
      `test -r '${material.path}' && test -s '${material.path}' && ` +
      `actual="$(sha256sum '${material.path}' | awk '{ print $1; exit }')" && ` +
      `test "$actual" = '${expected}'`,
    timeoutMs: TASK_MODEL_MATERIAL_TIMEOUT_MS,
  };
}

/** Write, atomically install, and independently verify explicit model material. */
export async function materializeTaskModel(
  executor: SandboxCommandExecutor,
  intent: TaskModelIntent,
): Promise<TaskModelLaunchMaterial> {
  if (intent.kind === 'runtime-default') return intent;
  let commands: readonly TaskModelMaterialCommand[];
  try {
    commands = buildTaskModelMaterialCommands(intent);
  } catch {
    throw new SandboxRuntimeModelSetupError('material-write');
  }
  let index = 0;
  for (const command of commands) {
    try {
      const result = await executor.exec(command);
      if (
        result.timedOut ||
        !Number.isFinite(result.exitCode) ||
        result.exitCode !== 0
      ) {
        await cleanupFailedTaskModelMaterial(executor);
        throw new SandboxRuntimeModelSetupError(
          index === 0 ? 'material-write' : 'material-verify',
        );
      }
    } catch (error) {
      if (error instanceof SandboxRuntimeModelSetupError) throw error;
      await cleanupFailedTaskModelMaterial(executor);
      throw new SandboxRuntimeModelSetupError(
        index === 0 ? 'material-write' : 'material-verify',
      );
    }
    index += 1;
  }
  return taskModelLaunchMaterial(intent);
}

/** Verify an already materialized selector without reading it into the host. */
export async function verifyTaskModelMaterial(
  executor: SandboxCommandExecutor,
  intent: TaskModelIntent,
): Promise<TaskModelLaunchMaterial> {
  if (intent.kind === 'runtime-default') return intent;
  let material: TaskModelLaunchMaterial;
  try {
    TaskModelSelectorSchema.parse(intent.selector);
    material = taskModelLaunchMaterial(intent);
  } catch {
    throw new SandboxRuntimeModelSetupError('material-verify');
  }
  if (material.kind !== 'explicit') {
    throw new SandboxRuntimeModelSetupError('material-verify');
  }
  try {
    const result = await executor.exec(
      buildTaskModelMaterialVerificationCommand(material),
    );
    if (
      result.timedOut ||
      !Number.isFinite(result.exitCode) ||
      result.exitCode !== 0
    ) {
      throw new SandboxRuntimeModelSetupError('material-verify');
    }
  } catch (error) {
    if (error instanceof SandboxRuntimeModelSetupError) throw error;
    throw new SandboxRuntimeModelSetupError('material-verify');
  }
  return material;
}

async function cleanupFailedTaskModelMaterial(
  executor: SandboxCommandExecutor,
): Promise<void> {
  try {
    const result = await executor.exec({
      command:
        `rm -f '${TASK_MODEL_MATERIAL_TEMP_PATH}' ` +
        `'${TASK_MODEL_MATERIAL_PATH}'`,
      timeoutMs: TASK_MODEL_MATERIAL_TIMEOUT_MS,
    });
    if (
      result.timedOut ||
      !Number.isFinite(result.exitCode) ||
      result.exitCode !== 0
    ) {
      throw new SandboxRuntimeModelSetupError('material-write');
    }
  } catch {
    throw new SandboxRuntimeModelSetupError('material-write');
  }
}
