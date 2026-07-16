import type {
  AcquireSandboxRunOwnerArgs,
  AcquireSandboxRunOwnerResult,
  BeginSandboxRunCreateArgs,
  BeginSandboxRunCleanupResult,
  ClaimSandboxRunCleanupResult,
  JoinSandboxRunCleanupArgs,
  JoinSandboxRunCleanupResult,
  ObserveSandboxRunCreateArgs,
  RecordSandboxRunOwnerArgs,
  SandboxOwnershipFence,
  SandboxRunCleanupAuthorization,
  SandboxRunOwnerRecord,
  SandboxRunOwnerStatus,
  SandboxRunOwnerStore,
} from '@cap/sandbox-core';

export class InMemorySandboxRunOwnerStore implements SandboxRunOwnerStore {
  private readonly records = new Map<string, SandboxRunOwnerRecord>();

  async getSandboxRunOwner(taskId: string): Promise<SandboxRunOwnerRecord | null> {
    const record = this.records.get(taskId);
    return record && (record.status === 'provisioning' || record.status === 'running')
      ? record
      : null;
  }

  async listActiveSandboxRunOwners(): Promise<readonly SandboxRunOwnerRecord[]> {
    return [...this.records.values()].filter((record) =>
      record.status === 'provisioning' || record.status === 'running'
    );
  }

  async recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void> {
    const existing = this.records.get(args.taskId);
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
    const { providerSandboxId, ...record } = args;
    this.records.set(args.taskId, {
      ...existing,
      ...record,
      ...(providerSandboxId === undefined ? {} : { providerSandboxId }),
      createState: 'idle',
      status: args.status ?? existing?.status ?? 'running',
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
    });
    return {
      kind: 'acquired',
      ownership,
      ...(existing ? { previousOwner: existing } : {}),
    };
  }

  async beginSandboxRunCreate(args: BeginSandboxRunCreateArgs): Promise<boolean> {
    const existing = this.records.get(args.taskId);
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

  async observeSandboxRunCreate(
    args: ObserveSandboxRunCreateArgs,
  ): Promise<boolean> {
    const existing = this.records.get(args.taskId);
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
    });
    return true;
  }

  async beginSandboxRunCleanup(
    taskId: string,
    ownership?: SandboxOwnershipFence,
  ): Promise<BeginSandboxRunCleanupResult> {
    const existing = this.records.get(taskId);
    if (!existing || !['provisioning', 'running', 'deleting'].includes(existing.status)) {
      return { kind: 'absent' };
    }
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
    if (!existing || !['provisioning', 'running', 'deleting'].includes(existing.status)) {
      return { kind: 'absent' };
    }
    const owner: SandboxRunOwnerRecord = existing.ownership
      ? {
          ...existing,
          status: 'deleting',
          ownership: Object.freeze({
            ownerGeneration,
            resourceGeneration: existing.ownership.resourceGeneration,
          }),
        }
      : { ...existing, status: 'deleting' };
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
    if (!existing || !['provisioning', 'running', 'deleting'].includes(existing.status)) {
      return { kind: 'absent' };
    }
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
    status: 'removed' | 'terminal' | 'failed',
  ): Promise<boolean> {
    const existing = this.records.get(authorization.taskId);
    if (
      !existing ||
      existing.status !== 'deleting' ||
      existing.providerId !== authorization.providerId ||
      (authorization.kind === 'generation' && existing.createState !== 'idle') ||
      !cleanupAuthorizationMatches(existing, authorization)
    ) {
      return false;
    }
    this.records.set(authorization.taskId, { ...existing, status });
    return true;
  }

  async markSandboxRunOwnerStatus(
    taskId: string,
    status: SandboxRunOwnerStatus,
  ): Promise<void> {
    const existing = this.records.get(taskId);
    if (!existing) return;
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

function cleanupAuthorizationMatches(
  owner: SandboxRunOwnerRecord,
  authorization: SandboxRunCleanupAuthorization,
): boolean {
  if (authorization.kind === 'legacy') return owner.ownership === undefined;
  return (
    owner.ownership?.resourceGeneration === authorization.ownership.resourceGeneration
  );
}
