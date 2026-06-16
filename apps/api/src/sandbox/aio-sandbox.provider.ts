import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import Docker from 'dockerode';

import type {
  ProvisionContext,
  SandboxConnection,
  SandboxMode,
  SandboxProvider,
} from './sandbox-provider.port.js';
import { CODEX_AUTH_SOURCE, type CodexAuthSource } from './codex-auth-source.port';
import { PROVISION_LOOKUP, type ProvisionLookup } from './provision-lookup.port';
import { CODEX_PROMPT_FILE_PATH } from '../terminal/codex-launch';
import { resolveSkillInstaller } from './skill-allowlist';
import { extractFilesFromTar } from './tar-extract';

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
 *     (`task → repo.gitSource`, with the operator's GitHub token attached as an
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
  /** taskId -> the per-task AIO container. */
  private readonly containers = new Map<string, Docker.Container>();
  /** taskId -> the connection handle returned for an already-provisioned task. */
  private readonly connections = new Map<string, SandboxConnection>();
  /**
   * Re-adoption (survive-api-redeploy D3): the taskIds whose RUNNING
   * `cap-aio-<taskId>` container AND live detached `task<taskId>` tmux session
   * were re-adopted at {@link onApplicationBootstrap} — re-registered into the
   * provider/connection maps above rather than reaped. The guardrails recovery
   * (Track 4) reads this via {@link listReadoptable} to DB-validate each candidate
   * (`running`/`awaiting_input`) and re-attach the live ones; the provider itself
   * holds no DB reference, so the DB cross-check is layered by the caller. An entry
   * is dropped once its task settles (its handle leaves the maps via teardown).
   */
  private readonly readopted = new Set<string>();

  /**
   * @param lookup           Resolves the per-task clone URL (`task → repo.gitSource`
   *                         with the operator's GitHub token spliced in for private
   *                         repos), replacing the global `TASK_REPO_URL` stopgap.
   *                         Behind a port so the provider never touches the DB
   *                         directly (keeps its focused unit test compilable in
   *                         isolation).
   * @param codexAuthSource  Supplies the codex `auth.json` injected into each
   *                         sandbox before codex launches (deployment-level env
   *                         source today; see {@link CodexAuthSource}).
   */
  constructor(
    @Inject(PROVISION_LOOKUP) private readonly lookup: ProvisionLookup,
    @Inject(CODEX_AUTH_SOURCE) private readonly codexAuthSource: CodexAuthSource,
  ) {}

  /** The exposed AIO HTTP/WS port inside the container (never published to the host). */
  private static readonly AIO_PORT = 8080;
  /** Required security option — the container is invalid without it. */
  private static readonly SECCOMP_UNCONFINED = 'seccomp=unconfined';
  /** Shared-memory size for the heavy AIO container (~2g). */
  private static readonly SHM_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
  /**
   * Dedicated, EMPTY workspace directory the task repository is cloned into.
   * NEVER the non-empty `/home/gem` HOME (cloning into it fails with
   * "destination path already exists and is not an empty directory").
   */
  private static readonly WORKSPACE_DIR = '/home/gem/workspace';
  /**
   * codex's home inside the sandbox. `sessions/` under it holds the rollout
   * JSONL (the replay source, D3); `cache` + `logs_*.sqlite` are the trimmable
   * bulk; `auth.json` is the credential that retention zeroes before stop (D4).
   */
  private static readonly CODEX_HOME_DIR = '/home/gem/.codex';
  /** Name prefix for the per-task sandbox containers (`cap-aio-<taskId>`). */
  private static readonly CONTAINER_PREFIX = 'cap-aio-';
  /**
   * Upper bound on a single skill installer's wall-clock (task-preinstall-skills).
   * The live spike measured ~3–6s with warm egress; this generous ceiling covers
   * a cold `npx` fetch. On timeout the skill is skipped (fail-soft), never
   * blocking the provision.
   */
  private static readonly SKILL_INSTALL_TIMEOUT_MS = 120_000;

  /**
   * Upper bound on the pre-stop `~/.codex` trim's wall-clock (D4). The trim is a
   * single `rm`/truncate over the live sandbox; this ceiling keeps a wedged
   * sandbox from stalling settle. On timeout the trim is skipped (the kept
   * container is just larger) and the stop proceeds — never fatal.
   */
  private static readonly TRIM_TIMEOUT_MS = 10_000;

  /**
   * Upper bound on the boot-time detached-session liveness probe
   * (survive-api-redeploy D3). `tmux has-session` over `/v1/shell/exec` is a
   * single fast in-container command; this tight ceiling keeps an unreachable or
   * wedged sandbox from stalling startup — on timeout the probe returns NOT alive
   * so the container is reaped rather than re-adopted (fail toward reaping a
   * sandbox we cannot confirm is live).
   */
  private static readonly SESSION_PROBE_TIMEOUT_MS = 5_000;

  /**
   * Reported sandbox mode, surfaced as INFORMATIONAL metadata only. The real
   * isolation boundary is the AIO container (`seccomp=unconfined` + `cap-net`
   * network isolation, no host port), not this value.
   */
  getSandboxMode(): SandboxMode {
    return 'danger-full-access';
  }

  /**
   * Provision the per-task AIO Sandbox container and return its addressable
   * {@link SandboxConnection} handle. Idempotent: a second call for an already
   * provisioned task returns the equivalent handle without creating a second
   * container.
   */
  async provision(ctx: ProvisionContext): Promise<SandboxConnection> {
    // Idempotent for an already-provisioned task.
    const existing = this.connections.get(ctx.taskId);
    if (existing) return existing;

    const image = process.env.AIO_SANDBOX_IMAGE;
    if (!image) {
      throw new Error('AIO_SANDBOX_IMAGE must be set to provision an AIO sandbox container');
    }
    if (image.endsWith(':latest') || !image.includes(':')) {
      throw new Error(
        `AIO_SANDBOX_IMAGE must be a pinned tag (not ':latest' / untagged) for reproducible provisioning, received: ${image}`,
      );
    }
    const network = process.env.AIO_SANDBOX_NETWORK ?? 'cap-net';

    const containerName = `${AioSandboxProvider.CONTAINER_PREFIX}${ctx.taskId}`;
    const baseUrl = `http://${containerName}:${AioSandboxProvider.AIO_PORT}`;
    const wsUrl = `ws://${containerName}:${AioSandboxProvider.AIO_PORT}/v1/shell/ws`;

    // Built once so the seccomp guard below asserts EXACTLY what is sent to
    // dockerode — a container without `seccomp=unconfined` is never started.
    const securityOpt = [AioSandboxProvider.SECCOMP_UNCONFINED];
    this.assertSeccompUnconfined(securityOpt);

    // Env injected into the sandbox container so the baked Codex hooks can call
    // back IN to the orchestrator approvals endpoint (5.5) over `cap-net`. The
    // approvals URL is the orchestrator dialled BY CONTAINER NAME on `cap-net`
    // (it has no host port); `ORCHESTRATOR_APPROVALS_BASE` defaults to the
    // compose service name so the hook's outbound POST reaches the controller.
    const approvalsBase =
      process.env.ORCHESTRATOR_APPROVALS_BASE ?? `http://api:${process.env.PORT ?? '8080'}`;
    const env = [
      `TASK_ID=${ctx.taskId}`,
      `ORCHESTRATOR_APPROVALS_URL=${approvalsBase.replace(/\/+$/, '')}/v1/approvals`,
    ];

    const container = await this.docker.createContainer({
      Image: image,
      // The name doubles as the `cap-net` DNS name the orchestrator dials.
      name: containerName,
      // Injected so the baked hooks know their task identity and the orchestrator
      // approvals callback URL (read by the HttpApprovalTransport / HttpReportTransport).
      Env: env,
      HostConfig: {
        SecurityOpt: securityOpt,
        ShmSize: AioSandboxProvider.SHM_SIZE_BYTES,
        // RETENTION (session-sandbox-retention D1): `false`, NOT `true` — a
        // settled task's container is STOPPED, not removed, so its codex rollout
        // transcript + workspace survive for read-only history replay (and the
        // deferred resume-run). The retention cleaner removes it past the
        // retention window; `teardownSandbox` stops only.
        AutoRemove: false,
        // Join the private network so the orchestrator can dial by container
        // name; the default bridge has no container-name DNS.
        NetworkMode: network,
        // NO PortBindings — the sandbox publishes no host port; network
        // isolation on `cap-net` is the execution security boundary.
        // structured-logging: bound the per-task container's json-file logs so a
        // chatty codex run cannot exhaust host disk (mirrors the compose
        // *default-logging ceiling, which does not apply to DooD-created siblings).
        LogConfig: {
          Type: 'json-file',
          Config: { 'max-size': '20m', 'max-file': '5' },
        },
      },
    });
    this.containers.set(ctx.taskId, container);
    await container.start();
    this.logger.debug(`provisioned AIO container ${containerName} from ${image}`);

    // Post-start steps run against the now-LIVE, already-registered container and
    // can fail (injectCodexAuth / cloneTaskRepository fail CLOSED on a non-zero
    // exit). On ANY failure here the container is running + in `this.containers`,
    // so tear it down before rethrowing — otherwise a failed provision leaks a
    // running cap-aio-<taskId> AND a clean retry (which clones into the now
    // non-empty workspace) is impossible. The caller (guardrails) then fails the
    // task and releases the run slot.
    try {
      // Readiness: do not treat the sandbox as usable until its HTTP API answers.
      await this.waitForReadiness(baseUrl, ctx.taskId);
      // Inject the codex auth.json into /home/gem/.codex BEFORE the gateway opens
      // the PTY and codex auto-launches — so codex authenticates on startup. Then
      // clone the task repo. Both AFTER readiness and BEFORE the handle returns.
      await this.injectCodexAuth(baseUrl, ctx.taskId);
      // Inject the operator's task prompt as a file so codex starts with the goal
      // pre-filled (aio-codex-prompt-autostart). After auth (same ~/.codex dir),
      // before the handle returns; fails CLOSED on a write error like the others.
      await this.injectTaskPrompt(baseUrl, ctx.taskId);
      await this.cloneTaskRepository(baseUrl, ctx.taskId);
      // task-preinstall-skills: AFTER the clone (the installers run against the
      // cloned workspace) and before the handle returns. FAIL-SOFT — a skill
      // installer failure is logged but does NOT abort provision (codex still
      // launches without that skill), so this is NOT in the fail-closed try/throw
      // contract of auth/clone above; it swallows its own errors internally.
      await this.preinstallSkills(baseUrl, ctx.taskId);
    } catch (err) {
      await this.teardownSandbox(ctx.taskId).catch(() => undefined);
      throw err;
    }

    const connection: SandboxConnection = { taskId: ctx.taskId, baseUrl, wsUrl };
    this.connections.set(ctx.taskId, connection);
    return connection;
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
    const connection = this.connections.get(taskId);
    this.connections.delete(taskId);
    // A re-adopted task that reaches a terminal state settles through here — drop
    // it from the re-adopted set so {@link listReadoptable} reflects only tasks
    // still held alive (a settled task is no longer re-adoptable).
    this.readopted.delete(taskId);
    const container = this.containers.get(taskId);
    if (!container) return;
    this.containers.delete(taskId);
    // D4 / V.2 — best-effort, time-boxed pre-stop trim. The baseUrl is
    // DETERMINISTIC from the container name, so this ALSO fires on the
    // provision-FAILURE teardown (`provision()` tears down before
    // `connections.set`, so `connection` is undefined) — a retained container
    // must NEVER hold a live `auth.json`, even when provision failed AFTER the
    // auth inject. A sandbox whose HTTP server never came up fast-fails
    // (ECONNREFUSED); a trim failure NEVER blocks the stop.
    const baseUrl =
      connection?.baseUrl ??
      `http://${AioSandboxProvider.CONTAINER_PREFIX}${taskId}:${AioSandboxProvider.AIO_PORT}`;
    await this.trimCodexHomeBeforeStop(baseUrl, taskId);
    // `t: 0` = stop immediately. With AutoRemove:false the container persists in
    // an `Exited` state (the rollout/workspace frozen) until the retention
    // cleaner removes it. Already stopped → safe no-op.
    await container.stop({ t: 0 }).catch(() => {
      // Already stopped — fine.
    });
  }

  /**
   * Force-remove a STOPPED retained container (the retention cleaner / disk-floor
   * eviction path). Separate from {@link teardownSandbox} (which only stops) so
   * the lifecycle keeps the container and only the cleaner deletes it. Idempotent.
   */
  async removeSandbox(taskId: string): Promise<void> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(`${AioSandboxProvider.CONTAINER_PREFIX}${taskId}`);
    this.containers.delete(taskId);
    this.readopted.delete(taskId);
    await container.remove({ force: true }).catch(() => {
      // Already removed / never existed — fine.
    });
  }

  /**
   * D4 — trim a settling container's `~/.codex` BEFORE stop, while its
   * `/v1/shell/exec` is still live: drop the model `cache` + `logs_*.sqlite`
   * (the ~92MB bulk, NOT the conversation) and ZERO `auth.json` (a kept,
   * read-only container must not hold a refreshable ChatGPT credential), keeping
   * `sessions/` (the rollout). Best-effort + time-boxed: a failure is logged and
   * never blocks the stop, so settling stays fast even if the sandbox is wedged.
   */
  private async trimCodexHomeBeforeStop(
    baseUrl: string,
    taskId: string,
  ): Promise<void> {
    const dir = AioSandboxProvider.CODEX_HOME_DIR;
    // Keep `sessions/` (rollout); drop caches + sqlite logs; zero auth.json.
    const command =
      `rm -rf ${dir}/cache ${dir}/logs_*.sqlite ${dir}/logs_*.sqlite-shm ${dir}/logs_*.sqlite-wal 2>/dev/null; ` +
      `: > ${dir}/auth.json 2>/dev/null; true`;
    try {
      const res = await fetch(`${baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(AioSandboxProvider.TRIM_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(
          `pre-stop ~/.codex trim for task ${taskId} returned HTTP ${res.status} (kept container will be larger; not fatal)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `pre-stop ~/.codex trim for task ${taskId} failed (kept container will be larger; not fatal): ${
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
   * Read the codex rollout JSONL out of a STOPPED, retained `cap-aio-<taskId>`
   * container for read-only history replay (D3). Uses dockerode `getArchive`,
   * which streams a tar of the container's FROZEN layer WITHOUT restarting it —
   * so an `Exited` sandbox is read in place. Scoped to `~/.codex/sessions` only:
   * it never pulls `auth.json` or any credential file out of the container.
   *
   * Returns the newest `rollout-*.jsonl`'s raw text, or `null` when the rollout
   * is absent — container reaped/expired, path missing, or codex never ran
   * (provision_failed / agent_failed_to_start). The endpoint maps `null` to the
   * honest `empty`/`expired` states; this method never throws into the caller.
   */
  async readRolloutFromContainer(taskId: string): Promise<string | null> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(`${AioSandboxProvider.CONTAINER_PREFIX}${taskId}`);
    let stream: NodeJS.ReadableStream;
    try {
      // `~/.codex/sessions` holds the rollout (one file per session). Globbing
      // `history.jsonl` would be WRONG — that is only the global user-input log.
      stream = await container.getArchive({
        path: `${AioSandboxProvider.CODEX_HOME_DIR}/sessions`,
      });
    } catch {
      // 404 (container removed / path absent) → no rollout to replay.
      return null;
    }
    let tar: Buffer;
    try {
      tar = await AioSandboxProvider.streamToBuffer(stream);
    } catch {
      return null;
    }
    const rollouts = extractFilesFromTar(tar, (name) =>
      /(^|\/)rollout-.*\.jsonl$/.test(name),
    );
    if (rollouts.length === 0) return null;
    // One rollout per session; if several, the ISO-timestamp in the filename
    // sorts chronologically — take the newest.
    rollouts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return rollouts[rollouts.length - 1]!.content.toString('utf8');
  }

  /** Collect a (dockerode getArchive) readable stream fully into a Buffer. */
  private static async streamToBuffer(
    stream: NodeJS.ReadableStream,
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  /**
   * Whether the per-task `cap-aio-<taskId>` container still EXISTS (running OR
   * stopped/retained). Lets the history endpoint tell an aged-out/reaped session
   * (`expired`) apart from a container that exists but produced no rollout
   * (`empty`). `inspect()` 404s when the container is gone → false; never throws.
   */
  async sandboxExists(taskId: string): Promise<boolean> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(`${AioSandboxProvider.CONTAINER_PREFIX}${taskId}`);
    try {
      await container.inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Boot RE-ADOPTION pass (survive-api-redeploy D3) — supersedes the old
   * "force-remove every RUNNING `cap-aio-*` orphan" reap.
   *
   * Because codex now runs in a DETACHED named tmux session (`task<taskId>`) that
   * outlives the orchestrator's `/v1/shell/ws` connection, a RUNNING `cap-aio-*`
   * container left by a prior process is NOT automatically an orphan: its codex
   * may still be executing. So on boot we list RUNNING `cap-aio-*`, parse each
   * `taskId`, and probe the detached session via {@link hasLiveSession}
   * (`tmux has-session -t task<taskId>` over the container's own
   * `/v1/shell/exec` — the Track-2 has-session check, issued as the provider's
   * OWN exec call, not a shared-file edit):
   *   - LIVE session  → RE-ADOPT: re-register the provider/connection maps and
   *     mark the task in {@link readopted} so the guardrails recovery (Track 4)
   *     can DB-validate it (`running`/`awaiting_input`) and re-attach its
   *     terminal (the re-attach is orchestrated by 4.2 via guardrails — the
   *     provider holds no gateway reference). The container is SPARED.
   *   - NO live session → FORCE-REMOVE: a RUNNING container whose codex session is
   *     gone is a true orphan (its task/session state died with the prior process
   *     or codex already exited without settling), so it is reaped to avoid
   *     leaking host resources. The matching stranded task row is failed by the
   *     tasks service Phase 1 (which excludes the re-adopted tasks).
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
    try {
      const running = await this.docker.listContainers({
        // Only running containers: `all` defaults to false, but be explicit so
        // the retention intent (spare stopped/`Exited` history) is unmistakable.
        all: false,
        filters: {
          name: [AioSandboxProvider.CONTAINER_PREFIX],
          status: ['running'],
        },
      });
      if (running.length === 0) return;

      let readopted = 0;
      let reaped = 0;
      await Promise.all(
        running.map(async (info) => {
          const taskId = AioSandboxProvider.parseTaskId(info.Names);
          // Could not parse a taskId from any of the container's names → treat as
          // an unknown/foreign container and reap it (it cannot be re-adopted).
          if (taskId && (await this.hasLiveSession(taskId))) {
            // RE-ADOPT: re-register the maps so this process owns the still-running
            // sandbox again; Track 4 DB-validates + re-attaches the terminal.
            this.reregister(taskId);
            this.readopted.add(taskId);
            readopted += 1;
            return;
          }
          // FORCE-REMOVE: RUNNING but no live codex session → true orphan.
          await this.docker
            .getContainer(info.Id)
            .remove({ force: true })
            .catch(() => undefined);
          reaped += 1;
        }),
      );

      this.logger.log(
        `startup re-adoption: re-adopted ${readopted} still-running ` +
          `${AioSandboxProvider.CONTAINER_PREFIX}* sandbox(es) with a live codex session, ` +
          `force-removed ${reaped} orphan(s) with no live task ` +
          `(stopped containers spared as retained history)`,
      );
    } catch (err) {
      this.logger.warn(
        `startup re-adoption of running sandboxes failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
    this.containers.clear();
    this.connections.clear();
    this.readopted.clear();
  }

  /**
   * The taskIds re-adopted at {@link onApplicationBootstrap} — RUNNING
   * `cap-aio-<taskId>` containers whose detached `task<taskId>` codex session was
   * still alive — surfaced for the guardrails recovery (Track 4). The caller
   * DB-validates each (only `running`/`awaiting_input` rows are genuinely
   * re-adoptable) and calls {@link reattach} for the survivors. Returns a fresh
   * array snapshot so the caller cannot mutate the provider's internal set.
   */
  listReadoptable(): string[] {
    return [...this.readopted];
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
    if (!this.readopted.has(taskId)) return null;
    this.reregister(taskId);
    return this.connections.get(taskId) ?? null;
  }

  /**
   * Re-register the provider/connection maps for an already-RUNNING
   * `cap-aio-<taskId>` container this process did not provision (re-adoption /
   * re-attach). The container handle is addressed by its deterministic name and
   * the {@link SandboxConnection} reconstructed from the same name → URLs the
   * gateway dials, so a re-adopted task is indistinguishable from a freshly
   * provisioned one to every consumer. Idempotent.
   */
  private reregister(taskId: string): void {
    if (!this.containers.has(taskId)) {
      this.containers.set(
        taskId,
        this.docker.getContainer(
          `${AioSandboxProvider.CONTAINER_PREFIX}${taskId}`,
        ),
      );
    }
    if (!this.connections.has(taskId)) {
      const containerName = `${AioSandboxProvider.CONTAINER_PREFIX}${taskId}`;
      this.connections.set(taskId, {
        taskId,
        baseUrl: `http://${containerName}:${AioSandboxProvider.AIO_PORT}`,
        wsUrl: `ws://${containerName}:${AioSandboxProvider.AIO_PORT}/v1/shell/ws`,
      });
    }
  }

  /**
   * Whether the task's DETACHED codex session is still alive — the Track-2
   * `has-session` liveness check, issued as the provider's OWN
   * `POST /v1/shell/exec` running `tmux has-session -t task<taskId>` (exit 0 when
   * the session exists). This is a CONSUMED contract, not a shared-file edit: the
   * provider already reaches the sandbox HTTP API directly elsewhere
   * (readiness/clone/auth), so probing liveness over the same surface keeps this
   * track's file set disjoint from the terminal module. A non-zero exit, a
   * non-`ok` HTTP status, or any transport error is treated as NOT alive (so a
   * wedged/unreachable sandbox is reaped, never re-adopted). Never throws.
   */
  private async hasLiveSession(taskId: string): Promise<boolean> {
    const containerName = `${AioSandboxProvider.CONTAINER_PREFIX}${taskId}`;
    const baseUrl = `http://${containerName}:${AioSandboxProvider.AIO_PORT}`;
    const command = `tmux has-session -t task${taskId}`;
    try {
      const res = await fetch(`${baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(AioSandboxProvider.SESSION_PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const { exitCode } = AioSandboxProvider.parseExecResult(
        await res.json().catch(() => undefined),
      );
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Parse the `taskId` out of a docker container's `Names` (the `listContainers`
   * shape gives leading-slash names, e.g. `/cap-aio-<taskId>`). Returns the first
   * name that matches the `cap-aio-` prefix with a non-empty suffix, or `null`
   * when none does (a foreign / unparseable container that cannot be re-adopted).
   */
  private static parseTaskId(names: readonly string[] | undefined): string | null {
    for (const raw of names ?? []) {
      const name = raw.startsWith('/') ? raw.slice(1) : raw;
      if (
        name.startsWith(AioSandboxProvider.CONTAINER_PREFIX) &&
        name.length > AioSandboxProvider.CONTAINER_PREFIX.length
      ) {
        return name.slice(AioSandboxProvider.CONTAINER_PREFIX.length);
      }
    }
    return null;
  }

  /**
   * Guard: a container MUST be created with `seccomp=unconfined`. A misconfigured
   * container (missing the option) is invalid and must never be used for
   * execution, so we throw before starting it.
   */
  private assertSeccompUnconfined(securityOpt: readonly string[]): void {
    if (!securityOpt.includes(AioSandboxProvider.SECCOMP_UNCONFINED)) {
      throw new Error(
        `AIO sandbox container is invalid: HostConfig.SecurityOpt must include '${AioSandboxProvider.SECCOMP_UNCONFINED}'`,
      );
    }
  }

  /**
   * Poll `GET <baseUrl>/v1/docs` until it responds successfully (readiness),
   * bounded by `AIO_SANDBOX_READINESS_TIMEOUT_MS`. Surfaces a clear provision
   * error if readiness never arrives within the bound.
   */
  private async waitForReadiness(baseUrl: string, taskId: string): Promise<void> {
    const timeoutMs = Number(process.env.AIO_SANDBOX_READINESS_TIMEOUT_MS ?? 60_000);
    const intervalMs = 250;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/v1/docs`);
        if (res.ok) return;
        lastError = new Error(`/v1/docs responded with status ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await this.delay(intervalMs);
    }

    throw new Error(
      `AIO sandbox for task ${taskId} did not become ready within ${timeoutMs}ms ` +
        `(last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`,
    );
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
  private async cloneTaskRepository(baseUrl: string, taskId: string): Promise<void> {
    const spec = await this.lookup.getCloneSpec(taskId);
    if (!spec) {
      this.logger.debug(`no clone spec resolved for task ${taskId}; skipping clone`);
      return;
    }

    const workspaceDir = AioSandboxProvider.WORKSPACE_DIR;
    // Auth (when present) rides `git -c http.extraHeader=...`, NEVER the URL — so a
    // clone-failure stderr that echoes the URL cannot carry the token. The header
    // value is base64 + fixed text (no single quote), so single-quoting it for the
    // shell is safe. Clone into a dedicated EMPTY workspace dir, never the
    // non-empty HOME. No trailing pipe, so the reported exit_code is the clone's.
    const command = spec.authHeader
      ? `git -c http.extraHeader='${spec.authHeader}' clone ${spec.url} ${workspaceDir}`
      : `git clone ${spec.url} ${workspaceDir}`;
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) {
      throw new Error(
        `git clone into AIO sandbox for task ${taskId} failed: /v1/shell/exec responded ${res.status}`,
      );
    }

    // Parse the response and treat a non-zero clone exit_code as a real
    // provisioning failure — an HTTP 200 with a failed command is NOT success.
    const { exitCode, output } = AioSandboxProvider.parseExecResult(
      await res.json().catch(() => undefined),
    );
    if (exitCode !== 0) {
      const scrubbed = AioSandboxProvider.scrubSecrets(output);
      throw new Error(
        `git clone into AIO sandbox for task ${taskId} failed: exit_code ${exitCode}` +
          (scrubbed ? ` — ${scrubbed.trim()}` : ''),
      );
    }

    this.logger.debug(`cloned task repository into AIO sandbox for task ${taskId}`);
  }

  /**
   * Write codex's `~/.codex` setup into the sandbox via `/v1/shell/exec` BEFORE
   * codex launches:
   *   - REMOVE the baked `~/.codex/hooks.json`. codex 0.131 detects the baked
   *     hooks as "new or changed" and blocks startup on an interactive "Hooks
   *     need review" prompt that `--dangerously-bypass-hook-trust` does NOT skip —
   *     and there is no operator in the sandbox to answer it, so codex never
   *     starts. The hooks are vestigial anyway (codex#16732: codex 0.131's
   *     PreToolUse hook was verified NOT to fire, so they enforce nothing; the
   *     container is the trust boundary per the codex-execution-not-gated product
   *     decision). Removing the file is the unblock — codex then launches into a
   *     clean TUI. `rm -f` is idempotent (a future image that stops baking the
   *     file makes this a no-op).
   *   - ALWAYS a `config.toml` pre-trusting the clone dir
   *     (`[projects."<workspace>"] trust_level="trusted"`), so codex 0.131 does
   *     NOT block on the interactive "Do you trust the contents of this
   *     directory?" prompt — there is no operator in the sandbox to answer it,
   *     and `--dangerously-bypass-hook-trust` covers HOOK trust only, not the
   *     directory-trust prompt.
   *   - the `auth.json` from {@link CodexAuthSource} when configured, so codex
   *     authenticates on startup; when none is configured codex still launches
   *     (unauthenticated) but the trust config is written regardless.
   * Each payload is base64-decoded in-container to avoid shell/JSON
   * double-escaping of multi-line content, and written `chmod 600` under the
   * `gem`-owned `~/.codex`. A non-zero exit IS a real provision failure — fail
   * closed, since a broken setup would burn a run slot doing nothing.
   */
  private async injectCodexAuth(baseUrl: string, taskId: string): Promise<void> {
    const dir = '/home/gem/.codex';
    // Pre-trust the clone dir so codex 0.131's directory-trust prompt never
    // blocks. Project-scoped to the exact dir codex runs in (`-C <WORKSPACE_DIR>`).
    const configToml =
      `[projects."${AioSandboxProvider.WORKSPACE_DIR}"]\ntrust_level = "trusted"\n`;
    const configB64 = Buffer.from(configToml, 'utf8').toString('base64');
    // The base64 alphabet has no single quote, so single-quoting each payload is
    // safe and stops the shell from touching it. mkdir is idempotent. `rm -f
    // hooks.json` removes the baked hooks so codex 0.131 does not block on its
    // "Hooks need review" prompt (see the method doc — the hooks are vestigial).
    let command =
      `mkdir -p ${dir} && rm -f ${dir}/hooks.json && printf %s '${configB64}' | base64 -d > ${dir}/config.toml && chmod 600 ${dir}/config.toml`;

    const material = await this.codexAuthSource.getCodexAuth();
    if (material) {
      const authB64 = Buffer.from(material.authJson, 'utf8').toString('base64');
      command +=
        ` && printf %s '${authB64}' | base64 -d > ${dir}/auth.json && chmod 600 ${dir}/auth.json`;
    } else {
      this.logger.warn(
        `no codex auth configured (CodexAuthSource returned null); codex in task ${taskId} will be unauthenticated (workspace trust still written)`,
      );
    }
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) {
      throw new Error(
        `codex auth injection for task ${taskId} failed: /v1/shell/exec responded ${res.status}`,
      );
    }
    const { exitCode, output } = AioSandboxProvider.parseExecResult(
      await res.json().catch(() => undefined),
    );
    if (exitCode !== 0) {
      const scrubbed = AioSandboxProvider.scrubSecrets(output);
      throw new Error(
        `codex auth injection for task ${taskId} failed: exit_code ${exitCode}` +
          (scrubbed ? ` — ${scrubbed.trim()}` : ''),
      );
    }
    this.logger.debug(
      `wrote codex setup (config.toml${material ? ' + auth.json' : ''}) into sandbox for task ${taskId}`,
    );
  }

  /**
   * Write the operator's task prompt into the sandbox at
   * {@link CODEX_PROMPT_FILE_PATH} so the bridge pre-fills codex's composer with
   * the goal via `"$(cat <file>)"` (aio-codex-prompt-autostart). The prompt is
   * base64-decoded in-container — the SAME shell-injection-safe idiom as the
   * auth/config injection — so arbitrary free-text (quotes, backticks, `$`,
   * newlines) is never touched by the shell and never reaches the launch argv (so
   * it cannot trip the hook-disabling launch guard).
   *
   * When the task has no prompt this is a no-op (no file written); the launch line
   * then opens codex with a blank composer. A non-zero exit IS a real provision
   * failure — fail closed, mirroring {@link injectCodexAuth}, since a task that
   * silently launches goal-less would burn a run slot doing nothing.
   */
  private async injectTaskPrompt(baseUrl: string, taskId: string): Promise<void> {
    const prompt = await this.lookup.getTaskPrompt(taskId);
    if (!prompt) {
      this.logger.debug(
        `no task prompt for task ${taskId}; codex opens a blank composer`,
      );
      return;
    }
    const promptB64 = Buffer.from(prompt, 'utf8').toString('base64');
    // base64 has no single quote, so single-quoting the payload is safe and stops
    // the shell from touching it. mkdir is idempotent (the auth injection already
    // made the dir; kept so this method is order-independent).
    const dir = '/home/gem/.codex';
    const command =
      `mkdir -p ${dir} && printf %s '${promptB64}' | base64 -d > ${CODEX_PROMPT_FILE_PATH} && chmod 600 ${CODEX_PROMPT_FILE_PATH}`;
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) {
      throw new Error(
        `task prompt injection for task ${taskId} failed: /v1/shell/exec responded ${res.status}`,
      );
    }
    const { exitCode, output } = AioSandboxProvider.parseExecResult(
      await res.json().catch(() => undefined),
    );
    if (exitCode !== 0) {
      const scrubbed = AioSandboxProvider.scrubSecrets(output);
      throw new Error(
        `task prompt injection for task ${taskId} failed: exit_code ${exitCode}` +
          (scrubbed ? ` — ${scrubbed.trim()}` : ''),
      );
    }
    this.logger.debug(`wrote task prompt into sandbox for task ${taskId}`);
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
  private async preinstallSkills(baseUrl: string, taskId: string): Promise<void> {
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
        const res = await fetch(`${baseUrl}/v1/shell/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command }),
          signal: AbortSignal.timeout(
            AioSandboxProvider.SKILL_INSTALL_TIMEOUT_MS,
          ),
        });
        if (!res.ok) {
          this.logger.warn(
            `task ${taskId}: skill "${id}" (${installer.label}) preinstall HTTP ${res.status} — degrading (codex launches without it)`,
          );
          continue;
        }
        const { exitCode, output } = AioSandboxProvider.parseExecResult(
          await res.json().catch(() => undefined),
        );
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
    return output
      .replace(/https:\/\/[^@\s/]+:[^@\s/]+@/g, 'https://***:***@')
      .replace(/(Authorization:\s*Basic\s+)\S+/gi, '$1***');
  }

  /**
   * Parse an AIO `/v1/shell/exec` response into `{exitCode, output}`. The live
   * AIO server NESTS the command result under a `data` object
   * (`{success, message, data:{exit_code, output, status, ...}}`), so reading the
   * fields off the TOP level yields `undefined` → a NaN exit code that fails
   * closed even on a successful command (the bug that blocked auth-inject/clone).
   * We read from `data` and tolerate a flat shape (older servers / unit mocks)
   * too. A missing code stays NaN — never `=== 0` — so absence is a failure.
   */
  private static parseExecResult(raw: unknown): { exitCode: number; output: string } {
    const top = (raw ?? {}) as Record<string, unknown>;
    const d = (top.data ?? top) as Record<string, unknown>;
    const exitCode = AioSandboxProvider.coerceExitCode(
      d.exit_code ?? d.exitCode ?? d.code,
    );
    const output =
      (typeof d.output === 'string' && d.output) ||
      (typeof d.stderr === 'string' && d.stderr) ||
      (typeof d.stdout === 'string' && d.stdout) ||
      '';
    return { exitCode, output };
  }

  /**
   * Coerce an arbitrary `/v1/shell/exec` exit-code field to a number. A missing
   * or unparseable code is treated as a non-zero failure (`NaN` is never `=== 0`),
   * so an absent `exit_code` never masquerades as a successful clone.
   */
  private static coerceExitCode(raw: unknown): number {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim());
      if (Number.isFinite(n)) return n;
    }
    return Number.NaN;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
