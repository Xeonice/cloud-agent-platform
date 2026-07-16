import { Injectable } from '@nestjs/common';
import { GitBranchNameSchema } from '@cap/contracts';
import {
  basicAuthHeader,
  forgeFetch,
  ForgeHttpError,
  type AvailableRepo,
  type ChangeRequestRef,
  type Forge,
  type ForgeTarget,
  type OpenChangeRequestArgs,
} from './forge.port';

/** Max pages fetched for the import picker (100/page → up to 1000 repos). */
const MAX_PAGES = 10;
const PER_PAGE = 100;

interface GhPull {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  head: { ref: string };
}
interface GhRepo {
  full_name: string;
  clone_url: string;
  private: boolean;
  default_branch: string;
}

/** GitHub (github.com + GitHub Enterprise) Forge implementation. */
@Injectable()
export class GithubForge implements Forge {
  readonly kind = 'github' as const;

  cloneAuthHeader(target: ForgeTarget): string {
    return basicAuthHeader('x-access-token', target.token);
  }

  async findExistingChangeRequest(
    target: ForgeTarget,
    headBranch: string,
  ): Promise<ChangeRequestRef | null> {
    const owner = this.owner(target);
    const { json } = await forgeFetch(
      `${target.apiBaseUrl}/repos/${this.ownerRepo(target)}/pulls` +
        `?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}`,
      { headers: this.headers(target.token) },
    );
    const pulls = (json as GhPull[]) ?? [];
    return pulls.length > 0 ? this.mapPull(pulls[0]) : null;
  }

  async openChangeRequest(
    target: ForgeTarget,
    args: OpenChangeRequestArgs,
  ): Promise<ChangeRequestRef> {
    try {
      const { json } = await forgeFetch(
        `${target.apiBaseUrl}/repos/${this.ownerRepo(target)}/pulls`,
        {
          method: 'POST',
          headers: { ...this.headers(target.token), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            head: args.headBranch,
            base: args.baseBranch,
            title: args.title,
            body: args.body,
          }),
        },
      );
      return this.mapPull(json as GhPull);
    } catch (err) {
      // 422 "A pull request already exists" → reuse the existing one (idempotent).
      if (err instanceof ForgeHttpError && err.status === 422) {
        const existing = await this.findExistingChangeRequest(target, args.headBranch);
        if (existing) {
          return existing;
        }
      }
      throw err;
    }
  }

  async listRepos(target: ForgeTarget): Promise<AvailableRepo[]> {
    const out: AvailableRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { json } = await forgeFetch(
        `${target.apiBaseUrl}/user/repos?per_page=${PER_PAGE}&page=${page}`,
        { headers: this.headers(target.token) },
      );
      const repos = (json as GhRepo[]) ?? [];
      for (const r of repos) {
        const defaultBranch = GitBranchNameSchema.safeParse(r.default_branch);
        if (!defaultBranch.success) continue;
        out.push({
          forge: 'github',
          fullPath: r.full_name,
          gitSource: r.clone_url,
          visibility: r.private ? 'private' : 'public',
          defaultBranch: defaultBranch.data,
        });
      }
      if (repos.length < PER_PAGE) {
        break;
      }
    }
    return out;
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private mapPull(p: GhPull): ChangeRequestRef {
    return {
      number: p.number,
      url: p.html_url,
      state: p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed',
      headBranch: p.head.ref,
    };
  }

  private ownerRepo(target: ForgeTarget): string {
    if (target.repoId.style !== 'owner-repo') {
      throw new Error('github forge requires an owner-repo repoId');
    }
    return `${target.repoId.owner}/${target.repoId.repo}`;
  }

  private owner(target: ForgeTarget): string {
    if (target.repoId.style !== 'owner-repo') {
      throw new Error('github forge requires an owner-repo repoId');
    }
    return target.repoId.owner;
  }
}
