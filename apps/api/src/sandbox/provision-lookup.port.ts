import type {
  GitCloneSpec,
  SandboxEnvironmentProviderFamily,
  SandboxHostImageParameterProfile,
  SandboxResolvedEnvironmentMetadata,
  SandboxResourceSnapshot,
  SandboxWorkspaceMaterializationPlan,
  TaskModelIntent,
} from '@cap/sandbox';
import type { ExecutionMode, Runtime } from '@cap/contracts';

/**
 * ProvisionLookup port — the per-task data the provider needs at provision time
 * but should NOT reach into the database for itself.
 *
 * Keeping this behind a port keeps provider packages and the API registry wiring
 * free of direct Prisma access. The Prisma-backed implementation lives in
 * `prisma-provision-lookup.ts`.
 */
/**
 * @deprecated Compatibility alias for the pre-staged clone path. Canonical new
 * admission work carries `SandboxWorkspaceMaterializationPlan.credential`, so
 * API orchestration has one exact-host redacted descriptor instead of defining
 * another raw provider-neutral credential shape here.
 */
export type CloneSpec = GitCloneSpec;

export interface SandboxPinnedEnvironmentMetadata
  extends SandboxResolvedEnvironmentMetadata {
  readonly providerId: string;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly cliArtifactChecksum: string;
}

/** One atomic persisted read used by admission, recovery, and terminal launch. */
export type TaskLaunchContext =
  | {
      readonly modelIntent: Extract<TaskModelIntent, { kind: 'runtime-default' }>;
      readonly ownerUserId: string | null;
      readonly runtimeId: Runtime;
      readonly executionMode: ExecutionMode;
      readonly resources?: SandboxResourceSnapshot;
      readonly workspaceMaterializationDeadlineMs: number;
      readonly environment?: undefined;
    }
  | {
      readonly modelIntent: Extract<TaskModelIntent, { kind: 'explicit' }>;
      readonly ownerUserId: string;
      readonly runtimeId: Runtime;
      readonly executionMode: ExecutionMode;
      readonly resources?: SandboxResourceSnapshot;
      readonly workspaceMaterializationDeadlineMs: number;
      readonly environment: SandboxPinnedEnvironmentMetadata;
    };

export interface ProvisionLookup {
  /**
   * Resolve persisted model intent and its immutable execution snapshot in one
   * database read. Missing/corrupt explicit state throws a typed setup failure;
   * it is never represented as runtime-default.
   */
  getTaskLaunchContext(taskId: string): Promise<TaskLaunchContext>;

  /**
   * Legacy adapter-only clone input. The production Prisma implementation fails
   * closed here: canonical task planning must use `getTaskWorkspacePlan()` so a
   * provider never lets an unqualified clone choose remote HEAD implicitly.
   */
  getCloneSpec(taskId: string): Promise<CloneSpec | null>;

  /**
   * Canonical immutable Git workspace input. Provision planning prefers this
   * over the compatibility clone spec so checkout never relies on remote HEAD.
   * Optional only for legacy/test adapters that have not migrated to staged
   * materialization; the production Prisma lookup implements it and must return
   * a concrete plan or throw. An adapter that cannot provide canonical planning
   * must omit the method rather than return null/undefined.
   */
  getTaskWorkspacePlan?(
    taskId: string,
  ): Promise<SandboxWorkspaceMaterializationPlan>;

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
