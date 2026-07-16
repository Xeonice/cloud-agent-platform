import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decryptStored } from '../settings/secret-storage';
import {
  DefaultForgeRegistry,
  type ForgeRepoInput,
} from './forge-registry';
import type { ForgeKind, ForgeTarget } from './forge.port';

function legacyHostFilters(host: string): Array<
  { host: string } | { host: { startsWith: string } }
> {
  return [
    { host },
    { host: `https://${host}` },
    { host: `http://${host}` },
    { host: { startsWith: `https://${host}/` } },
    { host: { startsWith: `http://${host}/` } },
  ];
}

/**
 * Secret-free outcome of resolving an account-owned forge target.
 *
 * Callers that need a credentialed forge boundary (repository import, task
 * workspace setup, delivery) share this result instead of independently
 * reimplementing host parsing or credential lookup. The failure reason is safe
 * to classify at an HTTP/application boundary and never includes the target,
 * token, ciphertext, or a credential-bearing URL.
 */
export type OwnerForgeTargetResolution =
  | { readonly ok: true; readonly target: ForgeTarget }
  | {
      readonly ok: false;
      readonly reason: 'forge_unresolved' | 'owner_credential_unavailable';
    };

/**
 * Resolves a task to a fully-credentialed {@link ForgeTarget} for push-back
 * (add-multi-forge-task-delivery). Detection (registry) + OWNER-SCOPED credential:
 * the token is the task owner's `ForgeCredential` for the resolved (kind, host)
 * — the owner is the task's durable owner FK, with the earliest attributed
 * `task.created` audit event retained as a legacy fallback. An unattributed task, or one with no usable
 * forge PAT credential, resolves to null → push-back is skipped (fail-open).
 *
 * Reads `forgeCredential` directly + decrypts via the shared pure helpers (no
 * NestJS dependency on SettingsModule → no module cycle into guardrails).
 */
@Injectable()
export class ForgeTargetResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: DefaultForgeRegistry,
  ) {}

  async getForgeTarget(
    taskId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ForgeTarget | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { repo: true },
    });
    const repo = task?.repo;
    if (!repo?.gitSource) {
      return null;
    }
    const ownerId =
      task?.ownerUserId ?? (await this.resolveLegacyTaskOwnerId(taskId));
    if (!ownerId) {
      return null; // unattributed task → skip push-back
    }
    const resolved = await this.resolveForOwner(
      ownerId,
      {
        gitSource: repo.gitSource,
        forge: repo.forge,
        gitlabProjectId: repo.gitlabProjectId,
      },
      env,
    );
    return resolved.ok ? resolved.target : null;
  }

  /**
   * Resolves a repository location and the authenticated account's credential
   * through one exact-host seam.
   *
   * Repository import calls this method with the account id derived from the
   * authenticated Console session. Task delivery calls it after resolving the
   * durable task owner. In both cases the registry owns forge/host detection and
   * credential lookup is constrained to `(owner, kind, exact normalized host)`;
   * no caller may provide or receive a credential-bearing clone URL.
   */
  async resolveForOwner(
    ownerUserId: string,
    repo: ForgeRepoInput,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<OwnerForgeTargetResolution> {
    const location = await this.registry.detect(repo);
    if (!location) {
      return { ok: false, reason: 'forge_unresolved' };
    }
    const host = this.hostOf(location.cloneUrl);
    if (!host) {
      return { ok: false, reason: 'forge_unresolved' };
    }

    const token = await this.forgeCredentialToken(
      ownerUserId,
      location.kind,
      host,
      env,
    );
    if (!token) {
      return { ok: false, reason: 'owner_credential_unavailable' };
    }
    return { ok: true, target: { ...location, token } };
  }

  /** The owner's decrypted forge PAT for (kind, host), or null. */
  private async forgeCredentialToken(
    userId: string,
    kind: ForgeKind,
    host: string,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    const exact = await this.prisma.forgeCredential.findUnique({
      where: { userId_kind_host: { userId, kind, host } },
    });
    const row =
      exact ??
      (await this.prisma.forgeCredential.findFirst({
        where: { userId, kind, OR: legacyHostFilters(host) },
        orderBy: { updatedAt: 'desc' },
      }));
    return decryptStored(row?.tokenCiphertext, env);
  }

  /** Legacy owner fallback for tasks created before the durable owner column. */
  private async resolveLegacyTaskOwnerId(taskId: string): Promise<string | null> {
    const created = await this.prisma.auditEvent.findFirst({
      where: { taskId, type: 'task.created', userId: { not: null } },
      orderBy: { timestamp: 'asc' },
      select: { userId: true },
    });
    return created?.userId ?? null;
  }

  private hostOf(cloneUrl: string): string | null {
    try {
      return new URL(cloneUrl).host.toLowerCase();
    } catch {
      return null;
    }
  }
}
