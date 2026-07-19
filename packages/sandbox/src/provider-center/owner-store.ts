import type {
  AcquireSandboxRunOwnerArgs,
  AcquireSandboxRunOwnerResult,
  BeginSandboxCleanupAttemptResult,
  BeginSandboxRunCreateArgs,
  BeginSandboxRunCleanupResult,
  ClaimSandboxRunCleanupResult,
  CloseLegacySandboxRunCreateFenceArgs,
  ConfirmSandboxRunCleanupOrphanArgs,
  ConfirmSandboxRunCleanupOrphanResult,
  FailSandboxRunCleanupByTerminalPolicyResult,
  JoinSandboxRunCleanupArgs,
  JoinSandboxRunCleanupResult,
  ObserveSandboxRunCreateArgs,
  RecordSandboxRunOwnerArgs,
  SandboxCleanupAttemptEvidence,
  SandboxOwnershipFence,
  SandboxRunCleanupAuthorityProjection,
  SandboxRunCleanupAuthorization,
  SandboxRunOwnerRecord,
  SandboxRunOwnerStatus,
  SandboxRunOwnerStore,
  SettleLegacySandboxRunCleanupArgs,
  SettleLegacySandboxRunCleanupResult,
  SettleSandboxCleanupAttemptResult,
  ValidateLegacySandboxRunCreateFenceArgs,
} from '@cap/sandbox-core';
import {
  SANDBOX_CLEANUP_ATTEMPT_MAX,
  sandboxCleanupAttemptPlaceholder,
  validateSandboxCleanupAttemptEvidence,
  validateSandboxCleanupAttemptId,
} from '@cap/sandbox-core';

export class InMemorySandboxRunOwnerStore implements SandboxRunOwnerStore {
  private readonly records = new Map<string, SandboxRunOwnerRecord>();

  async getSandboxRunOwner(taskId: string): Promise<SandboxRunOwnerRecord | null> {
    const record = this.records.get(taskId);
    return record && (record.status === 'provisioning' || record.status === 'running')
      ? record
      : null;
  }

  async getSandboxRunCleanupAuthority(
    taskId: string,
  ): Promise<SandboxRunCleanupAuthorityProjection> {
    return cleanupAuthorityProjection(this.records.get(taskId));
  }

  async listActiveSandboxRunOwners(): Promise<readonly SandboxRunOwnerRecord[]> {
    return [...this.records.values()].filter((record) =>
      record.status === 'provisioning' || record.status === 'running'
    );
  }

  async recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void> {
    const existing = this.records.get(args.taskId);
    if (args.expectedProvisioningFence === 'legacy-create-observed') {
      if (
        args.ownership ||
        (args.status !== undefined && args.status !== 'running') ||
        !existing ||
        existing.ownership ||
        existing.status !== 'provisioning' ||
        existing.createState !== 'idle' ||
        existing.providerId !== args.providerId ||
        (existing.providerSandboxId !== undefined &&
          args.providerSandboxId !== undefined &&
          existing.providerSandboxId !== args.providerSandboxId)
      ) {
        throw new Error('Legacy sandbox provisioning fence is no longer current');
      }
    }
    if (args.ownership) {
      if (
        !existing?.ownership ||
        existing.status === 'deleting' ||
        existing.ownership.ownerGeneration !== args.ownership.ownerGeneration ||
        existing.ownership.resourceGeneration !==
          args.ownership.resourceGeneration
      ) {
        throw new Error('Sandbox owner generation is no longer current');
      }
    } else if (existing && (existing.status === 'deleting' || existing.ownership)) {
      throw new Error('Ownerless sandbox records cannot replace a durable owner');
    }
    const {
      providerSandboxId,
      expectedProvisioningFence: _expectedProvisioningFence,
      ...record
    } = args;
    const providerIdentityChanged =
      providerSandboxId !== undefined &&
      providerSandboxId !== existing?.providerSandboxId;
    this.records.set(args.taskId, {
      ...existing,
      ...record,
      ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
      createState: 'idle',
      status:
        args.status ??
        (args.expectedProvisioningFence === 'legacy-create-observed'
          ? 'running'
          : existing?.status ?? 'running'),
      cleanupAttemptInFlight: existing?.cleanupAttemptInFlight ?? false,
      cleanupAttemptCount: existing?.cleanupAttemptCount ?? 0,
      ...(providerIdentityChanged
        ? { cleanupOrphanConfirmedAt: undefined }
        : existing?.cleanupOrphanConfirmedAt
          ? { cleanupOrphanConfirmedAt: existing.cleanupOrphanConfirmedAt }
          : {}),
    });
  }

