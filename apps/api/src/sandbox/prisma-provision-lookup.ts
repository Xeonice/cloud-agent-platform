import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { CloneSpec, ProvisionLookup } from './provision-lookup.port';

/**
 * Prisma-backed {@link ProvisionLookup}: resolves a task's clone spec from its
 * own `repo.gitSource`, attaching the single operator's stored GitHub OAuth token
 * as an `Authorization` header (NOT in the URL) for private
 * `https://github.com/...` repos. This is where the database access lives so
 * {@link AioSandboxProvider} stays a pure port consumer.
 */
@Injectable()
export class PrismaProvisionLookup implements ProvisionLookup {
  constructor(private readonly prisma: PrismaService) {}

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
    // Only github https repos get the operator token (as an auth header, kept out
    // of the URL); ssh/other hosts and public repos clone with the bare URL.
    const m = gitSource.match(/^https:\/\/github\.com\/.+$/);
    if (!m) return { url: gitSource };
    const token = await this.resolveGitHubToken();
    if (!token) return { url: gitSource };
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    return { url: gitSource, authHeader: `Authorization: Basic ${basic}` };
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

  /**
   * The single allowed operator's stored GitHub OAuth access token (single-user
   * self-host: the allowlist admits exactly one identity, so the earliest allowed
   * user holding a captured token IS the operator). Used only to authenticate the
   * in-sandbox private-repo clone; never logged.
   */
  private async resolveGitHubToken(): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { allowed: true, githubAccessToken: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    return user?.githubAccessToken ?? null;
  }
}
