/**
 * ProvisionLookup port — the per-task data the provider needs at provision time
 * but should NOT reach into the database for itself.
 *
 * Keeping this behind a port (rather than injecting `PrismaService` into
 * {@link AioSandboxProvider} directly) preserves the provider as a pure consumer
 * of small same-directory ports — which also keeps its focused unit test able to
 * `tsc`-compile the provider in isolation (its only value import stays
 * `dockerode`). The Prisma-backed implementation lives in
 * `prisma-provision-lookup.ts`.
 */
/**
 * How to clone a task's repository: the URL with NO embedded credential, plus an
 * optional git `http.extraHeader` carrying the auth.
 *
 * The token is deliberately kept OUT of `url` (and thus out of the clone command
 * line / the URL `git` echoes on failure) — it rides `authHeader` instead, so a
 * clone-failure stderr that quotes the URL can never leak the credential.
 */
export interface CloneSpec {
  /** Clone URL with NO credential userinfo — safe to log / echo on failure. */
  readonly url: string;
  /**
   * Optional git `http.extraHeader` value (e.g. `Authorization: Basic <b64>`)
   * for a private repo. Passed via `git -c http.extraHeader=...` so the token is
   * never embedded in the URL that `git` echoes in failure messages.
   */
  readonly authHeader?: string;
}

export interface ProvisionLookup {
  /**
   * Resolve how to clone `taskId`'s repository: the task's OWN `repo.gitSource`
   * (replacing the global `TASK_REPO_URL` stopgap), plus an `authHeader` carrying
   * the operator's GitHub token for private `https://github.com/...` repos.
   * Returns `null` when no repo/url resolves — the provider then SKIPS the clone.
   */
  getCloneSpec(taskId: string): Promise<CloneSpec | null>;
}

/**
 * DI token for the {@link ProvisionLookup} port. The provider injects it by this
 * token so the Prisma-backed implementation can be swapped with no provider
 * change (and the provider never imports `PrismaService` directly).
 */
export const PROVISION_LOOKUP = Symbol('ProvisionLookup');
