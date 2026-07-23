import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, readdir } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyGitFailure,
  isSafeAuthHeader,
  RepoStoreCommandError,
  RepoStoreCommandRunner,
  RepoStoreCredentialError,
  RepoStoreCredentialStore,
  type RepoStoreCredentialLease,
  type RepoStoreFailureReason,
  type RepoStoreProgressListener,
  type RepoStoreStage,
} from './repo-store-git';

/**
 * The shared repo-store volume root inside the api container. Every Repo's bare
 * mirror lives at `<root>/<repoId>.git`; sandbox mount injection addresses the
 * same copy through the volume subpath `<repoId>.git`.
 */
export const REPO_STORE_DIR_ENV = 'CAP_REPO_STORE_DIR';
export const DEFAULT_REPO_STORE_DIR = '/repo-store';

/** Staging area for in-flight copies. Never a valid repo id, so never mounted. */
export const REPO_STORE_STAGING_DIRNAME = '.staging';

/** Ceiling for one acquisition/refresh when the caller supplies no signal. */
export const REPO_STORE_ACQUIRE_TIMEOUT_MS = 30 * 60 * 1000;

/** Closed vocabulary persisted in `Repo.copyStatus`. */
export type RepoCopyStatus = 'missing' | 'refreshing' | 'ready' | 'failed';

export interface RepoStoreSuccess {
  readonly ok: true;
  /** Absolute path of the bare mirror inside the repo-store volume. */
  readonly path: string;
  /** Volume subpath for read-only sandbox mount injection. */
  readonly subpath: string;
  /** The instant persisted to `Repo.copyUpdatedAt`. */
  readonly copyUpdatedAt: Date;
}

export interface RepoStoreFailure {
  readonly ok: false;
  readonly reason: RepoStoreFailureReason;
  /** Phase the operation died in; safe to surface to the operator. */
  readonly stage: RepoStoreStage;
  /** Bounded, redacted git output summary. Never contains a credential. */
  readonly detail: string;
}

export type RepoStoreResult = RepoStoreSuccess | RepoStoreFailure;

export interface RepoStoreAcquireRequest {
  readonly repoId: string;
  /**
   * The recorded source: an `http(s)` clone URL (no userinfo) or an absolute
   * local path. Allowlist-root enforcement for local paths belongs to the
   * import caller — this service only rejects structurally unusable sources.
   */
  readonly source: string;
  /** `Authorization: ...` header value; http(s) sources only. */
  readonly authHeader?: string;
  readonly onProgress?: RepoStoreProgressListener;
  readonly signal?: AbortSignal;
}

export interface RepoStoreRefreshRequest {
  readonly repoId: string;
  /** When provided, `origin` is repointed before fetching. */
  readonly source?: string;
  readonly authHeader?: string;
  readonly onProgress?: RepoStoreProgressListener;
  readonly signal?: AbortSignal;
}

/** Repo ids address a directory in a shared volume: keep them boring. */
const SAFE_REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Owns the repo-store: one bare git mirror per Repo, materialized on the API
 * host at import time and refreshed only when an operator asks.
 *
 * Guarantees:
 * - **Atomic completion.** A copy is cloned into `<root>/.staging/...` and only
 *   then renamed onto its final path (same volume => rename is atomic). A
 *   failure therefore never leaves a half-written copy where consumers look,
 *   and a retry needs no operator cleanup of the store.
 * - **Last-good preservation.** A failed refresh leaves the previous copy (and
 *   its `copyUpdatedAt`) in place and records `failed`.
 * - **No boot backfill.** Nothing in this service runs on startup; upgraded
 *   deployments keep their pre-existing Repos on `missing` until an operator
 *   triggers acquisition per repo.
 * - **Secret-free evidence.** Credentials ride a mode-0600 temp git config,
 *   never argv/URL/persisted config; results carry only redacted, bounded text.
 */