  async acquireSandboxRunOwner(
    args: AcquireSandboxRunOwnerArgs,
  ): Promise<AcquireSandboxRunOwnerResult> {
    const stored = this.records.get(args.taskId);
    const existing =
      stored && ['provisioning', 'running', 'deleting'].includes(stored.status)
        ? stored
        : undefined;
    if (existing?.status === 'deleting') {
      return { kind: 'cleanup-required', owner: existing };
    }
    if (existing && existing.providerId !== args.providerId) {
      return { kind: 'conflict', owner: existing };
    }
    if (existing && !existing.ownership) {
      return { kind: 'cleanup-required', owner: existing };
    }
    const ownership = Object.freeze({
      ownerGeneration: args.ownerGeneration,
      resourceGeneration:
        existing?.ownership?.resourceGeneration ?? args.proposedResourceGeneration,
    });
    this.records.set(args.taskId, {
      ...existing,
      taskId: args.taskId,
      providerId: args.providerId,
      ownership,
      createState: existing?.createState ?? 'idle',
      status: 'provisioning',
      cleanupAttemptInFlight: existing?.cleanupAttemptInFlight ?? false,
      cleanupAttemptCount: existing?.cleanupAttemptCount ?? 0,
      ...(existing?.ownership?.resourceGeneration ===
        ownership.resourceGeneration && existing.cleanupOrphanConfirmedAt
        ? { cleanupOrphanConfirmedAt: existing.cleanupOrphanConfirmedAt }
        : {}),
    });
    return {
      kind: 'acquired',
      ownership,
      ...(existing ? { previousOwner: existing } : {}),
    };
  }

  async beginSandboxRunCreate(args: BeginSandboxRunCreateArgs): Promise<boolean> {
    const existing = this.records.get(args.taskId);
    if (!args.ownership) {
      if (!existing) {
        this.records.set(args.taskId, {
          taskId: args.taskId,
          providerId: args.providerId,
          createState: 'entered',
          status: 'provisioning',
          cleanupAttemptInFlight: false,
          cleanupAttemptCount: 0,
        });
        return true;
      }
      // One invocation owns one durable pre-call fence. A second process must
      // not treat the first invocation's `entered` row as its own admission.
      return false;
    }
    if (
      !existing?.ownership ||
      existing.status !== 'provisioning' ||
      existing.providerId !== args.providerId ||
      existing.ownership.ownerGeneration !== args.ownership.ownerGeneration ||
      existing.ownership.resourceGeneration !== args.ownership.resourceGeneration
    ) {
      return false;
    }
    this.records.set(args.taskId, {
      ...existing,
      createState: 'entered',
    });
    return true;
  }

  async validateLegacySandboxRunCreateFence(
    args: ValidateLegacySandboxRunCreateFenceArgs,
  ): Promise<boolean> {
    const existing = this.records.get(args.taskId);
    return (
      existing !== undefined &&
      existing.ownership === undefined &&
      existing.status === 'provisioning' &&
      existing.providerId === args.providerId &&
      existing.createState === 'entered'
    );
  }

