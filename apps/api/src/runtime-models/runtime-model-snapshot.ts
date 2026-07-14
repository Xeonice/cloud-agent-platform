import {
  RuntimeExecutionEnvironmentSnapshotSchema,
  SandboxMetadataSchema,
  type Runtime,
  type RuntimeExecutionEnvironmentSnapshot,
} from '@cap/contracts';
import { sha256Revision } from './runtime-model-catalog.util';

export function buildRuntimeExecutionEnvironmentSnapshot(
  input: Omit<
    RuntimeExecutionEnvironmentSnapshot,
    'fingerprint' | 'sandboxMetadataChecksum'
  >,
): RuntimeExecutionEnvironmentSnapshot {
  const sandboxMetadata = SandboxMetadataSchema.parse(input.sandboxMetadata);
  const sandboxMetadataChecksum = sha256Revision(sandboxMetadata);
  const base = { ...input, sandboxMetadata, sandboxMetadataChecksum };
  return RuntimeExecutionEnvironmentSnapshotSchema.parse({
    ...base,
    fingerprint: sha256Revision(snapshotFingerprintInput(base)),
  });
}

/** Revalidates persisted non-secret evidence before it can drive provisioning. */
export function validateRuntimeExecutionEnvironmentSnapshot(
  runtime: Runtime,
  input: unknown,
): RuntimeExecutionEnvironmentSnapshot {
  const snapshot = RuntimeExecutionEnvironmentSnapshotSchema.parse(input);
  if (
    snapshot.sandboxMetadataChecksum !==
      sha256Revision(snapshot.sandboxMetadata) ||
    snapshot.sandboxMetadata.dependencies[runtime] !== snapshot.cliVersion ||
    snapshot.fingerprint !== sha256Revision(snapshotFingerprintInput(snapshot))
  ) {
    throw new Error('Runtime execution environment snapshot integrity failed');
  }
  return snapshot;
}

export function snapshotFingerprintInput(
  snapshot: Pick<
    RuntimeExecutionEnvironmentSnapshot,
    | 'kind'
    | 'managedEnvironmentId'
    | 'validationId'
    | 'validationContractVersion'
    | 'provider'
    | 'providerFamily'
    | 'source'
    | 'immutableIdentity'
    | 'sandboxMetadataChecksum'
    | 'cliVersion'
    | 'cliArtifactChecksum'
  >,
) {
  return {
    kind: snapshot.kind,
    managedEnvironmentId: snapshot.managedEnvironmentId,
    validationId: snapshot.validationId,
    validationContractVersion: snapshot.validationContractVersion,
    provider: snapshot.provider,
    providerFamily: snapshot.providerFamily,
    source: snapshot.source,
    immutableIdentity: snapshot.immutableIdentity,
    sandboxMetadataChecksum: snapshot.sandboxMetadataChecksum,
    cliVersion: snapshot.cliVersion,
    cliArtifactChecksum: snapshot.cliArtifactChecksum,
  };
}
