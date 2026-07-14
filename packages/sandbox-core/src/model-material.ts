import { createHash } from 'node:crypto';

/** Fixed inside a task-isolated sandbox; never derived from operator input. */
export const TASK_MODEL_MATERIAL_PATH = '/home/gem/.cap/task-model.txt';

export type TaskModelIntent =
  | { readonly kind: 'runtime-default' }
  | { readonly kind: 'explicit'; readonly selector: string };

/**
 * The only model information a runtime launch builder receives. The raw
 * selector remains in the task/provisioning layer and never enters nested shell
 * construction.
 */
export type TaskModelLaunchMaterial =
  | { readonly kind: 'runtime-default' }
  | {
      readonly kind: 'explicit';
      readonly path: typeof TASK_MODEL_MATERIAL_PATH;
      readonly checksum: `sha256:${string}`;
    };

export function taskModelLaunchMaterial(
  intent: TaskModelIntent,
): TaskModelLaunchMaterial {
  if (intent.kind === 'runtime-default') return intent;
  const digest = createHash('sha256')
    .update(Buffer.from(intent.selector, 'utf8'))
    .digest('hex');
  return {
    kind: 'explicit',
    path: TASK_MODEL_MATERIAL_PATH,
    checksum: `sha256:${digest}`,
  };
}