@Injectable()
export class RepoStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: RepoStoreCommandRunner,
    private readonly credentials: RepoStoreCredentialStore,
  ) {}

  /** Repo-store volume root; re-read per call so deployments can relocate it. */
  storeRoot(): string {
    const configured = process.env[REPO_STORE_DIR_ENV]?.trim();
    return configured && configured.length > 0
      ? normalize(configured)
      : DEFAULT_REPO_STORE_DIR;
  }

  /** Volume-relative name of a Repo's copy (the mount subpath). */
  copySubpath(repoId: string): string {
    this.assertRepoId(repoId);
    return `${repoId}.git`;
  }

  /** Absolute path of a Repo's copy inside the api container. */
  copyPath(repoId: string): string {
    return join(this.storeRoot(), this.copySubpath(repoId));
  }

  /** True when a materialized bare mirror is present for this Repo. */
  async hasCopy(repoId: string): Promise<boolean> {
    try {
      return (await stat(this.copyPath(repoId))).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Materializes (or re-materializes) a Repo's bare mirror from its source.
   *
   * Import-time entry point: safe to call when a copy already exists — the new
   * copy replaces the old one only after it is fully cloned.
   */
  async acquire(request: RepoStoreAcquireRequest): Promise<RepoStoreResult> {
    const validation = this.validate(request.repoId, request.source);
    if (!validation.ok) return validation;
    const source = validation.source;
    if (source === null) {
      return {
        ok: false,
        reason: 'source_invalid',
        stage: 'preparing',
        detail: 'acquisition requires a repository source',
      };
    }

    await this.markStatus(request.repoId, 'refreshing');

    const stagingRoot = join(this.storeRoot(), REPO_STORE_STAGING_DIRNAME);
    const stagingPath = join(stagingRoot, `${request.repoId}-${randomUUID()}`);
    let retiredPath: string | null = null;

    try {
      await mkdir(stagingRoot, { recursive: true });
    } catch {
      return this.fail(request.repoId, {
        ok: false,
        reason: 'store_unavailable',
        stage: 'preparing',
        detail: 'repo store directory is not writable',
      });
    }

    try {
      const cloneArgs = [
        'clone',
        '--mirror',
        '--progress',
        ...(validation.kind === 'path' ? ['--no-hardlinks'] : []),
        '--',
        source,
        stagingPath,
      ];
      const transfer = await this.runGit({
        args: cloneArgs,
        stage: 'transferring',
        source: validation,
        authHeader: request.authHeader,
        onProgress: request.onProgress,
        signal: request.signal,
      });
      if (!transfer.ok) return this.fail(request.repoId, transfer);

      request.onProgress?.({ stage: 'finalizing', message: 'publishing copy' });
      const finalPath = this.copyPath(request.repoId);
      if (await this.hasCopy(request.repoId)) {
        retiredPath = join(stagingRoot, `${request.repoId}-retired-${randomUUID()}`);
        await rename(finalPath, retiredPath);
      }
      try {
        await rename(stagingPath, finalPath);
      } catch (error) {
        // Put the previous copy back: a failed publish must not downgrade a
        // Repo that already had usable content.
        if (retiredPath) {
          await rename(retiredPath, finalPath).catch(() => undefined);
          retiredPath = null;
        }
        throw error;
      }

      const copyUpdatedAt = new Date();
      await this.prisma.repo.updateMany({
        where: { id: request.repoId },
        data: { copyStatus: 'ready', copyUpdatedAt },
      });
      return {
        ok: true,
        path: finalPath,
        subpath: this.copySubpath(request.repoId),
        copyUpdatedAt,
      };
    } catch (error) {
      return this.fail(request.repoId, this.fromThrown(error, 'finalizing'));
    } finally {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
      if (retiredPath) {
        await rm(retiredPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Updates an existing bare mirror from its recorded source (`git fetch`
   * semantics with ref pruning). Never called on the task-start path.
   */
  async refresh(request: RepoStoreRefreshRequest): Promise<RepoStoreResult> {
    const validation = this.validate(request.repoId, request.source ?? null);
    if (!validation.ok) return validation;

    const finalPath = this.copyPath(request.repoId);
    if (!(await this.hasCopy(request.repoId))) {
      await this.markStatus(request.repoId, 'missing');
      return {
        ok: false,
        reason: 'copy_missing',
        stage: 'preparing',
        detail: 'no stored copy for this repository; import or re-acquire it first',
      };
    }

    await this.markStatus(request.repoId, 'refreshing');

    if (validation.source) {
      const repoint = await this.runGit({
        args: ['-C', finalPath, 'remote', 'set-url', 'origin', validation.source],
        stage: 'preparing',
        source: validation,
        authHeader: request.authHeader,
        signal: request.signal,
      });
      if (!repoint.ok) return this.fail(request.repoId, repoint);
    }

    const fetched = await this.runGit({
      args: [
        '-C',
        finalPath,
        'fetch',
        '--prune',
        '--prune-tags',
        '--tags',
        '--force',
        '--progress',
        'origin',
      ],
      stage: 'transferring',
      source: validation,
      authHeader: request.authHeader,
      onProgress: request.onProgress,
      signal: request.signal,
    });
    // The last-good copy is still on disk either way: a failed fetch leaves the
    // mirror exactly as it was, so only the status/timestamp differ.
    if (!fetched.ok) return this.fail(request.repoId, fetched);

    const copyUpdatedAt = new Date();
    await this.prisma.repo.updateMany({
      where: { id: request.repoId },
      data: { copyStatus: 'ready', copyUpdatedAt },
    });
    return {
      ok: true,
      path: finalPath,
      subpath: this.copySubpath(request.repoId),
      copyUpdatedAt,
    };
  }

  /**
   * Deletes a Repo's copy (and any staging leftovers). Idempotent: removing a
   * Repo that never had a copy is a no-op. The Repo row itself is the caller's
   * concern; this method touches only the volume.
   */
  async remove(repoId: string): Promise<void> {
    this.assertRepoId(repoId);
    await rm(this.copyPath(repoId), { recursive: true, force: true });

    const stagingRoot = join(this.storeRoot(), REPO_STORE_STAGING_DIRNAME);
    let entries: string[];
    try {
      entries = await readdir(stagingRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === repoId || entry.startsWith(`${repoId}-`)) {
        await rm(join(stagingRoot, entry), { recursive: true, force: true });
      }
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private assertRepoId(repoId: string): void {
    if (!SAFE_REPO_ID.test(repoId)) {
      throw new RangeError('repo id is not a safe repo-store path segment');
    }
  }

  private validate(
    repoId: string,
    source: string | null | undefined,
  ):
    | { ok: true; kind: 'url' | 'path' | 'none'; source: string | null; cleanUrl: string | null }
    | RepoStoreFailure {
    if (!SAFE_REPO_ID.test(repoId)) {
      return {
        ok: false,
        reason: 'source_invalid',
        stage: 'preparing',
        detail: 'repository id is not a valid repo-store path segment',
      };
    }
    if (source === null || source === undefined) {
      return { ok: true, kind: 'none', source: null, cleanUrl: null };
    }

    const raw = source.trim();
    const invalid: RepoStoreFailure = {
      ok: false,
      reason: 'source_invalid',
      stage: 'preparing',
      detail: 'repository source must be an http(s) clone URL or an absolute path',
    };
    // A leading dash would be read as an option; control characters can smuggle
    // extra config/header lines. Argv never crosses a shell, so a space inside a
    // local path is harmless.
    if (raw.length === 0 || raw.startsWith('-') || /\p{Cc}/u.test(raw)) {
      return invalid;
    }

    if (isAbsolute(raw)) {
      return { ok: true, kind: 'path', source: normalize(raw), cleanUrl: null };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return invalid;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return invalid;
    if (url.username || url.password || !url.hostname) {
      return {
        ok: false,
        reason: 'source_invalid',
        stage: 'preparing',
        detail: 'repository URL must not embed credentials',
      };
    }
    url.hash = '';
    return { ok: true, kind: 'url', source: url.toString(), cleanUrl: url.toString() };
  }

  private async runGit(input: {
    readonly args: readonly string[];
    readonly stage: RepoStoreStage;
    readonly source: { kind: 'url' | 'path' | 'none'; cleanUrl: string | null };
    readonly authHeader?: string;
    readonly onProgress?: RepoStoreProgressListener;
    readonly signal?: AbortSignal;
  }): Promise<{ ok: true } | RepoStoreFailure> {
    let lease: RepoStoreCredentialLease | null = null;
    let outcome: { ok: true } | RepoStoreFailure;

    try {
      if (input.authHeader !== undefined) {
        if (input.source.kind !== 'url' || !input.source.cleanUrl) {
          return {
            ok: false,
            reason: 'source_invalid',
            stage: input.stage,
            detail: 'credentials are only usable with an http(s) source',
          };
        }
        if (!isSafeAuthHeader(input.authHeader)) {
          return {
            ok: false,
            reason: 'authentication_failed',
            stage: input.stage,
            detail: 'credential header is not a single-line header value',
          };
        }
        lease = await this.credentials.create(input.source.cleanUrl, input.authHeader);
      }

      const result = await this.runner.run({
        args: input.args,
        signal: input.signal ?? AbortSignal.timeout(REPO_STORE_ACQUIRE_TIMEOUT_MS),
        ...(lease ? { credentialConfigPath: lease.configPath } : {}),
        stage: input.stage,
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
      outcome =
        result.exitCode === 0
          ? { ok: true }
          : {
              ok: false,
              reason: classifyGitFailure(result),
              stage: input.stage,
              detail: result.stderr.trim() || result.stdout.trim() || 'git exited non-zero',
            };
    } catch (error) {
      outcome = this.fromThrown(error, input.stage);
    }

    if (lease) {
      try {
        // The runner settles only after the child stopped, so removing the
        // credential file here cannot race a still-reading git process.
        await lease.cleanup();
      } catch {
        // Fail closed: an unconfirmed credential removal is never reported as a
        // successful acquisition.
        outcome = {
          ok: false,
          reason: 'store_unavailable',
          stage: input.stage,
          detail: 'temporary credential could not be removed',
        };
      }
    }
    return outcome;
  }

  private fromThrown(error: unknown, stage: RepoStoreStage): RepoStoreFailure {
    if (error instanceof RepoStoreCommandError) {
      return {
        ok: false,
        reason:
          error.reason === 'aborted' ? 'aborted' : 'platform_dependency_unavailable',
        stage,
        detail:
          error.reason === 'aborted'
            ? 'operation was cancelled'
            : 'git is not available on the api host',
      };
    }
    if (error instanceof RepoStoreCredentialError) {
      return {
        ok: false,
        reason: 'store_unavailable',
        stage,
        detail: 'temporary credential storage failed',
      };
    }
    // Local filesystem errors keep their identity but never their raw message:
    // it can carry deployment paths that are not the caller's business.
    return {
      ok: false,
      reason: 'store_unavailable',
      stage,
      detail: 'repo store filesystem operation failed',
    };
  }

  /** Records a failure on the Repo row (when it exists) and returns it. */
  private async fail(
    repoId: string,
    failure: RepoStoreFailure,
  ): Promise<RepoStoreFailure> {
    await this.markStatus(repoId, 'failed');
    return failure;
  }

  /**
   * `updateMany` (not `update`) on purpose: acquisition may run before the
   * import flow has committed the Repo row, and a missing row must not turn a
   * status write into a thrown error.
   */
  private async markStatus(repoId: string, status: RepoCopyStatus): Promise<void> {
    await this.prisma.repo.updateMany({
      where: { id: repoId },
      data:
        status === 'missing'
          ? // `missing` claims no copy ever completed, so the successful-copy
            // timestamp must go with it (the DB shape check enforces this).
            { copyStatus: status, copyUpdatedAt: null }
          : { copyStatus: status },
    });
  }
}
