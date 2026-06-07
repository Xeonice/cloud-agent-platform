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
  /** Name prefix for the per-task sandbox containers (`cap-aio-<taskId>`). */
  private static readonly CONTAINER_PREFIX = 'cap-aio-';

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
    } catch (err) {
      await this.teardownSandbox(ctx.taskId).catch(() => undefined);
      throw err;
    }

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

  /**
   * Reap orphaned `cap-aio-*` containers left by a PRIOR process on startup.
   *
   * The per-task idle/teardown reclaim only tracks containers THIS process
   * provisioned (its in-memory `containers` map); after a restart (deploy,
   * crash, OOM) that map starts empty, so any `cap-aio-*` container still on the
   * host is an orphan whose task/session/guardrail state died with the previous
   * process — left running it leaks host resources forever. The orchestrator
   * owns no live session at boot (single-instance deployment: one orchestrator
   * per docker host), so EVERY such container is by definition an orphan to
   * reap. The matching stranded task rows are transitioned to `failed`
   * separately by the tasks service on startup.
   *
   * Best-effort and never throws: a docker hiccup must not block app startup.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const orphans = await this.docker.listContainers({
        all: true,
        filters: { name: [AioSandboxProvider.CONTAINER_PREFIX] },
      });
      if (orphans.length === 0) return;
      await Promise.all(
        orphans.map((info) =>
          this.docker
            .getContainer(info.Id)
            .remove({ force: true })
            .catch(() => undefined),
        ),
      );
      this.logger.warn(
        `startup reap: removed ${orphans.length} orphaned ` +
          `${AioSandboxProvider.CONTAINER_PREFIX}* sandbox container(s) from a prior process`,
      );
    } catch (err) {
      this.logger.warn(
        `startup reap of orphaned sandboxes failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
