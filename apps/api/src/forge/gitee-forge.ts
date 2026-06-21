import { Injectable } from '@nestjs/common';
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

const MAX_PAGES = 10;
const PER_PAGE = 100;

interface GiteePull {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  head: { ref: string };
}
interface GiteeRepo {
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
}

/**
 * Gitee Forge implementation. Endpoint + body shape mirror GitHub's `/pulls`
 * (head/base), but Gitee has NO server-side head filter, so existing-CR lookup
 * lists open PRs and filters client-side on `head.ref`.
 */
@Injectable()
export class GiteeForge implements Forge {
  readonly kind = 'gitee' as const;

  cloneAuthHeader(target: ForgeTarget): string {
    return basicAuthHeader('x-access-token', target.token);
  }

  async resolveBaseBranch(target: ForgeTarget): Promise<string> {
    const { json } = await forgeFetch(
      `${target.apiBaseUrl}/repos/${this.ownerRepo(target)}`,
      { headers: this.headers(target.token) },
    );
    return (json as { default_branch: string }).default_branch;
  }

  async findExistingChangeRequest(
    target: ForgeTarget,
    headBranch: string,
  ): Promise<ChangeRequestRef | null> {
    // Gitee has no head query filter → list open PRs and filter client-side. The
    // unique cap/task-<id> branch makes a first-page scan sufficient.
    const { json } = await forgeFetch(
      `${target.apiBaseUrl}/repos/${this.ownerRepo(target)}/pulls` +
        `?state=open&per_page=${PER_PAGE}`,
      { headers: this.headers(target.token) },
    );
    const pulls = (json as GiteePull[]) ?? [];
    const match = pulls.find((p) => p.head?.ref === headBranch);
    return match ? this.mapPull(match) : null;
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
      return this.mapPull(json as GiteePull);
    } catch (err) {
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
      const repos = (json as GiteeRepo[]) ?? [];
      for (const r of repos) {
        out.push({
          forge: 'gitee',
          fullPath: r.full_name,
          gitSource: r.html_url,
          visibility: r.private ? 'private' : 'public',
          defaultBranch: r.default_branch,
        });
      }
      if (repos.length < PER_PAGE) {
        break;
      }
    }
    return out;
  }

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private mapPull(p: GiteePull): ChangeRequestRef {
    return {
      number: p.number,
      url: p.html_url,
      state: p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed',
      headBranch: p.head.ref,
    };
  }

  private ownerRepo(target: ForgeTarget): string {
    if (target.repoId.style !== 'owner-repo') {
      throw new Error('gitee forge requires an owner-repo repoId');
    }
    return `${target.repoId.owner}/${target.repoId.repo}`;
  }
}
