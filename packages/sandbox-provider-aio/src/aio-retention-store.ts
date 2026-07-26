import Docker from 'dockerode';
import { AIO_SANDBOX_CONTAINER_PREFIX } from './aio-local-provider.js';

export interface RetainedAioSandbox {
  readonly id: string;
  readonly name: string;
  /** Epoch ms the sandbox stopped; oldest first is eviction priority. */
  readonly finishedAtMs: number;
}

export interface AioSandboxRetentionStore {
  listStoppedSandboxes(): Promise<RetainedAioSandbox[]>;
  removeStopped(sandbox: RetainedAioSandbox): Promise<void>;
}

export interface AioDockerRetentionClient {
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

export class AioDockerSandboxRetentionStore
  implements AioSandboxRetentionStore
{
  constructor(
    private readonly docker: AioDockerRetentionClient = new Docker() as unknown as AioDockerRetentionClient,
    private readonly containerPrefix = AIO_SANDBOX_CONTAINER_PREFIX,
  ) {}

  async listStoppedSandboxes(): Promise<RetainedAioSandbox[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: {
        name: [this.containerPrefix],
        status: ['exited', 'created', 'dead'],
      },
    });
    const out: RetainedAioSandbox[] = [];
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

  async removeStopped(sandbox: RetainedAioSandbox): Promise<void> {
    const container = this.docker.getContainer(sandbox.id);
    let removeError: unknown;
    try {
      await container.remove({ force: false });
    } catch (error) {
      removeError = error;
    }
    try {
      await container.inspect();
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw removeError ?? error;
    }
    throw removeError ?? new Error('AIO retained sandbox removal could not be confirmed');
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

function isDockerNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    readonly statusCode?: unknown;
    readonly status?: unknown;
    readonly response?: { readonly statusCode?: unknown; readonly status?: unknown };
  };
  return (
    candidate.statusCode === 404 ||
    candidate.status === 404 ||
    candidate.response?.statusCode === 404 ||
    candidate.response?.status === 404
  );
}
