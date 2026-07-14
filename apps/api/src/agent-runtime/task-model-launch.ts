import {
  SandboxRuntimeModelSetupError,
  TASK_MODEL_MATERIAL_PATH,
  type TaskModelLaunchMaterial,
} from '@cap/sandbox';

const SHA256_CHECKSUM_RE = /^sha256:([0-9a-f]{64})$/;

export interface ExplicitTaskModelShellMaterial {
  /**
   * Fixed-text shell guard that rechecks the already-materialized selector and
   * loads it into `M`. It contains only the fixed path and expected digest; the
   * selector itself never enters the generated command.
   */
  readonly guard: string;
  /** Exactly one shell-quoted CLI argument. */
  readonly argument: '--model "$M"';
}

/**
 * Convert the launch-layer material descriptor into safe shell fragments.
 * The runtime-default branch deliberately returns null so existing builders can
 * take their original byte-identical path.
 */
export function explicitTaskModelShellMaterial(
  material: TaskModelLaunchMaterial,
): ExplicitTaskModelShellMaterial | null {
  if (material.kind === 'runtime-default') return null;
  const checksum = SHA256_CHECKSUM_RE.exec(material.checksum);
  if (material.path !== TASK_MODEL_MATERIAL_PATH || !checksum) {
    throw new SandboxRuntimeModelSetupError('material-verify');
  }
  const digest = checksum[1];
  return {
    guard:
      `test -r ${TASK_MODEL_MATERIAL_PATH} && ` +
      `test -s ${TASK_MODEL_MATERIAL_PATH} && ` +
      `M="$(cat ${TASK_MODEL_MATERIAL_PATH})" && ` +
      `test -n "$M" && ` +
      `actual="$(printf %s "$M" | sha256sum)" && ` +
      `actual="\${actual%% *}" && ` +
      `test "$actual" = "${digest}" && `,
    argument: '--model "$M"',
  };
}