  async observeSandboxRunCreate(
    args: ObserveSandboxRunCreateArgs,
  ): Promise<boolean> {
    const existing = this.records.get(args.taskId);
    if (args.resourceGeneration === undefined) {
      if (
        !existing ||
        existing.ownership ||
        !['provisioning', 'deleting'].includes(existing.status) ||
        existing.providerId !== args.providerId ||
        existing.createState !== 'entered'
      ) {
        return false;
      }
      this.records.set(args.taskId, {
        ...existing,
        createState: 'idle',
        ...(args.providerSandboxId === undefined
          ? {}
          : { providerSandboxId: args.providerSandboxId }),
        ...(args.providerSandboxId !== undefined &&
        args.providerSandboxId !== existing.providerSandboxId
          ? { cleanupOrphanConfirmedAt: undefined }
          : {}),
      });
      return existing.status === 'provisioning';
    }
    if (
      !existing?.ownership ||
      !['provisioning', 'running', 'deleting'].includes(existing.status) ||
      existing.providerId !== args.providerId ||
      existing.ownership.resourceGeneration !== args.resourceGeneration ||
      (existing.createState === 'idle' &&
        args.providerSandboxId !== undefined &&
        existing.providerSandboxId !== undefined &&
        existing.providerSandboxId !== args.providerSandboxId)
    ) {
      return false;
    }
    this.records.set(args.taskId, {
      ...existing,
      createState: 'idle',
      ...(args.providerSandboxId === undefined
        ? {}
        : { providerSandboxId: args.providerSandboxId }),
      ...(args.providerSandboxId !== undefined &&
      args.providerSandboxId !== existing.providerSandboxId
        ? { cleanupOrphanConfirmedAt: undefined }
        : {}),
    });
    return true;
  }

  async closeLegacySandboxRunCreateFence(
    args: CloseLegacySandboxRunCreateFenceArgs,
  ): Promise<boolean> {
    const existing = this.records.get(args.taskId);
    if (
      !existing ||
      existing.ownership ||
      existing.status !== 'deleting' ||
      existing.providerId !== args.providerId ||
      (existing.providerSandboxId !== undefined &&
        args.providerSandboxId !== undefined &&
        existing.providerSandboxId !== args.providerSandboxId)
    ) {
      return false;
    }
    if (existing.createState === 'idle') return true;
    if (existing.createState !== 'entered') return false;
    this.records.set(args.taskId, {
      ...existing,
      createState: 'idle',
    });
    return true;
  }

  async beginSandboxRunCleanup(
    taskId: string,
    ownership?: SandboxOwnershipFence,
  ): Promise<BeginSandboxRunCleanupResult> {
    const existing = this.records.get(taskId);
    if (!existing) {
      return { kind: 'absent' };
    }
    if (isSettledOwner(existing)) return { kind: 'settled', owner: existing };
    if (
      (ownership &&
        (!existing.ownership ||
          existing.ownership.ownerGeneration !== ownership.ownerGeneration ||
          existing.ownership.resourceGeneration !== ownership.resourceGeneration)) ||
      (!ownership && existing.ownership)
    ) {
      return { kind: 'stale' };
    }
    const deleting = { ...existing, status: 'deleting' as const };
    this.records.set(taskId, deleting);
    return {
      kind: 'authorized',
      owner: deleting,
      authorization: cleanupAuthorizationFor(deleting),
    };
  }

  async claimSandboxRunCleanup(
    taskId: string,
    ownerGeneration: string,
  ): Promise<ClaimSandboxRunCleanupResult> {
    const existing = this.records.get(taskId);
    if (!existing) {
      return { kind: 'absent' };
    }
    if (isSettledOwner(existing)) return { kind: 'settled', owner: existing };
    const isTakeover = existing.ownership
      ? existing.ownership.ownerGeneration !== ownerGeneration
      : false;
    const settledExisting =
      isTakeover && existing.cleanupAttemptInFlight === true
        ? { ...existing, cleanupAttemptInFlight: false }
        : existing;
    const owner: SandboxRunOwnerRecord = settledExisting.ownership
      ? {
          ...settledExisting,
          status: 'deleting',
          ownership: Object.freeze({
            ownerGeneration,
            resourceGeneration: settledExisting.ownership.resourceGeneration,
          }),
        }
      : { ...settledExisting, status: 'deleting' };
    this.records.set(taskId, owner);
    return {
      kind: 'authorized',
      owner,
      authorization: cleanupAuthorizationFor(owner),
    };
  }

