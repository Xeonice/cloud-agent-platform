/**
 * The Forge port (add-multi-forge-task-delivery).
 *
 * One abstraction over GitHub / Gitee / GitLab. A forge HTTP call is an ORDINARY
 * platform-process `fetch` to the operator's OWN connected forge (the
 * `github-repos.client.ts` precedent) — NOT an arbitrary URL, so it is NOT routed
 * through `assertSafeProviderUrl`. The ONLY git operation is the in-sandbox clone/
 * push, for which `cloneAuthHeader` supplies the `git -c http.extraHeader` value;
 * there is deliberately NO git-push method on the port (git lives in the sandbox).
 *
 * Implementations build per-forge requests + parse per-forge responses; the
 * differences (GitLab's `/merge_requests` + `source_branch`/`target_branch` + `iid`
 * + project id; Gitee's missing head filter) are isolated behind the three async
 * methods. Checkout/PR base resolution belongs to the shared task branch resolver,
 * never an independent forge metadata request.
 */

import type { ForgeKind } from '@cap/contracts';

export type { ForgeKind };

/**
 * How a forge addresses a repo — a discriminated union so a GitLab project id can
 * never leak into a github/gitee `owner/repo` path.
 */
export type ForgeRepoId =
  | { readonly style: 'owner-repo'; readonly owner: string; readonly repo: string }
  | { readonly style: 'project'; readonly idOrPath: string };

/** A fully-resolved forge call context (apiBase + decrypted token + repo id). */
export interface ForgeTarget {
  readonly kind: ForgeKind;
  /** API base, e.g. `https://api.github.com` / `https://gitlab.com/api/v4`. */
  readonly apiBaseUrl: string;
  /** Bare https clone URL, NO credential userinfo (the clone discipline). */
  readonly cloneUrl: string;
  readonly repoId: ForgeRepoId;
  /** Decrypted operator token. NEVER logged. */
  readonly token: string;
}

/** A normalized reference to an opened/found change request (PR or MR). */
export interface ChangeRequestRef {
  readonly number: number;
  readonly url: string;
  readonly state: 'open' | 'merged' | 'closed';
  readonly headBranch: string;
}

/** A repository the connected credential can access (the import picker shape). */
export interface AvailableRepo {
  readonly forge: ForgeKind;
  /** `owner/name` (github/gitee) or `namespace/project` (gitlab). */
  readonly fullPath: string;
  /** The https clone URL. */
  readonly gitSource: string;
  readonly visibility: string;
  readonly defaultBranch: string;
  /** GitLab numeric project id (cache), when known. */
  readonly gitlabProjectId?: string;
}

/** Args for opening a change request. */
export interface OpenChangeRequestArgs {
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The Forge port. `cloneAuthHeader` is synchronous + pure (the in-sandbox git
 * auth header). The four async methods are ordinary platform-process fetches.
 */
export interface Forge {
  readonly kind: ForgeKind;
  cloneAuthHeader(target: ForgeTarget): string;
  findExistingChangeRequest(
    target: ForgeTarget,
    headBranch: string,
  ): Promise<ChangeRequestRef | null>;
  openChangeRequest(
    target: ForgeTarget,
    args: OpenChangeRequestArgs,
  ): Promise<ChangeRequestRef>;
  listRepos(target: ForgeTarget): Promise<AvailableRepo[]>;
}

/** DI token for the {@link ForgeRegistry} that resolves a kind → {@link Forge}. */
export const FORGE = Symbol('FORGE');

/** Resolves a forge kind to its concrete {@link Forge} implementation. */
export interface ForgeRegistry {
  forKind(kind: ForgeKind): Forge;
}

// ---------------------------------------------------------------------------
// Shared helpers used by the concrete impls
// ---------------------------------------------------------------------------

/** Timeout for a single forge HTTP call. */
export const FORGE_HTTP_TIMEOUT_MS = 15_000;

/**
 * Builds the `git -c http.extraHeader` value (the in-sandbox clone/push auth):
 * `Authorization: Basic base64('<user>:<token>')`. The token rides this header
 * only — never the URL/`.git/config`.
 */
export function basicAuthHeader(user: string, token: string): string {
  const encoded = Buffer.from(`${user}:${token}`).toString('base64');
  return `Authorization: Basic ${encoded}`;
}

/** Thrown when a forge HTTP call returns a non-2xx (and is not a handled case). */
export class ForgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    message?: string,
  ) {
    super(message ?? `forge HTTP ${status}`);
    this.name = 'ForgeHttpError';
  }
}

/**
 * A single forge HTTP call (native fetch). Returns the parsed JSON for a 2xx, or
 * throws {@link ForgeHttpError} otherwise. A 204/empty body parses to null.
 */
export async function forgeFetch(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(FORGE_HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ForgeHttpError(res.status, text);
  }
  const json = text.length === 0 ? null : (JSON.parse(text) as unknown);
  return { status: res.status, json };
}
