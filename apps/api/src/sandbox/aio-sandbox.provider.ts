import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import Docker from 'dockerode';

import type {
  DeliverWorkspaceArgs,
  DeliverWorkspaceResult,
  ProvisionContext,
  SandboxConnection,
  SandboxMode,
  SandboxProviderCapability,
  SandboxProvider,
  SelectedSandboxRun,
} from './sandbox-provider.port.js';
import { CODEX_AUTH_SOURCE, type CodexAuthSource } from './codex-auth-source.port';
import {
  CLAUDE_AUTH_SOURCE,
  type ClaudeAuthSource,
} from './claude-auth-source.port';
import type {
  AuthMaterial,
  LaunchContext,
  RuntimeId,
  SandboxRuntimePreflightProbe,
  SandboxSetupCommand,
} from '../agent-runtime/agent-runtime.port';
import { sessionIdForTask } from '../agent-runtime/agent-runtime.integration';
// The codex DEFAULT runtime, used when the registry cannot resolve one (an
// unresolved/errored task or a partial wiring) — the same "fall back to codex"
// behavior the inline path had before this refactor, now via the runtime's own
// sandboxSetupCommands emitter rather than provider-inline injection.
import { CodexRuntime } from '../agent-runtime/codex-runtime';
import { PROVISION_LOOKUP, type ProvisionLookup } from './provision-lookup.port';
import type { TranscriptSource } from './transcript-source';
import { resolveSkillInstaller } from './skill-allowlist';
import {
  AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS,
  AIO_SANDBOX_TRIM_TIMEOUT_MS,
  AIO_SANDBOX_WORKSPACE_DIR,
  AioSandboxContainerController,
  buildAioSandboxConnection,
  scrubAioExecSecrets,
  type SandboxCommandExecutor,
  type SandboxCommandEndpointDescriptor,
  type SandboxRetentionPolicy,
  type SandboxTerminalEndpointDescriptor,
  type SandboxWorkspaceDescriptor,
  type AioDockerClient,
} from '@cap/sandbox';
import { buildSandboxWorkspaceBridge } from './sandbox-workspace-bridge';
import {
  createAioHttpCommandExecutor,
  toLegacySandboxExecResult,
} from './sandbox-command-executor';
import {
  RUNTIME_MATERIAL_RESOLVER_REGISTRY,
  RuntimeMaterialResolverRegistry,
  createDefaultRuntimeMaterialResolverRegistry,
} from './runtime-material-resolver';
// add-claude-code-runtime Track 3 (3.1): the provider delegates per-runtime
// credential/config injection and the pre-stop trim to the task's selected
// AgentRuntime (resolved by the RuntimeRegistry, Track 2) instead of hard-coding
// codex auth.json + the codex `~/.codex` trim. The provider stays a pure port
// consumer: it supplies a {@link SandboxExec} closure (its own `/v1/shell/exec`
// surface) and the runtime decides WHAT to write (codex: auth.json + config.toml;
// claude: pre-seeded `.claude.json` + the env token carried on the launch line)
// and WHAT to trim before stop, so codex behavior is byte-identical (CodexRuntime
// moves today's logic) and claude diverges only inside its own runtime impl.
//
// CONSUMED PORT CONTRACT (refactor-agent-runtime-policy-mechanism): the provider
// depends on the SINGLE `AgentRuntime` port (agent-runtime.port.ts, re-exported via
// the integration) through the {@link RuntimeRegistry}. It uses only the pure
// PROVISION-TIME policy — `id`, `sandboxSetupCommands(ctx, material)` (the ordered
// setup commands), and `preStopTrimCommands()` — and resolves the per-runtime auth
// material itself (CODEX_AUTH_SOURCE + SSRF / CLAUDE_AUTH_SOURCE). The pty client owns
// the launch/terminal/detectExit seams; the RuntimeAdapter translation layer is gone.
import {
  RUNTIME_REGISTRY,
  type AgentRuntime,
  type RuntimeRegistry,
  type SandboxExec,
  type SandboxExecResult,
} from '../agent-runtime/agent-runtime.integration';

