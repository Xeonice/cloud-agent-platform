import Docker from 'dockerode';
import { AIO_SANDBOX_CONTAINER_PREFIX } from '@cap/sandbox';

export const SANDBOX_RETENTION_STORE = Symbol('SandboxRetentionStore');

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

interface DockerRetentionClient {
  listContainers(options: {
    readonly all: boolean;
    readonly filters: {
      readonly name: readonly string[];
      readonly status: readonly string[];
    };
  }): Promise<
    readonly {
      readonly Id: string;
      readonly Names?: readonly string[];
      readonly State?: string;
    }[]
  >;
  getContainer(id: string): {
    inspect(): Promise<{
      readonly State?: { readonly FinishedAt?: string };
      readonly Created?: string;
    }>;
    remove(options: { readonly force: boolean }): Promise<void>;
  };
}

export class DockerSandboxRetentionStore implements SandboxRetentionStore {
  constructor(
    private readonly docker: DockerRetentionClient = new Docker() as unknown as DockerRetentionClient,
    private readonly containerPrefix = AIO_SANDBOX_CONTAINER_PREFIX,
  ) {}

  async listStoppedSandboxes(): Promise<RetainedSandbox[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: {
        name: [this.containerPrefix],
        status: ['exited', 'created', 'dead'],
      },
    });
    const out: RetainedSandbox[] = [];
    for (const info of list) {
      if (info.State === 'running') continue;
      out.push({
        id: info.Id,
        name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id,
        finishedAtMs: await this.finishedAtMs(info.Id),
      });
    }
    out.sort((a, b) => a.finishedAtMs - b.finishedAtMs);
    return out;
  }

  async removeStopped(sandbox: RetainedSandbox): Promise<void> {
    await this.docker
      .getContainer(sandbox.id)
      .remove({ force: false })
      .catch(() => undefined);
  }

  private async finishedAtMs(id: string): Promise<number> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      const finished = info?.State?.FinishedAt;
      const t = finished ? Date.parse(finished) : NaN;
      if (Number.isFinite(t) && t > 0) return t;
      const created = info?.Created ? Date.parse(info.Created) : NaN;
      return Number.isFinite(created) && created > 0 ? created : 0;
    } catch {
      return 0;
    }
  }
}