  async joinSandboxRunCleanup(
    args: JoinSandboxRunCleanupArgs,
  ): Promise<JoinSandboxRunCleanupResult> {
    const existing = this.records.get(args.taskId);
    if (!existing) {
      return { kind: 'absent' };
    }
    if (isSettledOwner(existing)) return { kind: 'settled', owner: existing };
    if (existing.providerId !== args.providerId || !existing.ownership) {
      return { kind: 'conflict' };
    }
    if (existing.ownership.resourceGeneration !== args.ownership.resourceGeneration) {
      return { kind: 'stale' };
    }
    if (
      existing.status !== 'deleting' &&
      existing.ownership.ownerGeneration !== args.ownership.ownerGeneration
    ) {
      return { kind: 'stale' };
    }
    const owner = { ...existing, status: 'deleting' as const };
    this.records.set(args.taskId, owner);
    const authorization = cleanupAuthorizationFor(owner);
    if (authorization.kind !== 'generation') {
      return { kind: 'conflict' };
    }
    return { kind: 'authorized', owner, authorization };
  }

  async completeSandboxRunCleanup(
    authorization: SandboxRunCleanupAuthorization,
    status: 'removed' | 'terminal',
  ): Promise<boolean> {
    const existing = this.records.get(authorization.taskId);
    if (
      !existing ||
      existing.status !== 'deleting' ||
      existing.providerId !== authorization.providerId ||
      existing.createState !== 'idle' ||
      existing.cleanupAttemptInFlight === true ||
      !hasConfirmedCleanupEvidence(existing) ||
      !cleanupAuthorizationMatches(existing, authorization)
    ) {
      return false;
    }
    this.records.set(authorization.taskId, { ...existing, status });
    return true;
  }

  async beginSandboxRunCleanupAttempt(
    authorization: SandboxRunCleanupAuthorization,
    attemptId: string,
  ): Promise<BeginSandboxCleanupAttemptResult> {
    validateSandboxCleanupAttemptId(attemptId);
    const existing = this.records.get(authorization.taskId);
    if (
      !existing ||
      existing.status !== 'deleting' ||
      existing.providerId !== authorization.providerId ||
      !cleanupAttemptAuthorizationMatches(existing, authorization)
    ) {
      return { kind: 'stale' };
    }
    const current = cleanupEvidenceForOwner(existing);
    if (current && current.attemptId === attemptId) {
      return { kind: 'replayed', evidence: current };
    }
    if (existing.cleanupAttemptInFlight === true) {
      return current
        ? { kind: 'in-flight', evidence: current }
        : { kind: 'conflict' };
    }
    const attempt = existing.cleanupAttemptCount ?? 0;
    if (attempt >= SANDBOX_CLEANUP_ATTEMPT_MAX) {
      return { kind: 'conflict' };
    }
    const evidence = sandboxCleanupAttemptPlaceholder(attempt + 1, attemptId);
    this.records.set(authorization.taskId, {
      ...existing,
      cleanupAttemptInFlight: true,
      cleanupAttemptCount: evidence.attempt,
      cleanupLastAttemptId: evidence.attemptId,
      cleanupLastOutcome: evidence.outcome,
      cleanupLastProof: evidence.proof,
      cleanupLastCause: evidence.cause,
      cleanupLastRetryable: evidence.retryable,
      cleanupLastObservedAt: evidence.observedAt,
    });
    return { kind: 'allocated', evidence };
  }