/**
 * AIO Sandbox `SandboxProvider` (aio-sandbox-execution, design D — connect-in).
 *
 * This is the connect-in replacement for the old dial-back `DockerSandboxProvider`.
 * For each task it dockerode-creates exactly ONE per-task AIO Sandbox container
 * named `cap-aio-<taskId>` from the PINNED derived AIO image, starts it, waits
 * for HTTP readiness (`GET /v1/docs`), clones the task repository into the
 * sandbox workspace via `POST /v1/shell/exec`, and returns an addressable
 * {@link SandboxConnection} handle. The orchestrator (the WebSocket *client*)
 * then dials the container **by name** on the private `cap-net` network — there
 * is no dial-back to authenticate, so no per-task token is issued or returned.
 *
 * WHY THIS IS THE PER-TASK EXECUTION SANDBOX (inverting the old Docker provider):
 *   Under AIO Sandbox the per-task container IS the execution boundary. Isolation
 *   comes from TWO container-level properties, NOT from a reported sandbox mode:
 *     1. `seccomp=unconfined` — AIO requires it to run; the container is the
 *        boundary, not the seccomp profile.
 *     2. Network isolation — the container joins ONLY the private `cap-net`
 *        network and publishes NO host port, so only the orchestrator on
 *        `cap-net` can reach its open (token-less) HTTP/WS API.
 *   `getSandboxMode()` is therefore INFORMATIONAL only (see the port doc).
 *
 * SECURITY INVARIANT (enforced here): a container created WITHOUT
 * `seccomp=unconfined` is treated as INVALID and is never used for execution —
 * `provision()` asserts the `SecurityOpt` it built before starting the container.
 *
 * Configuration (read from the provider's own environment at provision time):
 *   - `AIO_SANDBOX_IMAGE` (required) — the PINNED derived AIO image tag (built
 *     FROM `ghcr.io/agent-infra/sandbox:<tag>` with codex + hooks baked in).
 *     MUST be a pinned tag; using `:latest` is rejected so provisioning is
 *     reproducible.
 *   - `AIO_SANDBOX_NETWORK` (optional) — the user-defined docker network the
 *     sandbox joins so it is reachable by container name; default `cap-net`.
 *   - `AIO_SANDBOX_READINESS_TIMEOUT_MS` (optional) — upper bound on the
 *     `/v1/docs` readiness poll; default 60000.
 *   - `TASK_REPO_URL` (optional) — a GLOBAL FALLBACK clone URL only. The per-task
 *     clone URL is now resolved via the {@link ProvisionLookup} port
 *     (`task → repo.gitSource`, with the repo owner's connected forge PAT attached as an
 *     `http.extraHeader` auth — never embedded in the URL — for private repos);
 *     `TASK_REPO_URL` is used only when that task/repo lookup yields nothing.
 *
 * Codex auth: `/home/gem/.codex/auth.json` is injected via the
 * {@link CodexAuthSource} port AFTER readiness and BEFORE the handle returns, so
 * codex authenticates when the gateway auto-launches it. A post-start failure
 * (readiness / auth-inject / clone) tears the container down before rethrowing,
 * so a failed provision never leaks a running container.
 */
