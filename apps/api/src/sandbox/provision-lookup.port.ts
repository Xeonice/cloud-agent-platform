import type {
  SandboxEnvironmentProviderFamily,
  SandboxHostImageParameterProfile,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox';

/**
 * ProvisionLookup port — the per-task data the provider needs at provision time
 * but should NOT reach into the database for itself.
 *
 * Keeping this behind a port keeps provider packages and the API registry wiring
 * free of direct Prisma access. The Prisma-backed implementation lives in
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
   * the repo owner's connected forge PAT for private `https://github.com/...` repos.
   * Returns `null` when no repo/url resolves — the provider then SKIPS the clone.
   */
  getCloneSpec(taskId: string): Promise<CloneSpec | null>;

  /**
   * Resolve `taskId`'s operator-supplied prompt (`task.prompt`) — the goal the
   * provider injects into the sandbox at provision time so codex starts with it
   * pre-filled (aio-codex-prompt-autostart). Returns `null`/empty when the task
   * has no prompt; the provider then launches codex with a blank composer.
   * Lives behind the port (not a provider DB call) so the provider stays a pure
   * port consumer.
   */
  getTaskPrompt(taskId: string): Promise<string | null>;

  /**
   * Resolve `taskId`'s selected skill ids (`task.skills`) — the skills/methods
   * the operator chose to preinstall into the workspace at provision time
   * (task-preinstall-skills). Returns an empty array when none were selected.
   * Behind the port (not a provider DB call) so the provider stays a pure port
   * consumer (mirrors {@link getTaskPrompt}).
   */
  getTaskSkills(taskId: string): Promise<string[]>;

  /**
   * Resolve `taskId`'s selected agent runtime (`task.runtime`) so the runtime
   * registry can dispatch provisioning to the right agent. Returns the persisted
   * value (`'codex'` | `'claude-code'`) or `null` when the task is missing / has no
   * runtime (the registry then defaults to codex). WITHOUT this the registry can
   * never read the task's runtime, so EVERY task — including `claude-code` — falls
   * back to codex (the gap that silently routed claude tasks through codex before it
   * was wired). Behind the port (not a provider DB call) so the provider/registry
   * stay pure port consumers (mirrors {@link getTaskPrompt}).
   */
  getTaskRuntime(taskId: string): Promise<string | null>;

  /**
   * Resolve `taskId`'s selected execution mode (`task.execution_mode`) so the launch
   * mechanism knows whether to start the interactive TUI or the headless one-shot
   * (add-headless-execution-track). Returns the persisted value
   * (`'interactive-pty'` | `'headless-exec'`) or `null` when the task is missing / has
   * no mode (the launch path then defaults to `interactive-pty`, preserving today's
   * console behavior). Behind the port like {@link getTaskRuntime}.
   */
  getTaskExecutionMode(taskId: string): Promise<string | null>;

  /**
   * Resolve selected-image parameters that sandbox tools may consume at runtime.
   * Secret values are write-only for sandbox setup and must never be exposed
   * through selected-run/read APIs.
   */
  getTaskImageParameterProfile?(
    taskId: string,
    providerFamily: SandboxEnvironmentProviderFamily,
    runtimeId?: string | null,
  ): Promise<SandboxHostImageParameterProfile | null>;

  /**
   * Resolve the task's managed sandbox environment for a concrete provider
   * family. Returns null when the task has no explicit environment and no
   * compatible managed default exists, preserving deployment-level env fallbacks.
   */
  getResolvedEnvironment?(
    taskId: string,
    providerFamily: SandboxEnvironmentProviderFamily,
    runtimeId?: string | null,
  ): Promise<SandboxResolvedEnvironmentMetadata | null>;
}

/**
 * DI token for the {@link ProvisionLookup} port. The provider injects it by this
 * token so the Prisma-backed implementation can be swapped with no provider
 * change (and the provider never imports `PrismaService` directly).
 */
export const PROVISION_LOOKUP = Symbol('ProvisionLookup');
