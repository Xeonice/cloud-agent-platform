import type {
  RecordSandboxRunOwnerArgs,
  SandboxRunOwnerRecord,
  SandboxRunOwnerStatus,
  SandboxRunOwnerStore,
} from '@cap/sandbox-core';

export class InMemorySandboxRunOwnerStore implements SandboxRunOwnerStore {
  private readonly records = new Map<string, SandboxRunOwnerRecord>();

  async getSandboxRunOwner(taskId: string): Promise<SandboxRunOwnerRecord | null> {
    return this.records.get(taskId) ?? null;
  }

  async listActiveSandboxRunOwners(): Promise<readonly SandboxRunOwnerRecord[]> {
    return [...this.records.values()].filter((record) =>
      record.status === 'provisioning' || record.status === 'running'
    );
  }

  async recordSandboxRunOwner(args: RecordSandboxRunOwnerArgs): Promise<void> {
    const existing = this.records.get(args.taskId);
    this.records.set(args.taskId, {
      ...existing,
      ...args,
      status: existing?.status ?? 'running',
    });
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
