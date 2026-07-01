import { AioDockerSandboxRetentionStore } from '@cap/sandbox-provider-aio';

export interface RetainedSandbox {
  readonly id: string;
  readonly name: string;
  /** Epoch ms the sandbox stopped; oldest first is eviction priority. */
  readonly finishedAtMs: number;
}

export interface SandboxRetentionStore {
  listStoppedSandboxes(): Promise<RetainedSandbox[]>;
  removeStopped(sandbox: RetainedSandbox): Promise<void>;
}

export function createConfiguredSandboxRetentionStore(): SandboxRetentionStore {
  return new AioDockerSandboxRetentionStore();
}
