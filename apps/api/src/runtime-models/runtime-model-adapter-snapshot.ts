import type { RuntimeExecutionEnvironmentSnapshot } from '@cap/contracts';

/** Recheck the immutable snapshot at the adapter boundary before discovery. */
export function assertRuntimeModelAdapterSnapshot(
  snapshot: RuntimeExecutionEnvironmentSnapshot,
  runtime: 'codex' | 'claude-code',
): void {
  const declared = snapshot.sandboxMetadata.dependencies[runtime];
  if (
    !declared ||
    declared !== snapshot.cliVersion ||
    !snapshot.cliArtifactChecksum.startsWith('sha256:')
  ) {
    throw new Error('Runtime model environment snapshot is incompatible.');
  }
}