  async settleSandboxRunCleanupAttempt(
    authorization: SandboxRunCleanupAuthorization,
    evidence: SandboxCleanupAttemptEvidence,
  ): Promise<SettleSandboxCleanupAttemptResult> {
    const candidate = validateSandboxCleanupAttemptEvidence(evidence);
    const existing = this.records.get(authorization.taskId);
    if (
      !existing ||
      existing.status !== 'deleting' ||
      existing.providerId !== authorization.providerId ||
      !cleanupAttemptAuthorizationMatches(existing, authorization)
    ) {
      return { kind: 'stale' };
    }
    const attemptCount = existing.cleanupAttemptCount ?? 0;
    if (candidate.attempt < attemptCount) return { kind: 'stale' };
    if (
      candidate.attempt !== attemptCount ||
      candidate.attemptId !== existing.cleanupLastAttemptId
    ) {
      return { kind: 'conflict' };
    }
    if (
      candidate.outcome === 'succeeded' &&
      existing.createState !== 'idle'
    ) {
      return { kind: 'conflict' };
    }
    if (existing.cleanupAttemptInFlight !== true) {
      return sameCleanupEvidence(existing, candidate)
        ? { kind: 'replayed' }
        : { kind: 'conflict' };
    }
    this.records.set(authorization.taskId, {
      ...existing,
      cleanupAttemptInFlight: false,
      cleanupLastOutcome: candidate.outcome,
      cleanupLastProof: candidate.proof,
      cleanupLastCause: candidate.cause,
      cleanupLastRetryable: candidate.retryable,
      cleanupLastObservedAt: candidate.observedAt,
    });
    return { kind: 'recorded' };
  }

  async failSandboxRunCleanupByTerminalPolicy(
    authorization: Extract<
      SandboxRunCleanupAuthorization,
      { readonly kind: 'generation' }
    >,
    expectedAttempt: number,
  ): Promise<FailSandboxRunCleanupByTerminalPolicyResult> {
    if (
      !Number.isSafeInteger(expectedAttempt) ||
      expectedAttempt < 1 ||
      expectedAttempt > SANDBOX_CLEANUP_ATTEMPT_MAX
    ) {
      return { kind: 'conflict' };
    }
    const existing = this.records.get(authorization.taskId);
    if (!existing) return { kind: 'stale' };
    if (existing.status === 'failed') {
      return terminalPolicyMatches(existing, authorization, expectedAttempt)
        ? {
            kind: 'replayed',
            owner: { ...existing, status: 'failed' as const },
          }
        : { kind: 'stale' };
    }
    if (
      existing.status !== 'deleting' ||
      !terminalPolicyMatches(existing, authorization, expectedAttempt)
    ) {
      return { kind: 'stale' };
    }
    if (
      existing.cleanupAttemptInFlight === true ||
      existing.cleanupLastOutcome === undefined ||
      existing.cleanupLastOutcome === 'succeeded'
    ) {
      return { kind: 'conflict' };
    }
    const failed = { ...existing, status: 'failed' as const };
    this.records.set(authorization.taskId, failed);
    return { kind: 'failed', owner: failed };
  }

  async settleLegacySandboxRunCleanup(
    args: SettleLegacySandboxRunCleanupArgs,
  ): Promise<SettleLegacySandboxRunCleanupResult> {
    const evidence = validateSandboxCleanupAttemptEvidence(args.evidence);
    if (
      !legacySettlementStatusMatches(
        args.status,
        args.disposition,
        evidence,
      )
    ) {
      return { kind: 'conflict' };
    }
    const existing = this.records.get(args.taskId);
    if (!existing || existing.providerId !== args.providerId) {
      return { kind: 'stale' };
    }
    if (isSettledOwner(existing)) {
      return existing.status === args.status &&
        sameCleanupEvidence(existing, evidence)
        ? { kind: 'replayed', owner: existing }
        : { kind: 'stale' };
    }
    if (
      existing.ownership ||
      existing.status === 'deleting' ||
      existing.cleanupAttemptInFlight === true ||
      (evidence.outcome === 'succeeded' && existing.createState !== 'idle') ||
      evidence.attempt !== (existing.cleanupAttemptCount ?? 0) + 1
    ) {
      return { kind: 'conflict' };
    }
    const settled = {
      ...existing,
      status: args.status,
      cleanupAttemptInFlight: false,
      cleanupAttemptCount: evidence.attempt,
      cleanupLastAttemptId: evidence.attemptId,
      cleanupLastOutcome: evidence.outcome,
      cleanupLastProof: evidence.proof,
      cleanupLastCause: evidence.cause,
      cleanupLastRetryable: evidence.retryable,
      cleanupLastObservedAt: evidence.observedAt,
    };
    this.records.set(args.taskId, settled);
    return { kind: 'recorded', owner: settled };
  }

