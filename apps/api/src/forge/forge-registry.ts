import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  type Forge,
  type ForgeKind,
  type ForgeRegistry,
  type ForgeRepoId,
  type ForgeTarget,
} from './forge.port';
import { GithubForge } from './github-forge';
import { GiteeForge } from './gitee-forge';
import { GitlabForge } from './gitlab-forge';

/** Well-known public git host per forge. */
const PUBLIC_HOST: Record<ForgeKind, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  gitee: 'gitee.com',
};
/** API base for each forge's public SaaS host. */
const PUBLIC_API_BASE: Record<ForgeKind, string> = {
  github: 'https://api.github.com',
  gitlab: 'https://gitlab.com/api/v4',
  gitee: 'https://gitee.com/api/v5',
};
/** Self-hosted API base suffix per kind. */
const API_SUFFIX: Record<ForgeKind, string> = {
  github: '/api/v3',
  gitlab: '/api/v4',
  gitee: '/api/v5',
};

/** The repo fields the registry detects from (a subset of the Prisma Repo row). */
export interface ForgeRepoInput {
  readonly gitSource: string;
  readonly forge?: string | null;
  readonly gitlabProjectId?: string | null;
}

/** A resolved forge location WITHOUT the credential (the token is added later). */
export type ForgeLocation = Omit<ForgeTarget, 'token'>;

/**
 * Resolves a forge kind → its {@link Forge} impl, and a repo → its
 * {@link ForgeLocation} via layered detection (explicit `Repo.forge` →
 * public-host inference → operator-configured `ForgeConnection` → null/skip).
 * Forge HTTP is a trusted call to the operator's own forge, so detection does NOT
 * apply `assertSafeProviderUrl`.
 */
@Injectable()
export class DefaultForgeRegistry implements ForgeRegistry {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubForge,
    private readonly gitee: GiteeForge,
    private readonly gitlab: GitlabForge,
  ) {}

  forKind(kind: ForgeKind): Forge {
    switch (kind) {
      case 'github':
        return this.github;
      case 'gitee':
        return this.gitee;
      case 'gitlab':
        return this.gitlab;
      default:
        throw new Error(`unknown forge kind: ${String(kind)}`);
    }
  }

  /**
   * Detect the forge location for a repo, or null when unresolved (→ push-back is
   * skipped). Only https git sources are resolvable.
   */
  async detect(repo: ForgeRepoInput): Promise<ForgeLocation | null> {
    const parsed = this.parseGitSource(repo.gitSource);
    if (!parsed) {
      return null;
    }
    const { host, segments } = parsed;

    // kind: explicit column > public-host inference > ForgeConnection.
    const explicit = this.normalizeKind(repo.forge);
    const inferred = this.inferPublicKind(host);
    const conn =
      explicit || inferred ? null : await this.prisma.forgeConnection.findUnique({ where: { host } });
    const kind = explicit ?? inferred ?? this.normalizeKind(conn?.kind ?? null);
    if (!kind) {
      return null;
    }

    // apiBase: public host → public base; else the ForgeConnection; else derive.
    let apiBaseUrl: string | null;
    if (host === PUBLIC_HOST[kind]) {
      apiBaseUrl = PUBLIC_API_BASE[kind];
    } else {
      const row = conn ?? (await this.prisma.forgeConnection.findUnique({ where: { host } }));
      apiBaseUrl = row?.apiBaseUrl ?? `https://${host}${API_SUFFIX[kind]}`;
    }

    const repoId = this.buildRepoId(kind, segments, repo.gitlabProjectId);
    if (!repoId) {
      return null;
    }
    return { kind, apiBaseUrl, cloneUrl: repo.gitSource, repoId };
  }

  /** Parse an https git source into host + path segments (strip `.git`). */
  private parseGitSource(
    gitSource: string,
  ): { host: string; segments: string[] } | null {
    let url: URL;
    try {
      url = new URL(gitSource);
    } catch {
      return null; // ssh / non-url forms are out of scope
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    const host = url.host.toLowerCase();
    const path = url.pathname.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    const segments = path.length > 0 ? path.split('/') : [];
    if (segments.length < 2) {
      return null;
    }
    return { host, segments };
  }

  private inferPublicKind(host: string): ForgeKind | null {
    if (host === 'github.com') return 'github';
    if (host === 'gitee.com') return 'gitee';
    if (host === 'gitlab.com') return 'gitlab';
    return null;
  }

  private normalizeKind(value: string | null | undefined): ForgeKind | null {
    return value === 'github' || value === 'gitee' || value === 'gitlab' ? value : null;
  }

  private buildRepoId(
    kind: ForgeKind,
    segments: string[],
    gitlabProjectId: string | null | undefined,
  ): ForgeRepoId | null {
    if (kind === 'gitlab') {
      const idOrPath = gitlabProjectId ?? segments.join('/');
      return idOrPath ? { style: 'project', idOrPath } : null;
    }
    // github / gitee: owner/repo (first two segments).
    const [owner, repo] = segments;
    return owner && repo ? { style: 'owner-repo', owner, repo } : null;
  }
}
