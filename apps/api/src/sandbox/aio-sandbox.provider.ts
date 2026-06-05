import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Docker from 'dockerode';

import type {
  ProvisionContext,
  SandboxConnection,
  SandboxMode,
  SandboxProvider,
} from './sandbox-provider.port.js';

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
 *   - `TASK_REPO_URL` (optional) — the git clone URL for the task workspace.
 *     When set, the repository is cloned into the sandbox workspace before the
 *     handle is returned. (Credential/URL sourcing per task is an Open Question
 *     deferred to integration; the provider only needs the clone URL here.)
 */
@Injectable()
export class AioSandboxProvider implements SandboxProvider, OnModuleDestroy {
  private readonly logger = new Logger(AioSandboxProvider.name);
  private readonly docker = new Docker();
  /** taskId -> the per-task AIO container. */
  private readonly containers = new Map<string, Docker.Container>();
  /** taskId -> the connection handle returned for an already-provisioned task. */
  private readonly connections = new Map<string, SandboxConnection>();

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

    const containerName = `cap-aio-${ctx.taskId}`;
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
        AutoRemove: true,
        // Join the private network so the orchestrator can dial by container
        // name; the default bridge has no container-name DNS.
        NetworkMode: network,
        // NO PortBindings — the sandbox publishes no host port; network
        // isolation on `cap-net` is the execution security boundary.
      },
    });
    this.containers.set(ctx.taskId, container);
    await container.start();
    this.logger.debug(`provisioned AIO container ${containerName} from ${image}`);

    // Readiness: do not treat the sandbox as usable until its HTTP API answers.
    await this.waitForReadiness(baseUrl, ctx.taskId);

    // Clone the task repository into the sandbox workspace AFTER readiness and
    // BEFORE returning the handle.
    await this.cloneTaskRepository(baseUrl, ctx.taskId);

    const connection: SandboxConnection = { taskId: ctx.taskId, baseUrl, wsUrl };
    this.connections.set(ctx.taskId, connection);
    return connection;
  }

  /**
   * Tear down the running sandbox for a task: stop + remove. With `AutoRemove`
   * the stop is sufficient to delete the container. Idempotent — tearing down a
   * task that already exited or was never started is a safe no-op.
   */
  async teardownSandbox(taskId: string): Promise<void> {
    this.connections.delete(taskId);
    const container = this.containers.get(taskId);
    if (!container) return;
    this.containers.delete(taskId);
    // `t: 0` = stop immediately; AutoRemove then deletes the container. If the
    // container already exited/was removed, removing explicitly is a safe no-op.
    await container.stop({ t: 0 }).catch(() => {
      // Already stopped/removed — fine.
    });
    await container.remove({ force: true }).catch(() => {
      // AutoRemove already deleted it (or it never started) — fine.
    });
  }

  /** Stop every provisioned container on app shutdown so none is orphaned. */
  async onModuleDestroy(): Promise<void> {
    const containers = [...this.containers.values()];
    this.containers.clear();
    this.connections.clear();
    await Promise.all(containers.map((c) => c.stop({ t: 0 }).catch(() => undefined)));
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
    const repoUrl = process.env.TASK_REPO_URL;
    if (!repoUrl) {
      this.logger.debug(`no TASK_REPO_URL configured; skipping clone for task ${taskId}`);
      return;
    }

    const workspaceDir = AioSandboxProvider.WORKSPACE_DIR;
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Clone into a dedicated empty workspace dir, never the non-empty HOME.
      // No trailing pipe, so the reported exit_code is the clone's own status.
      body: JSON.stringify({ command: `git clone ${repoUrl} ${workspaceDir}` }),
    });
    if (!res.ok) {
      throw new Error(
        `git clone into AIO sandbox for task ${taskId} failed: /v1/shell/exec responded ${res.status}`,
      );
    }

    // Parse the response body and treat a non-zero clone exit_code as a real
    // provisioning failure — an HTTP 200 with a failed command is NOT success.
    const body = (await res.json().catch(() => undefined)) as
      | {
          exit_code?: unknown;
          exitCode?: unknown;
          code?: unknown;
          output?: unknown;
          stdout?: unknown;
          stderr?: unknown;
        }
      | undefined;
    const exitCode = AioSandboxProvider.coerceExitCode(
      body?.exit_code ?? body?.exitCode ?? body?.code,
    );
    if (exitCode !== 0) {
      const output =
        (typeof body?.output === 'string' && body.output) ||
        (typeof body?.stderr === 'string' && body.stderr) ||
        (typeof body?.stdout === 'string' && body.stdout) ||
        '';
      throw new Error(
        `git clone into AIO sandbox for task ${taskId} failed: exit_code ${exitCode}` +
          (output ? ` — ${output.trim()}` : ''),
      );
    }

    this.logger.debug(`cloned task repository into AIO sandbox for task ${taskId}`);
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