  async confirmSandboxRunCleanupOrphan(
    args: ConfirmSandboxRunCleanupOrphanArgs,
  ): Promise<ConfirmSandboxRunCleanupOrphanResult> {
    const existing = this.records.get(args.taskId);
    if (!existing) return { kind: 'stale' };
    if (
      existing.status !== 'deleting' ||
      !existing.ownership ||
      existing.providerId !== args.providerId ||
      existing.providerSandboxId !== args.providerSandboxId
    ) {
      return { kind: 'conflict' };
    }
    if (existing.cleanupOrphanConfirmedAt) {
      return { kind: 'replayed', owner: existing };
    }
    const confirmed = {
      ...existing,
      cleanupOrphanConfirmedAt: new Date(),
    };
    this.records.set(args.taskId, confirmed);
    return { kind: 'recorded', owner: confirmed };
  }

  async markSandboxRunOwnerStatus(
    taskId: string,
    status: SandboxRunOwnerStatus,
  ): Promise<void> {
    const existing = this.records.get(taskId);
    if (!existing) return;
    // Cleanup entry and terminal-policy failure have dedicated fenced methods.
    if (status === 'deleting' || status === 'failed') return;
    if (isSettledOwner(existing)) return;
    if (
      existing.status === 'deleting' &&
      (status === 'removed' || status === 'terminal') &&
      (existing.createState !== 'idle' ||
        !hasConfirmedCleanupEvidence(existing))
    ) {
      return;
    }
    if (
      existing.status === 'deleting' &&
      status !== 'removed' &&
      status !== 'terminal'
    ) {
      return;
    }
    this.records.set(taskId, { ...existing, status });
  }
}

function cleanupAuthorizationFor(
  owner: SandboxRunOwnerRecord,
): SandboxRunCleanupAuthorization {
  return owner.ownership
    ? Object.freeze({
        kind: 'generation' as const,
        taskId: owner.taskId,
        providerId: owner.providerId,
        ownership: owner.ownership,
      })
    : Object.freeze({
        kind: 'legacy' as const,
        taskId: owner.taskId,
        providerId: owner.providerId,
      });
}

function cleanupAuthorityProjection(
  owner: SandboxRunOwnerRecord | undefined,
): SandboxRunCleanupAuthorityProjection {
  const status = owner?.status ?? null;
  const state =
    status === 'deleting'
      ? 'pending'
      : status === 'removed'
        ? 'succeeded'
        : status === 'failed'
          ? 'failed'
          : 'not_required';
  return Object.freeze({
    state,
    ownershipKind: owner
      ? owner.ownership
        ? 'generation'
        : 'legacy'
      : 'none',
    orphanState:
      status === 'deleting' || status === 'failed'
        ? owner?.cleanupOrphanConfirmedAt
          ? 'confirmed'
          : 'unknown'
        : 'none',
    status,
    attemptCount: owner?.cleanupAttemptCount ?? 0,
    lastAttemptOutcome: owner?.cleanupLastOutcome ?? null,
    lastAttemptProof: owner?.cleanupLastProof ?? null,
    lastAttemptCause: owner?.cleanupLastCause ?? null,
    lastAttemptRetryable: owner?.cleanupLastRetryable ?? null,
    lastAttemptObservedAt: owner?.cleanupLastObservedAt
      ? new Date(owner.cleanupLastObservedAt)
      : null,
  });
}

