import { Injectable } from '@nestjs/common';
import {
  LOCAL_REPO_IMPORT_ROOT_ENV,
  LocalRepoImportAvailabilitySchema,
  type LocalRepoImportAvailability,
  type LocalRepoImportRequest,
  type RepoResponse,
} from '@cap/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { readLocalImportRoot, resolveLocalImportTarget } from './local-import';
import { throwLocalImportRejection } from './local-import-errors';
import { RepoCopyService } from './repo-copy.service';
import { repoRowToResponse } from './repo-response';

/**
 * Local-path repository import (local-repo-import).
 *
 * Fail-closed behind `CAP_LOCAL_IMPORT_ROOT`: with the variable unset the
 * availability probe reports `enabled: false` and every import request is
 * rejected with an actionable "feature disabled" error, so the console cannot
 * offer a mode the api will refuse.
 *
 * A locally imported Repo records the RESOLVED source path as its `gitSource`
 * and carries NO forge provenance (`forge`/`githubId`/`gitlabProjectId` stay
 * null), so forge-side delivery (PR/MR) is never offered for it while in-sandbox
 * git operations against that source keep working normally.
 */
@Injectable()
export class LocalRepoImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly copies: RepoCopyService,
  ) {}

  /** Read-only capability probe for the console import dialog. */
  availability(
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): LocalRepoImportAvailability {
    const root = readLocalImportRoot(env);
    return LocalRepoImportAvailabilitySchema.parse({
      enabled: root !== null,
      root,
      envVar: LOCAL_REPO_IMPORT_ROOT_ENV,
    });
  }

  /**
   * Imports an existing git repository from an allowlisted local path.
   *
   * Order matters: the gate (root → containment → git repository) runs FIRST, so
   * a rejected request creates NO Repo row. Only a validated target reaches
   * persistence, and only a persisted row reaches content acquisition.
   */
  async import(
    body: LocalRepoImportRequest,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ): Promise<RepoResponse> {
    const resolution = await resolveLocalImportTarget(body.path, env);
    if (!resolution.ok) {
      throwLocalImportRejection(resolution.rejection);
    }
    const target = resolution.target;
    const name = body.name?.trim() || target.name;

    const repo = await this.upsertLocalRepoRow(target.path, name, target.defaultBranch);
    // Same acquisition seam as the forge/URL imports: no credential, because a
    // local path needs none. Failure leaves this row visible with a non-ready
    // copy status and a retry path (the refresh endpoint).
    return this.copies.acquireOnImport(repo);
  }

  /**
   * Creates the Repo row, or reuses the existing row for the same resolved path
   * so re-importing after a failed acquisition retries instead of duplicating.
   *
   * Serialized on a deterministic advisory key, matching the forge/URL import
   * path: two concurrent imports of one path must not both observe "missing".
   */
  private async upsertLocalRepoRow(
    path: string,
    name: string,
    defaultBranch: string | null,
  ): Promise<RepoResponse> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`repo-path:${path}`}, 0))
      `;
      const existing = await tx.repo.findFirst({
        where: { gitSource: path },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) {
        const updated = await tx.repo.update({
          where: { id: existing.id },
          data: {
            // A re-import re-reads the source HEAD; never erase a known branch
            // with an unresolved one.
            ...(defaultBranch === null ? {} : { defaultBranch }),
          },
        });
        return repoRowToResponse(updated);
      }
      const created = await tx.repo.create({
        data: {
          name,
          gitSource: path,
          defaultBranch,
          // A locally imported repo is connected to NO forge. These stay null so
          // every forge-driven read path (delivery, picker reconciliation,
          // credential resolution) treats it as forge-less.
          forge: null,
          githubId: null,
          gitlabProjectId: null,
          description: null,
        },
      });
      return repoRowToResponse(created);
    });
  }
}
