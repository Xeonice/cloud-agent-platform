import { Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { ForgeTargetResolver } from '../forge/forge-target-resolver';
import { DefaultForgeRegistry } from '../forge/forge-registry';
import type { CloneSpec, ProvisionLookup } from './provision-lookup.port';

/**
 * Prisma-backed {@link ProvisionLookup}: resolves a task's clone spec from its
 * own `repo.gitSource`, attaching the task owner's forge PAT as an Authorization
 * header (NOT in the URL) for private repos. This is where the database access
 * lives so {@link AioSandboxProvider} stays a pure port consumer.
 */
@Injectable()
export class PrismaProvisionLookup implements ProvisionLookup {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly forgeResolver?: ForgeTargetResolver,
    @Optional() private readonly forgeRegistry?: DefaultForgeRegistry,
  ) {}

  async getCloneSpec(taskId: string): Promise<CloneSpec | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { repo: true },
    });
    const gitSource = task?.repo?.gitSource;
    if (!gitSource) {
      // Fallback to the legacy global env ONLY when the task/repo lookup yields
      // nothing — keeps a single-repo deploy that still sets it working.
      const fallback = process.env.TASK_REPO_URL;
      return fallback ? { url: fallback } : null;
    }
    // add-multi-forge-task-delivery (4.2): clone auth is now multi-forge +
    // OWNER-SCOPED. When the task owner has a forge credential for the repo's
    // forge, clone with `forge.cloneAuthHeader` (github/gitee `x-access-token`,
    // gitlab `oauth2`); the token rides the http.extraHeader, never the URL.
    if (this.forgeResolver && this.forgeRegistry) {
      const target = await this.forgeResolver.getForgeTarget(taskId);
      if (target) {
        const authHeader = this.forgeRegistry.forKind(target.kind).cloneAuthHeader(target);
        return { url: target.cloneUrl, authHeader };
      }
    }
    // No owner-scoped forge PAT could be resolved. Clone public repos with the
    // bare URL; private repos will fail closed inside git rather than borrowing a
    // global or OAuth-derived credential.
    return { url: gitSource };
  }

  /**
   * The operator-supplied prompt (`task.prompt`) for `taskId`, used by the
   * provider to pre-fill codex's composer with the goal. Returns `null` when the
   * task is missing or its prompt is empty. This is where the DB access lives so
   * {@link AioSandboxProvider} stays a pure port consumer.
   */
  async getTaskPrompt(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { prompt: true },
    });
    const raw = task?.prompt;
    return raw && raw.trim().length > 0 ? raw : null;
  }

  /**
   * The selected skill ids (`task.skills`) for `taskId`, used by the provider to
   * preinstall those skills into the workspace. Returns an empty array when the
   * task is missing or selected none. DB access lives here so
   * {@link AioSandboxProvider} stays a pure port consumer.
   */
  async getTaskSkills(taskId: string): Promise<string[]> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { skills: true },
    });
    return task?.skills ?? [];
  }

  /**
   * The task's persisted `runtime` (`'codex'` | `'claude-code'`), or `null` when
   * the task is missing / has no runtime. The runtime registry reads this to
   * dispatch provisioning to the right agent — without it EVERY task defaulted to
   * codex. DB access lives here so the provider/registry stay pure port consumers.
   */
  async getTaskRuntime(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { runtime: true },
    });
    return task?.runtime ?? null;
  }

  async getTaskExecutionMode(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { executionMode: true },
    });
    return task?.executionMode ?? null;
  }

}
