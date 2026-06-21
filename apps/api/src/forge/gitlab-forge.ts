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

interface GlMr {
  iid: number;
  web_url: string;
  state: string;
  source_branch: string;
}
interface GlProject {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
  visibility: string;
  default_branch: string;
}

/**
 * GitLab Forge implementation — the outlier on every axis: `/merge_requests` (not
 * `/pulls`), `source_branch`/`target_branch`/`description` body, `state=opened`
 * (not `open`), `iid`/`web_url` response, a numeric/url-encoded project id, and a
 * `PRIVATE-TOKEN` header.
 */
@Injectable()
export class GitlabForge implements Forge {
  readonly kind = 'gitlab' as const;

  cloneAuthHeader(target: ForgeTarget): string {
    return basicAuthHeader('oauth2', target.token);
  }

  async resolveBaseBranch(target: ForgeTarget): Promise<string> {
    const { json } = await forgeFetch(
      `${target.apiBaseUrl}/projects/${this.projectId(target)}`,
      { headers: this.headers(target.token) },
    );
    return (json as { default_branch: string }).default_branch;
  }

  async findExistingChangeRequest(
    target: ForgeTarget,
    headBranch: string,
  ): Promise<ChangeRequestRef | null> {
    const { json } = await forgeFetch(
      `${target.apiBaseUrl}/projects/${this.projectId(target)}/merge_requests` +
        `?state=opened&source_branch=${encodeURIComponent(headBranch)}`,
      { headers: this.headers(target.token) },
    );
    const mrs = (json as GlMr[]) ?? [];
    return mrs.length > 0 ? this.mapMr(mrs[0]) : null;
  }

  async openChangeRequest(
    target: ForgeTarget,
    args: OpenChangeRequestArgs,
  ): Promise<ChangeRequestRef> {
    try {
      const { json } = await forgeFetch(
        `${target.apiBaseUrl}/projects/${this.projectId(target)}/merge_requests`,
        {
          method: 'POST',
          headers: { ...this.headers(target.token), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_branch: args.headBranch,
            target_branch: args.baseBranch,
            title: args.title,
            description: args.body,
          }),
        },
      );
      return this.mapMr(json as GlMr);
    } catch (err) {
      // 409/422 "merge request already exists" → reuse the existing one.
      if (err instanceof ForgeHttpError && (err.status === 409 || err.status === 422)) {
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
        `${target.apiBaseUrl}/projects?membership=true&per_page=${PER_PAGE}&page=${page}`,
        { headers: this.headers(target.token) },
      );
      const projects = (json as GlProject[]) ?? [];
      for (const p of projects) {
        out.push({
          forge: 'gitlab',
          fullPath: p.path_with_namespace,
          gitSource: p.http_url_to_repo,
          visibility: p.visibility,
          defaultBranch: p.default_branch,
          gitlabProjectId: String(p.id),
        });
      }
      if (projects.length < PER_PAGE) {
        break;
      }
    }
    return out;
  }

  private headers(token: string): Record<string, string> {
    return { 'PRIVATE-TOKEN': token };
  }

  private mapMr(m: GlMr): ChangeRequestRef {
    return {
      number: m.iid,
      url: m.web_url,
      state: m.state === 'opened' ? 'open' : m.state === 'merged' ? 'merged' : 'closed',
      headBranch: m.source_branch,
    };
  }

  /** URL-encoded numeric id or namespace/path (prefer the cached numeric id). */
  private projectId(target: ForgeTarget): string {
    if (target.repoId.style !== 'project') {
      throw new Error('gitlab forge requires a project repoId');
    }
    return encodeURIComponent(target.repoId.idOrPath);
  }
}