function isSettledOwner(
  owner: SandboxRunOwnerRecord,
): owner is SandboxRunOwnerRecord & {
  readonly status: 'terminal' | 'removed' | 'failed';
} {
  return (
    owner.status === 'terminal' ||
    owner.status === 'removed' ||
    owner.status === 'failed'
  );
}

function terminalPolicyMatches(
  owner: SandboxRunOwnerRecord,
  authorization: Extract<
    SandboxRunCleanupAuthorization,
    { readonly kind: 'generation' }
  >,
  expectedAttempt: number,
): boolean {
  return (
    owner.createState === 'idle' &&
    owner.providerId === authorization.providerId &&
    owner.ownership?.ownerGeneration ===
      authorization.ownership.ownerGeneration &&
    owner.ownership.resourceGeneration ===
      authorization.ownership.resourceGeneration &&
    owner.cleanupAttemptCount === expectedAttempt
  );
}

function legacySettlementStatusMatches(
  status: SettleLegacySandboxRunCleanupArgs['status'],
  disposition: SettleLegacySandboxRunCleanupArgs['disposition'],
  evidence: SandboxCleanupAttemptEvidence,
): boolean {
  return status ===
    (disposition === 'superseded-remove' && evidence.outcome === 'succeeded'
      ? 'removed'
      : 'terminal');
}

function cleanupAuthorizationMatches(
  owner: SandboxRunOwnerRecord,
  authorization: SandboxRunCleanupAuthorization,
): boolean {
  if (authorization.kind === 'legacy') return owner.ownership === undefined;
  return (
    owner.ownership?.resourceGeneration === authorization.ownership.resourceGeneration
  );
}

function cleanupAttemptAuthorizationMatches(
  owner: SandboxRunOwnerRecord,
  authorization: SandboxRunCleanupAuthorization,
): boolean {
  if (authorization.kind === 'legacy') return owner.ownership === undefined;
  return (
    owner.ownership?.ownerGeneration ===
      authorization.ownership.ownerGeneration &&
    owner.ownership.resourceGeneration ===
      authorization.ownership.resourceGeneration
  );
}

function cleanupEvidenceForOwner(
  owner: SandboxRunOwnerRecord,
): SandboxCleanupAttemptEvidence | null {
  if (
    !owner.cleanupAttemptCount ||
    owner.cleanupLastAttemptId === undefined ||
    owner.cleanupLastOutcome === undefined ||
    owner.cleanupLastProof === undefined ||
    owner.cleanupLastCause === undefined ||
    owner.cleanupLastRetryable === undefined ||
    owner.cleanupLastObservedAt === undefined
  ) {
    return null;
  }
  return validateSandboxCleanupAttemptEvidence({
    attemptId: owner.cleanupLastAttemptId,
    attempt: owner.cleanupAttemptCount,
    outcome: owner.cleanupLastOutcome,
    proof: owner.cleanupLastProof,
    cause: owner.cleanupLastCause,
    retryable: owner.cleanupLastRetryable,
    observedAt: owner.cleanupLastObservedAt,
  });
}

function hasConfirmedCleanupEvidence(owner: SandboxRunOwnerRecord): boolean {
  const evidence = cleanupEvidenceForOwner(owner);
  return (
    evidence?.outcome === 'succeeded' &&
    (evidence.proof === 'found-and-cleaned' ||
      evidence.proof === 'already-absent') &&
    evidence.cause === null &&
    evidence.retryable === false
  );
}

function sameCleanupEvidence(
  owner: SandboxRunOwnerRecord,
  evidence: SandboxCleanupAttemptEvidence,
): boolean {
  return (
    owner.cleanupLastOutcome === evidence.outcome &&
    owner.cleanupLastAttemptId === evidence.attemptId &&
    (owner.cleanupLastProof ?? null) === evidence.proof &&
    (owner.cleanupLastCause ?? null) === evidence.cause &&
    owner.cleanupLastRetryable === evidence.retryable &&
    owner.cleanupLastObservedAt?.getTime() === evidence.observedAt.getTime()
  );
}