@Injectable()
export class AioSandboxProvider
  implements SandboxProvider, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AioSandboxProvider.name);
  private readonly docker = new Docker();
  private aioController?: AioSandboxContainerController<Docker.Container>;
  private readonly materialResolvers: RuntimeMaterialResolverRegistry;

  private get controller(): AioSandboxContainerController<Docker.Container> {
    return (this.aioController ??= new AioSandboxContainerController({
      docker: this.docker as unknown as AioDockerClient<Docker.Container>,
      logger: {
        debug: (message) => this.logger.debug(message),
        log: (message) => this.logger.log(message),
        warn: (message) => this.logger.warn(message),
      },
    }));
  }

  /**
   * @param lookup           Resolves the per-task clone URL (`task → repo.gitSource`
   *                         with the repo owner's connected forge PAT spliced in for private
   *                         repos), replacing the global `TASK_REPO_URL` stopgap.
   *                         Behind a port so the provider never touches the DB
   *                         directly (keeps its focused unit test compilable in
   *                         isolation).
   * @param codexAuthSource  Supplies the codex `auth.json` injected into each
   *                         sandbox before codex launches (deployment-level env
   *                         source today; see {@link CodexAuthSource}). Still
   *                         injected here so the {@link CodexAuthSource} binding is
   *                         unchanged; the runtime reads it through the registry.
   * @param runtimes         The {@link RuntimeRegistry} (add-claude-code-runtime
   *                         Track 2) that resolves the task's selected
   *                         {@link AgentRuntime}. The provider delegates auth/config
   *                         injection and the pre-stop trim to it (3.1) so codex
   *                         stays byte-identical and claude diverges only inside its
   *                         own runtime impl.
   */
  constructor(
    @Inject(PROVISION_LOOKUP) private readonly lookup: ProvisionLookup,
    @Inject(CODEX_AUTH_SOURCE) private readonly codexAuthSource: CodexAuthSource,
    @Inject(RUNTIME_REGISTRY) private readonly runtimes: RuntimeRegistry,
    // Optional so a partial/legacy wiring (no claude source) still constructs; a
    // claude task with no source then fails closed at sandboxSetupCommands.
    @Optional()
    @Inject(CLAUDE_AUTH_SOURCE)
    private readonly claudeAuth?: ClaudeAuthSource,
    @Optional()
    @Inject(RUNTIME_MATERIAL_RESOLVER_REGISTRY)
    materialResolvers?: RuntimeMaterialResolverRegistry,
  ) {
    this.materialResolvers =
      materialResolvers ??
      createDefaultRuntimeMaterialResolverRegistry({
        codexAuthSource,
        claudeAuthSource: claudeAuth,
        warn: (message) => this.logger.warn(message),
      });
  }

  /**
   * Dedicated, EMPTY workspace directory the task repository is cloned into.
   * NEVER the non-empty `/home/gem` HOME (cloning into it fails with
   * "destination path already exists and is not an empty directory").
   */
  private static readonly WORKSPACE_DIR = AIO_SANDBOX_WORKSPACE_DIR;
  /**
   * Upper bound on a single skill installer's wall-clock (task-preinstall-skills).
   * The live spike measured ~3–6s with warm egress; this generous ceiling covers
   * a cold `npx` fetch. On timeout the skill is skipped (fail-soft), never
   * blocking the provision.
   */
  private static readonly SKILL_INSTALL_TIMEOUT_MS = AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS;

  /**
   * Upper bound on the pre-stop `~/.codex` trim's wall-clock (D4). The trim is a
   * single `rm`/truncate over the live sandbox; this ceiling keeps a wedged
   * sandbox from stalling settle. On timeout the trim is skipped (the kept
   * container is just larger) and the stop proceeds — never fatal.
   */
  private static readonly TRIM_TIMEOUT_MS = AIO_SANDBOX_TRIM_TIMEOUT_MS;

  /**
   * Reported sandbox mode, surfaced as INFORMATIONAL metadata only. The real
   * isolation boundary is the AIO container (`seccomp=unconfined` + `cap-net`
   * network isolation, no host port), not this value.
   */
  getSandboxMode(): SandboxMode {
    return 'danger-full-access';
  }

  getProviderCapabilities(): readonly SandboxProviderCapability[] {
    return [
      'terminal.websocket',
      'workspace.git.materialize',
      'workspace.git.deliver',
      'transcript.retained-read',
      'lifecycle.readopt',
    ];
  }

  getTerminalDescriptor(taskId: string): SandboxTerminalEndpointDescriptor {
    const connection = this.connectionForTask(taskId);
    return {
      protocol: 'aio-json-v1',
      wsUrl: connection.wsUrl,
      metadata: { provider: 'aio-local' },
    };
  }

  getCommandDescriptor(taskId: string): SandboxCommandEndpointDescriptor {
    const connection = this.connectionForTask(taskId);
    return {
      protocol: 'aio-http-exec-v1',
      baseUrl: connection.baseUrl,
      workingDirectory: AioSandboxProvider.WORKSPACE_DIR,
      metadata: { provider: 'aio-local' },
    };
  }

  getWorkspaceDescriptor(_taskId: string): SandboxWorkspaceDescriptor {
    return {
      mode: 'git',
      path: AioSandboxProvider.WORKSPACE_DIR,
      git: {
        materialized: true,
        deliverable: true,
      },
      metadata: { provider: 'aio-local' },
    };
  }

  getRetentionPolicy(_taskId: string): SandboxRetentionPolicy {
    return {
      mode: 'stop-retain',
      retainTranscript: true,
      cleanupEligible: true,
      metadata: { provider: 'aio-local' },
    };
  }

  async getSelectedSandboxRun(taskId: string): Promise<SelectedSandboxRun> {
    const connection = this.connectionForTask(taskId);
    return {
      taskId,
      providerId: 'aio-local',
      providerSandboxId: connection.taskId,
      provider: this,
      capabilities: this.getProviderCapabilities(),
      connection,
      terminal: this.getTerminalDescriptor(taskId),
      command: this.getCommandDescriptor(taskId),
      workspace: this.getWorkspaceDescriptor(taskId),
      retention: this.getRetentionPolicy(taskId),
    };
  }

  /**
   * Provision the per-task AIO Sandbox container and return its addressable
   * {@link SandboxConnection} handle. Idempotent: a second call for an already
   * provisioned task returns the equivalent handle without creating a second
   * container.
   */
  async provision(ctx: ProvisionContext): Promise<SandboxConnection> {
    // Idempotent for an already-provisioned task.
    const existing = this.controller.getConnection(ctx.taskId);
    if (existing) return existing;

    const { spec, connection } = await this.controller.createAndStart(ctx.taskId);

    // Post-start steps run against the now-LIVE, already-registered container and
    // can fail (injectCodexAuth / cloneTaskRepository fail CLOSED on a non-zero
    // exit). On ANY failure here the controller has retained the container handle,
    // so tear it down before rethrowing; otherwise a failed provision leaks a running
    // cap-aio-<taskId> and a clean retry is impossible. The caller (guardrails) then
    // fails the task and releases the run slot.
    try {
      // Readiness: do not treat the sandbox as usable until its HTTP API answers.
      await this.controller.waitForReadiness({
        baseUrl: connection.baseUrl,
        taskId: ctx.taskId,
        timeoutMs: spec.readinessTimeoutMs,
      });
      // Sandbank-style selected run context: resolve the runtime ONCE for this
      // provision and carry that selected runtime through preflight + setup, so a
      // DB/settings race cannot make the image probes and setup commands disagree.
      const runtime = await this.resolveProvisionRuntime(ctx.taskId);
      const executor = this.createCommandExecutor(connection.baseUrl);
      // Sandbank-aligned runtime preflight: the runtime declares the image tools
      // it needs and the provider probes them before writing credentials or
      // materializing the repository.
      await this.preflightRuntime(executor, ctx.taskId, runtime);
      // 3.1 — delegate credential/config + prompt injection to the task's selected
      // AgentRuntime. CODEX stays byte-identical: for a `codex` task the provider
      // runs the SAME `injectCodexAuth` (config.toml/auth.json or the
      // compatible-provider block) + `injectTaskPrompt` it ran inline before, so
      // the existing codex e2e is unchanged. CLAUDE delegates to the runtime's
      // `injectAuth`, which pre-seeds `~/.claude/.claude.json` (global onboarding +
      // per-project trust) + the prompt file and FAILS CLOSED with a
      // "runtime not configured" reason when no `CLAUDE_CODE_OAUTH_TOKEN` is set
      // (the OAuth token itself rides the launch ENV, written by the runtime's
      // buildLaunchLine, not an auth file). Both AFTER readiness, BEFORE the handle
      // returns; fail CLOSED on a non-zero exit so a broken setup never silently
      // burns a run slot. The taskId scopes the codex credential to the task's
      // OWNING account (owner-scoped resolution, design D3).
      await this.injectRuntimeSetup(executor, ctx.taskId, runtime);
      await this.cloneTaskRepository(executor, ctx.taskId, ctx.cloneSpec);
      // task-preinstall-skills: AFTER the clone (the installers run against the
      // cloned workspace) and before the handle returns. FAIL-SOFT — a skill
      // installer failure is logged but does NOT abort provision (codex still
      // launches without that skill), so this is NOT in the fail-closed try/throw
      // contract of auth/clone above; it swallows its own errors internally.
      await this.preinstallSkills(executor, ctx.taskId);
    } catch (err) {
      await this.teardownSandbox(ctx.taskId).catch(() => undefined);
      throw err;
    }

    return this.controller.registerConnection(connection);
  }

  /**
   * Settle a task's sandbox: STOP it but KEEP it (retention D1). The stopped
   * container's codex rollout + workspace stay readable for history replay; the
   * retention cleaner removes it later via {@link removeSandbox}. Before stop we
   * trim `~/.codex` (drop the ~92MB cache + zero `auth.json`) so a kept container
   * is ~15MB and holds no live credential (D4). Idempotent + never throws —
   * settling a task that already exited or never started is a safe no-op.
   */
  async teardownSandbox(taskId: string): Promise<void> {
    await this.controller.teardownSandbox(taskId, {
      beforeStop: async ({ baseUrl }) => {
        const executor = this.createCommandExecutor(baseUrl);
        // 3.1 — the pre-stop trim is DISPATCHED to the task's selected runtime: codex
        // trims `~/.codex`; claude trims `~/.claude` while keeping transcript projects.
        // fix-codex-headless-subscription-auth: capture codex's possibly refreshed
        // auth.json BEFORE the trim zeroes it. Both hooks are best-effort internally.
        await this.captureAndPersistCodexAuth(executor, taskId);
        await this.trimRuntimeHomeBeforeStop(executor, taskId);
      },
    });
  }

  /**
   * IN-SANDBOX result delivery (add-multi-forge-task-delivery): over the SAME
   * `/v1/shell/exec` channel as clone, commit the working-tree diff to `branch`
   * and push it to `origin`. The auth header rides `git -c http.extraHeader` only
   * (the clone discipline); the commit message is base64-decoded to a file so it
   * never touches the shell command line (injection-safe). A clean tree returns
   * `{hadChanges:false}`; any git failure returns a scrubbed `error`.
   */
  async deliverWorkspaceChanges(
    taskId: string,
    args: DeliverWorkspaceArgs,
  ): Promise<DeliverWorkspaceResult> {
    const baseUrl = this.controller.resolveBaseUrl(taskId);
    const executor = this.createCommandExecutor(baseUrl);
    return buildSandboxWorkspaceBridge({
      executor,
      descriptor: this.getWorkspaceDescriptor(taskId),
    }).deliverGit({
      taskId,
      timeoutMs: AioSandboxProvider.TRIM_TIMEOUT_MS,
      deliver: args,
    });
  }

  /**
   * Force-remove a STOPPED retained container (the retention cleaner / disk-floor
   * eviction path). Separate from {@link teardownSandbox} (which only stops) so
   * the lifecycle keeps the container and only the cleaner deletes it. Idempotent.
   */
  async removeSandbox(taskId: string): Promise<void> {
    await this.controller.removeSandbox(taskId);
  }

  /**
   * Pre-stop HOME trim, dispatched to the task's selected {@link AgentRuntime} via its
   * `preStopTrimCommands` emitter (no agent-identity branch). codex trims `~/.codex`
   * keeping `sessions/`; claude trims `~/.claude` keeping `projects/`. FAIL-OPEN: a
   * resolution error, an unresolved runtime (→ codex default), or any trim-command
   * failure all degrade to "the kept container is just larger" — NEVER throws, NEVER
   * blocks the stop. Each command is time-boxed so settling stays fast even if the
   * sandbox is wedged.
   */
  private async trimRuntimeHomeBeforeStop(
    executor: SandboxCommandExecutor,
    taskId: string,
  ): Promise<void> {
    let runtime: { preStopTrimCommands(): readonly string[] } | undefined;
    try {
      runtime = await this.resolveRuntime(taskId);
    } catch {
      runtime = undefined;
    }
    const commands = (runtime ?? new CodexRuntime()).preStopTrimCommands();
    for (const command of commands) {
      await this.runTrimCommandBestEffort(executor, taskId, command);
    }
  }

  /**
   * Capture codex's (possibly refreshed) `auth.json` out of the container and persist it back to
   * the owner's stored credential BEFORE the pre-stop trim zeroes it
   * (fix-codex-headless-subscription-auth). codex's ChatGPT `refresh_token` is single-use/rotating;
   * persisting the post-run document keeps a stored OFFICIAL credential alive across tasks instead
   * of reusing a revoked seed. Only codex writes `~/.codex/auth.json`, so a non-codex runtime is
   * skipped; `persistRefreshedAuth` is itself owner-scoped + official-only + validated, so a
   * compatible/env-fallback task is a safe no-op. NEVER throws or blocks the stop.
   */
  private async captureAndPersistCodexAuth(
    executor: SandboxCommandExecutor,
    taskId: string,
  ): Promise<void> {
    try {
      let runtime: AgentRuntime | undefined;
      try {
        runtime = await this.resolveRuntime(taskId);
      } catch {
        runtime = undefined;
      }
      // claude has no ~/.codex/auth.json; an unresolved runtime defaults to codex, so it proceeds.
      if (runtime && runtime.id !== 'codex') return;
      const exec = this.runSandboxExec(executor);
      const res = await exec('cat /home/gem/.codex/auth.json 2>/dev/null');
      if (res.exitCode !== 0) return; // missing/unreadable (e.g. compatible writes no auth.json)
      const authJson = typeof res.output === 'string' ? res.output.trim() : '';
      if (!authJson) return;
      await this.codexAuthSource.persistRefreshedAuth(taskId, authJson);
    } catch (err) {
      // Best-effort: a failed capture just means the next task may re-refresh — never block stop.
      this.logger.warn(
        `codex auth refresh-persist skipped for ${taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Run ONE pre-stop trim command best-effort: time-boxed, warn-only on a non-`ok`
   * HTTP status or any error — it must NEVER throw or block the stop+retain. The
   * trim command itself keeps the transcript (codex `sessions/`, claude `projects/`),
   * drops caches, and zeroes credentials; see the runtimes' `preStopTrimCommands`.
   */
  private async runTrimCommandBestEffort(
    executor: SandboxCommandExecutor,
    taskId: string,
    command: string,
  ): Promise<void> {
    try {
      const result = await executor.exec({
        command,
        timeoutMs: AioSandboxProvider.TRIM_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        this.logger.warn(
          `pre-stop HOME trim for task ${taskId} exited ${result.exitCode} (not fatal)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `pre-stop HOME trim for task ${taskId} failed (not fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * RESUME-RUN SEAM (deferred follow-up; verified in spike-findings.md but NOT
   * shipped this change). A retained stopped container resumes via:
   *   `docker commit <cap-aio-id>` → run a NEW container from that image with
   *   `--entrypoint /opt/gem/entrypoint.sh` (skipping AIO's non-idempotent
   *   `run.sh` init — `run.sh` itself ends with `exec /opt/gem/entrypoint.sh`),
   *   then re-inject fresh codex auth + re-attach the gateway PTY + take a slot.
   * This documents the named extension point only — no behavior lands here yet.
   */
  // resumeRun(taskId): commit + runFromResumeImage — see spike-findings.md §D.

  /**
   * Read the runtime's transcript source out of a STOPPED, retained `cap-aio-<taskId>`
   * container for read-only history replay (D3; generalized by unify-transcript-parsers
   * D3). Uses dockerode `getArchive`, which streams a tar of the container's FROZEN layer
   * WITHOUT restarting it — so an `Exited` sandbox is read in place. Scoped to the
   * runtime-declared transcript dir only: it never pulls `auth.json` or any credential
   * file out of the container.
   *
   * Resolves WHERE from the runtime's {@link AgentRuntime.transcriptArtifact} (codex →
   * `~/.codex/sessions/rollout-*.jsonl`, claude → `~/.claude/projects/<slug>/<sid>.jsonl`)
   * and HOW from its {@link AgentRuntime.readTranscriptSource} strategy. For the
   * single-newest-JSONL strategy (codex/claude) it returns the discriminated
   * {@link TranscriptSource} `{ format, jsonl }` whose `jsonl` is the BYTE-IDENTICAL
   * lexicographically-newest matching file — the prior raw text, now tagged with the
   * runtime's `transcriptFormat` so the parser registry dispatches without a re-derivation.
   *
   * Returns `null` when no source is present — container reaped/expired, path missing, or
   * the agent never ran (provision_failed / agent_failed_to_start). The endpoint maps
   * `null` to the honest `empty`/`expired` states; this method NEVER throws into the caller
   * (no container / no match / unreadable → absent source). An omitted/unresolvable runtime
   * degrades to the codex default, exactly like the provision-time setup path.
   */
  async readRolloutFromContainer(
    taskId: string,
    runtimeId?: RuntimeId | null,
  ): Promise<TranscriptSource | null> {
    // Resolve the task's runtime defensively: a registry hiccup (or a focused unit context
    // with no wired registry) degrades to the codex default — the SAME fall-back the
    // provision-time setup path uses — so a resolution failure can never throw into this
    // non-throwing read contract.
    let runtime: AgentRuntime;
    try {
      runtime = this.runtimes?.resolve?.(runtimeId) ?? new CodexRuntime();
    } catch {
      runtime = new CodexRuntime();
    }
    // WHERE: the runtime declares its transcript dir/glob. Pulls ONLY that dir out of the
    // container — never a credential file. WHAT: the runtime's `transcriptFormat` tags the
    // returned source so the parser registry dispatches with no re-derivation.
    const ctx: LaunchContext = {
      taskId,
      workspaceDir: '/home/gem/workspace',
      sessionId: sessionIdForTask(taskId),
    };
    const { dir, filenameGlob } = runtime.transcriptArtifact(ctx);
    const format = runtime.transcriptFormat;
    // HOW: read the source per the runtime-declared strategy. Today every runtime declares
    // the single-newest-JSONL read; a future multi-record runtime declares a different
    // strategy without editing this dispatch.
    if (runtime.readTranscriptSource.kind === 'single-newest-jsonl') {
      const jsonl = await this.controller.readSingleNewestJsonl(taskId, dir, filenameGlob);
      return jsonl === null ? null : { format, jsonl };
    }
    return null;
  }

  /**
   * Whether the per-task `cap-aio-<taskId>` container still EXISTS (running OR
   * stopped/retained). Lets the history endpoint tell an aged-out/reaped session
   * (`expired`) apart from a container that exists but produced no rollout
   * (`empty`). `inspect()` 404s when the container is gone → false; never throws.
   */
  async sandboxExists(taskId: string): Promise<boolean> {
    return this.controller.sandboxExists(taskId);
  }

  /**
   * Boot RE-ADOPTION pass (survive-api-redeploy D3) — supersedes the old
   * "force-remove every RUNNING `cap-aio-*` orphan" reap.
   *
   * RUNTIME-AGNOSTIC (add-claude-code-runtime 3.4): EVERY agent runtime (codex AND
   * claude-code) runs in the SAME DETACHED named tmux session `task<taskId>`
   * (`detachedSessionName`), so re-adoption makes NO codex-specific assumption — it
   * keys solely off the session NAME, which is a pure function of `taskId`, not the
   * agent. Because that session outlives the orchestrator's `/v1/shell/ws`
   * connection, a RUNNING `cap-aio-*` container left by a prior process is NOT
   * automatically an orphan: its agent may still be executing. So on boot we list
   * RUNNING `cap-aio-*`, parse each `taskId`, and probe the detached session via
   * {@link hasLiveSession} (`tmux has-session -t task<taskId>` over the container's
   * own `/v1/shell/exec`):
   *   - LIVE session  → RE-ADOPT: re-register the provider/connection maps and
   *     mark the task in {@link readopted} so the guardrails recovery (Track 4)
   *     can DB-validate it (`running`/`awaiting_input`) and re-attach its
   *     terminal. On re-attach the gateway re-resolves the task's runtime (3.2) so
   *     the poller dispatches turn-completion the right way — `tmux has-session`
   *     for codex, the transcript-`end_turn` `detectExit` for claude — over the
   *     re-adopted live session. The container is SPARED.
   *   - NO live session → FORCE-REMOVE: a RUNNING container whose AGENT session is
   *     gone is a true orphan (its task/session state died with the prior process,
   *     or the agent already exited / a claude turn already `end_turn`-killed its
   *     session without settling), so it is reaped to avoid leaking host resources.
   *     The matching stranded task row is failed by the tasks service Phase 1
   *     (which excludes the re-adopted tasks).
   *
   * RETENTION (D1): STOPPED `cap-aio-*` containers are NOT touched — they are
   * intentionally-kept settled sandboxes the history-replay page reads from. This
   * filters `status: ['running']` and never lists `Exited` containers; a Dokploy
   * redeploy / api restart must not wipe the kept history (the retention cleaner
   * is the only path that removes stopped containers).
   *
   * Best-effort and never throws: a docker hiccup must not block app startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.controller.listReadoptable();
  }

  /**
   * NON-DESTRUCTIVE shutdown (survive-api-redeploy D5). On api shutdown
   * (SIGTERM / `onModuleDestroy`) RELEASE the in-memory handles WITHOUT stopping
   * the provisioned `cap-aio-*` containers, so the next api process re-adopts the
   * still-running sandboxes ({@link onApplicationBootstrap}) and the in-flight
   * tasks survive the redeploy.
   *
   * This deliberately NO LONGER stops containers here — the old "stop every
   * provisioned container on shutdown" behavior is what welded a task's life to
   * the api process. The stop-only retention teardown (with pre-stop credential
   * zeroing) on a REAL terminal task ({@link teardownSandbox}) is unchanged and
   * still runs on the normal teardown path; only this shutdown hook is now inert
   * with respect to the running sandboxes.
   */
  onModuleDestroy(): void {
    this.controller.releaseHandles();
  }

  /**
   * The taskIds re-adopted at {@link onApplicationBootstrap} — RUNNING
   * `cap-aio-<taskId>` containers whose detached `task<taskId>` codex session was
   * still alive — surfaced for the guardrails recovery (Track 4). The caller
   * DB-validates each (only `running`/`awaiting_input` rows are genuinely
   * re-adoptable) and calls {@link reattach} for the survivors. Returns a fresh
   * array snapshot so the caller cannot mutate the provider's internal set.
   */
  async listReadoptable(): Promise<string[]> {
    return this.controller.listReadoptable();
  }

  /**
   * Re-attach a single re-adopted task's sandbox by container name (the guardrails
   * recovery surface, Track 4). Idempotent: re-registers the provider/connection
   * maps for `cap-aio-<taskId>` (a no-op when already registered) and returns the
   * addressable {@link SandboxConnection} the caller hands to the terminal gateway
   * so it dials the live session OUT and re-attaches. Returns `null` when the task
   * was not among the boot-time re-adopted set (nothing to re-attach).
   */
  reattach(taskId: string): SandboxConnection | null {
    return this.controller.reattach(taskId);
  }

  /**
   * Clone the task repository into a DEDICATED, EMPTY workspace directory via
   * `POST <baseUrl>/v1/shell/exec`. No-op when no clone URL is configured.
   *
   * The repository is cloned into `AioSandboxProvider.WORKSPACE_DIR`
   * (`/home/gem/workspace`) — a dedicated, empty target — and NEVER into the
   * non-empty `/home/gem` HOME, which would fail `git clone` ("destination path
   * already exists and is not an empty directory").
   *
   * The provider PARSES the `/v1/shell/exec` response body and treats a non-zero
   * clone command `exit_code` as a provisioning failure. The exit code is scoped
   * to the clone's OWN exit code (the command is NOT piped through `| head` or
   * similar, so the reported status is the clone's, not a trailing pipe's), and a
   * non-zero status — not merely a non-`ok` HTTP status — raises a real provision
   * error carrying the command `output`. "cloned task repository" is logged ONLY
   * on a genuinely successful clone.
   */
  private async cloneTaskRepository(
    executor: SandboxCommandExecutor,
    taskId: string,
    selectedSpec: ProvisionContext['cloneSpec'],
  ): Promise<void> {
    const spec =
      selectedSpec === undefined ? await this.lookup.getCloneSpec(taskId) : selectedSpec;
    if (!spec) {
      this.logger.debug(`no clone spec resolved for task ${taskId}; skipping clone`);
      return;
    }

    await buildSandboxWorkspaceBridge({
      executor,
      descriptor: this.getWorkspaceDescriptor(taskId),
    }).materializeGit({
      taskId,
      spec,
    });

    this.logger.debug(`cloned task repository into AIO sandbox for task ${taskId}`);
  }

  /**
   * Provision-time credential/config + prompt injection, UNIFORM across runtimes
   * (refactor-agent-runtime-policy-mechanism). The provider is pure MECHANISM: it
   * resolves the task's {@link AgentRuntime} (defaulting to codex), resolves that
   * runtime's auth material (the async source read + SSRF guard are mechanism, here)
   * and the task prompt, then asks the runtime for its ORDERED
   * `sandboxSetupCommands` (pure POLICY: config/creds + the conditional prompt write,
   * byte-identical to the prior inline codex path for codex) and runs them over the
   * shared exec — NO agent-identity branch. The plan FAILS CLOSED before any command
   * when the runtime requires a missing credential (claude with no token), and each
   * command fails closed per its `tolerateUnresolvedExit` policy. A genuine failure
   * throws, which the caller's provision try/catch maps to a torn-down container +
   * failed task. An unresolved/errored runtime degrades to the codex default.
   */
  private async injectRuntimeSetup(
    executor: SandboxCommandExecutor,
    taskId: string,
    runtime: AgentRuntime,
  ): Promise<void> {
    // UNIFORM provision-time setup for EVERY runtime — NO agent-identity branch. The
    // runtime emits its ordered setup commands as DATA; the provider (mechanism)
    // resolves the per-runtime material + the task prompt, then runs the commands
    // fail-closed. The selected runtime is resolved once by provision() and
    // carried through preflight + setup, mirroring Sandbank's selected run context.
    const [material, prompt] = await Promise.all([
      this.resolveProvisionMaterial(runtime, taskId),
      this.lookup.getTaskPrompt(taskId),
    ]);
    const plan = runtime.sandboxSetupCommands(
      {
        taskId,
        workspaceDir: AioSandboxProvider.WORKSPACE_DIR,
        prompt: prompt ?? null,
      },
      material,
    );
    if (!plan.ok) {
      // FAIL CLOSED before any command (e.g. claude with no token) — the caller's
      // provision try/catch maps this to a torn-down container + failed task. Read
      // `reason` via an index access so it does not depend on strict
      // discriminated-union narrowing (same pattern as the integration layer).
      const reason =
        (plan as { reason?: string }).reason ?? 'runtime not configured';
      throw new Error(
        `runtime "${runtime.id}" setup for task ${taskId} failed: ${reason}`,
      );
    }
    const commands: readonly SandboxSetupCommand[] = (
      plan as { commands?: readonly SandboxSetupCommand[] }
    ).commands ?? [];
    const exec = this.runSandboxExec(executor);
    for (const { command, tolerateUnresolvedExit } of commands) {
      const { exitCode, output } = await exec(command);
      if (AioSandboxProvider.setupCommandFailed(exitCode, tolerateUnresolvedExit)) {
        const scrubbed = AioSandboxProvider.scrubSecrets(output);
        throw new Error(
          `runtime "${runtime.id}" setup for task ${taskId} failed: exit_code ${exitCode}` +
            (scrubbed ? ` — ${scrubbed}` : ''),
        );
      }
    }
    this.logger.debug(
      `provisioned runtime "${runtime.id}" setup for task ${taskId} (${plan.commands.length} command(s))`,
    );
  }

  /**
   * Runtime image/tooling preflight, inspired by Sandbank's provider scheduler
   * preflight but scoped to our current single AIO provider. Missing tools fail
   * provisioning before auth material, repository clone, skill install, or agent
   * launch, yielding a precise image-capability error and preventing a bad image
   * from consuming a long-running slot.
   */
  private async preflightRuntime(
    executor: SandboxCommandExecutor,
    taskId: string,
    runtime: AgentRuntime,
  ): Promise<void> {
    const probes: readonly SandboxRuntimePreflightProbe[] = runtime.preflightProbes();
    if (probes.length === 0) return;

    const exec = this.runSandboxExec(executor);
    for (const probe of probes) {
      const { exitCode, output } = await exec(probe.command);
      if (exitCode !== 0) {
        const scrubbed = AioSandboxProvider.scrubSecrets(output).trim();
        throw new Error(
          `runtime "${runtime.id}" preflight for task ${taskId} failed: ` +
            `${probe.name} (${probe.command}) exit_code ${exitCode}` +
            (scrubbed ? ` — ${scrubbed}` : ''),
        );
      }
    }
    this.logger.debug(
      `runtime "${runtime.id}" preflight passed for task ${taskId} (${probes.length} probe(s))`,
    );
  }

  /**
   * The per-command fail-closed predicate (refactor step 3 — extracted so the
   * fail-closed matrix is unit-testable WITHOUT constructing the provider). A REAL
   * non-zero exit ALWAYS fails closed; an UNRESOLVED (NaN) exit fails closed UNLESS
   * the command tolerates it (claude's auth write, preserving `code !== null &&
   * code !== 0`).
   */
  static setupCommandFailed(
    exitCode: number,
    tolerateUnresolvedExit: boolean,
  ): boolean {
    return Number.isNaN(exitCode) ? !tolerateUnresolvedExit : exitCode !== 0;
  }

  /**
   * Resolve the per-runtime auth material the runtime's setup emitter consumes.
   * The provider depends only on the registry; credential-source I/O and SSRF
   * validation live behind runtime-specific resolvers registered at composition.
   */
  private async resolveProvisionMaterial(
    runtime: { id: string },
    taskId: string,
  ): Promise<AuthMaterial | null> {
    return this.materialResolvers.resolve(runtime, { taskId });
  }

  /**
   * Resolve the task's selected {@link AgentRuntime} via the {@link RuntimeRegistry}
   * (Track 2). Best-effort + never throws: a registry hiccup (or a not-yet-wired
   * registry in a focused unit context) resolves to `undefined`, and every caller
   * treats `undefined` as the DEFAULT codex path, so a resolution failure can never
   * strand a codex task or accidentally route it through a claude-only branch.
   */
  private async resolveRuntime(taskId: string): Promise<AgentRuntime | undefined> {
    try {
      return (await this.runtimes?.resolveForTask?.(taskId)) ?? undefined;
    } catch (err) {
      this.logger.warn(
        `could not resolve AgentRuntime for task ${taskId} (defaulting to codex): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Resolve the selected runtime for one provision pass. This is the local analog
   * of Sandbank's `SelectedSandboxProvider`/run context: once selected, the same
   * runtime is used for image preflight and provision-time setup, instead of
   * re-reading task runtime state between those phases.
   */
  private async resolveProvisionRuntime(taskId: string): Promise<AgentRuntime> {
    return (
      (await this.resolveRuntime(taskId)) ??
      this.runtimes?.resolve?.(null) ??
      new CodexRuntime()
    );
  }

  private createCommandExecutor(baseUrl: string): SandboxCommandExecutor {
    return createAioHttpCommandExecutor({ baseUrl });
  }

  private connectionForTask(taskId: string): SandboxConnection {
    return this.controller.getConnection(taskId) ?? buildAioSandboxConnection(taskId);
  }

  /**
   * Build the {@link SandboxExec} closure a runtime uses to run a command in THIS
   * sandbox through the selected provider command executor, returning the parsed
   * `{exitCode, output}` via the same normalization the provider uses for its own
   * injections — so a runtime sees identical exit-code semantics (a missing
   * `exit_code` is a non-zero failure, live-server `data`-nesting is unwrapped).
   * A non-`ok` HTTP status surfaces as `{exitCode: NaN}` so the runtime fails closed
   * exactly as the inline codex path does.
   */
  private runSandboxExec(executor: SandboxCommandExecutor): SandboxExec {
    return async (command: string): Promise<SandboxExecResult> => {
      return toLegacySandboxExecResult(await executor.exec({ command }));
    };
  }

  /**
   * Preinstall the task's selected skills into the cloned workspace
   * (task-preinstall-skills). For each selected skill id that is on the
   * server-side allowlist, run its PINNED non-interactive installer command
   * against {@link WORKSPACE_DIR} over `/v1/shell/exec`; codex (launched with
   * `-C <workspace>`) then discovers the skill files the installer drops
   * (`.codex/skills` / `.agents/skills`).
   *
   * FAIL-SOFT (in deliberate contrast to the fail-closed auth/clone steps): a
   * non-allowlisted id is skipped; an installer that errors / exits non-zero is
   * logged and skipped but NEVER aborts provision — a missing skill is a
   * degraded-but-usable session, not a security gate. Each skill installs
   * independently, so one failing does not block the others. This method
   * swallows all its own errors and never throws into the provision path.
   */
  private async preinstallSkills(
    executor: SandboxCommandExecutor,
    taskId: string,
  ): Promise<void> {
    let skills: string[] = [];
    try {
      skills = await this.lookup.getTaskSkills(taskId);
    } catch (err) {
      this.logger.warn(
        `task ${taskId}: could not resolve selected skills (skipping preinstall): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (skills.length === 0) return;

    for (const id of skills) {
      const installer = resolveSkillInstaller(id);
      if (!installer) {
        // Not on the allowlist — never execute operator-supplied text.
        this.logger.warn(
          `task ${taskId}: skill "${id}" is not allowlisted; skipping (not executed)`,
        );
        continue;
      }
      // The argv is entirely server-defined allowlist literals + the fixed
      // workspace path (no operator free-text, no shell metacharacters), so a
      // plain space-join is a safe shell command. Always read stdin from
      // /dev/null so the non-interactive installer cannot block on a TTY.
      const command = `${installer
        .command(AioSandboxProvider.WORKSPACE_DIR)
        .join(' ')} < /dev/null`;
      try {
        const { exitCode, output } = await executor.exec({
          command,
          timeoutMs: AioSandboxProvider.SKILL_INSTALL_TIMEOUT_MS,
        });
        if (exitCode !== 0) {
          const scrubbed = AioSandboxProvider.scrubSecrets(output);
          this.logger.warn(
            `task ${taskId}: skill "${id}" (${installer.label}) installer exit_code ${exitCode} — degrading (codex launches without it)` +
              (scrubbed ? ` — ${scrubbed.trim().slice(0, 300)}` : ''),
          );
          continue;
        }
        this.logger.debug(
          `task ${taskId}: preinstalled skill "${id}" (${installer.label})`,
        );
      } catch (err) {
        this.logger.warn(
          `task ${taskId}: skill "${id}" (${installer.label}) preinstall failed/timed out — degrading (codex launches without it): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Strip credential material from untrusted `/v1/shell/exec` output BEFORE it
   * enters a thrown Error / the orchestrator log: redact the userinfo of any
   * https URL (`https://user:pass@` → `https://***:***@`) and the value of any
   * `Authorization: Basic <...>` header. Defense-in-depth on top of keeping the
   * token out of the clone URL/argv in the first place — git failure messages
   * are exactly where a credential-bearing URL would otherwise surface.
   */
  private static scrubSecrets(output: string): string {
    return scrubAioExecSecrets(output);
  }
}
