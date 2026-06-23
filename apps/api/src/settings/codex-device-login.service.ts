import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Docker from 'dockerode';
import type {
  CodexDeviceLoginStartResponse,
  CodexDeviceLoginStatus,
  SessionUser,
} from '@cap/contracts';

import { SettingsService } from './settings.service';

/** One in-flight device-code login for an operator. */
interface LoginSession {
  readonly sessionId: string;
  readonly containerName: string;
  readonly baseUrl: string;
  readonly container: Docker.Container;
  readonly startedAtMs: number;
  /** Updated on each poll; lets the sweep reclaim a session the client abandoned. */
  lastPolledAtMs: number;
  verificationUri: string;
  userCode: string;
}

/**
 * Drives the OFFICIAL ChatGPT connect as an OAuth DEVICE-CODE flow, delegating
 * the actual OAuth to the codex CLI (which OpenAI maintains) rather than
 * re-implementing OpenAI's undocumented device endpoints:
 *
 *   1. `start()` provisions a transient AIO container (codex baked in, on
 *      `cap-net`, no host port) and launches `codex login --device-auth` detached
 *      in it, then parses the verification URL + one-time code codex prints.
 *   2. The operator opens the URL and authorizes in their ChatGPT browser session
 *      (this is the only step that must happen at OpenAI — codex's first-party
 *      client cannot redirect back to this web app, so a device flow is the only
 *      remote-web-compatible path).
 *   3. `pollStatus()` watches the container for the `~/.codex/auth.json` codex
 *      writes on success, then stores it via {@link SettingsService.saveCredential}
 *      (`mode:'official'`, encrypted at rest) and tears the container down.
 *
 * The login container is owned here (its own dockerode lifecycle, distinct from
 * per-task sandboxes); it auto-removes and a sweep reclaims abandoned sessions.
 */
@Injectable()
export class CodexDeviceLoginService implements OnModuleDestroy {
  private readonly logger = new Logger(CodexDeviceLoginService.name);
  private readonly docker = new Docker();
  /** Active sessions keyed by the operator's account primary key `user.id`
   *  (fix-local-account-settings-scope) — present for both local and GitHub
   *  accounts, so device login is per-account and works for local accounts. */
  private readonly sessions = new Map<string, LoginSession>();
  /** Per-operator in-flight guard: serializes start() so a double-click / retry
   *  can never create two login containers for the same account. */
  private readonly starting = new Set<string>();
  /** EVERY created login container by name, so an orphan (start failed, app
   *  shutdown) is reclaimable even before/without a session-map entry. */
  private readonly allContainers = new Map<string, Docker.Container>();
  private sweeper?: ReturnType<typeof setInterval>;

  private static readonly AIO_PORT = 8080;
  private static readonly SECCOMP_UNCONFINED = 'seccomp=unconfined';
  private static readonly SHM_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
  /** codex device codes last ~15 minutes; reclaim a little after. */
  private static readonly SESSION_TTL_MS = 16 * 60 * 1000;
  private static readonly EXPIRES_IN_SECONDS = 15 * 60;

  constructor(private readonly settings: SettingsService) {
    // Reclaim abandoned login containers (operator closed the dialog without
    // finishing) so a transient container never lingers past the code window.
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  /**
   * Begin a device-code login for the operator: provision the transient codex
   * container, launch `codex login --device-auth`, and return the verification
   * URL + one-time code to display. Any prior in-flight session for this operator
   * is torn down first (one active login per account).
   */
  async start(operator: SessionUser): Promise<CodexDeviceLoginStartResponse> {
    const key = this.requireKey(operator);
    // Serialize per operator: a double-click / client retry must not spin up two
    // login containers (the second would orphan the first). One active start at a
    // time per account.
    if (this.starting.has(key)) {
      throw new Error('一个登录会话正在进行中，请稍候或刷新后重试。');
    }
    this.starting.add(key);
    try {
      await this.teardown(key);

      const image = process.env.AIO_SANDBOX_IMAGE;
      if (!image) {
        throw new Error('AIO_SANDBOX_IMAGE must be set to start a codex device login');
      }
      const network = process.env.AIO_SANDBOX_NETWORK ?? 'cap-net';
      const sessionId = randomUUID();
      const containerName = `cap-codexlogin-${sessionId}`;
      const baseUrl = `http://${containerName}:${CodexDeviceLoginService.AIO_PORT}`;

      const container = await this.docker.createContainer({
        Image: image,
        name: containerName,
        HostConfig: {
          SecurityOpt: [CodexDeviceLoginService.SECCOMP_UNCONFINED],
          ShmSize: CodexDeviceLoginService.SHM_SIZE_BYTES,
          AutoRemove: true,
          NetworkMode: network,
          // No PortBindings — reached by container name on cap-net, like task sandboxes.
        },
      });
      // Track the container the moment it exists (BEFORE start) so a start()/
      // readiness failure — or app shutdown — can still reclaim it; the catch +
      // onModuleDestroy + sweep all key off allContainers.
      this.allContainers.set(containerName, container);

      try {
        await container.start();
        await this.waitForReadiness(baseUrl);
        // Launch detached (setsid + redirect) so codex keeps polling OpenAI after
        // this exec returns; it prints the URL + code, then writes auth.json on
        // success. Remove any stale auth.json first so the poll only ever sees a
        // login completed in THIS session.
        await this.exec(
          baseUrl,
          'rm -f /home/gem/.codex/auth.json; ' +
            'setsid sh -c "codex login --device-auth > /tmp/codexlogin.log 2>&1" ' +
            '</dev/null >/dev/null 2>&1 & echo launched',
        );

        const parsed = await this.pollForCode(baseUrl);
        if (!parsed) {
          // No code surfaced — most often device-auth is not enabled on the account.
          const log = await this.readLog(baseUrl);
          throw new Error(
            'codex device login did not return a code (is device-code login enabled ' +
              'in your ChatGPT security settings?)' +
              (log ? ` — ${log.slice(0, 300)}` : ''),
          );
        }

        const now = Date.now();
        this.sessions.set(key, {
          sessionId,
          containerName,
          baseUrl,
          container,
          startedAtMs: now,
          lastPolledAtMs: now,
          verificationUri: parsed.verificationUri,
          userCode: parsed.userCode,
        });
        this.logger.debug(`codex device login ${sessionId} awaiting authorization`);
        return {
          verificationUri: parsed.verificationUri,
          userCode: parsed.userCode,
          expiresInSeconds: CodexDeviceLoginService.EXPIRES_IN_SECONDS,
        };
      } catch (err) {
        await this.teardownContainer(container, containerName).catch(() => undefined);
        throw err;
      }
    } finally {
      this.starting.delete(key);
    }
  }

  /**
   * Poll the operator's in-flight login: returns `connected` once codex has
   * written auth.json (and the credential has been stored), `expired` past the
   * code window, `error` if the session is gone, else `awaiting_authorization`.
   */
  async pollStatus(operator: SessionUser): Promise<CodexDeviceLoginStatus> {
    const key = this.requireKey(operator);
    const session = this.sessions.get(key);
    if (!session) {
      return { status: 'error', message: '没有进行中的登录会话，请重新发起连接。' };
    }
    if (Date.now() - session.startedAtMs > CodexDeviceLoginService.SESSION_TTL_MS) {
      await this.teardown(key);
      return { status: 'expired', message: '设备码已过期，请重新发起连接。' };
    }
    session.lastPolledAtMs = Date.now();

    let authJson: string | null = null;
    try {
      const { exitCode, output } = await this.exec(
        session.baseUrl,
        'cat /home/gem/.codex/auth.json 2>/dev/null',
      );
      if (exitCode === 0 && this.looksLikeCodexAuth(output)) {
        authJson = output.trim();
      }
    } catch (err) {
      // A transient exec failure is not fatal — keep awaiting; the next poll retries.
      this.logger.debug(
        `device login poll exec failed (will retry): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (authJson) {
      // Store the login encrypted via the settings credential, then reclaim the
      // container. saveCredential resolves the owning user from the operator.
      await this.settings.saveCredential(operator, { mode: 'official', authJson });
      await this.teardown(key);
      this.logger.debug(`codex device login for ${key} connected + stored`);
      return { status: 'connected' };
    }

    return {
      status: 'awaiting_authorization',
      verificationUri: session.verificationUri,
      userCode: session.userCode,
    };
  }

  /** Cancel + reclaim the operator's in-flight login, if any. */
  async cancel(operator: SessionUser): Promise<void> {
    await this.teardown(this.requireKey(operator));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    // Reclaim EVERY created login container (covers any orphan not tied to a live
    // session), not just the session-mapped ones, so app shutdown leaves nothing.
    const containers = [...this.allContainers];
    this.sessions.clear();
    this.allContainers.clear();
    await Promise.all(
      containers.map(([name, c]) => this.teardownContainer(c, name).catch(() => undefined)),
    );
  }

  // ----- internals -----------------------------------------------------------

  /**
   * The per-account session key — the account primary key `operator.id`
   * (fix-local-account-settings-scope), present for both local and GitHub
   * accounts. Rejects ONLY an identity-less principal (no account at all).
   */
  private requireKey(operator: SessionUser): string {
    const userId = operator?.id;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('codex device login requires an authenticated account session');
    }
    return userId;
  }

  /** Parse the verification URL + one-time code from codex's device-auth output. */
  private async pollForCode(
    baseUrl: string,
  ): Promise<{ verificationUri: string; userCode: string } | null> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const log = await this.readLog(baseUrl);
      const parsed = CodexDeviceLoginService.parseDeviceCode(log);
      if (parsed) return parsed;
      await this.delay(800);
    }
    return null;
  }

  /**
   * Extract the verification URL + user code from codex's (ANSI-coloured) output:
   *   "Open this link ... https://auth.openai.com/codex/device"
   *   "Enter this one-time code ... 9L44-TBBVF"
   */
  static parseDeviceCode(
    log: string,
  ): { verificationUri: string; userCode: string } | null {
    // Strip ANSI SGR codes. ESC (0x1b) is built via char code so the regex
    // literal carries no control character (eslint no-control-regex).
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const clean = log.replace(ansi, '');
    const uri = clean.match(/https:\/\/auth\.openai\.com\/[A-Za-z0-9/_-]*device[A-Za-z0-9/_-]*/);
    if (!uri) return null;
    // The one-time code is printed AFTER the verification URL (codex's step 2).
    // Scan ONLY the post-URL region so a code-shaped token earlier in the banner
    // (a request id, a SHA fragment) cannot be mistaken for the code. Allow >2
    // groups so a 3-group code is captured whole, not truncated.
    const after = clean.slice((uri.index ?? 0) + uri[0].length);
    const code = after.match(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4,6})+)\b/);
    if (!code) return null;
    return { verificationUri: uri[0], userCode: code[1] };
  }

  private async readLog(baseUrl: string): Promise<string> {
    try {
      const { output } = await this.exec(baseUrl, 'cat /tmp/codexlogin.log 2>/dev/null');
      return output;
    } catch {
      return '';
    }
  }

  private looksLikeCodexAuth(output: string): boolean {
    try {
      const p = JSON.parse(output.trim()) as {
        auth_mode?: unknown;
        tokens?: unknown;
        OPENAI_API_KEY?: unknown;
      };
      // Require REAL material — not a tokenless scaffold codex might write before
      // it has the tokens: a non-null tokens OBJECT, OR a non-empty OPENAI_API_KEY,
      // OR (last resort) a non-empty auth_mode. `{tokens:null}` must NOT pass.
      const hasTokens =
        p.tokens !== null && typeof p.tokens === 'object';
      const hasApiKey =
        typeof p.OPENAI_API_KEY === 'string' && p.OPENAI_API_KEY.length > 0;
      const hasMode = typeof p.auth_mode === 'string' && p.auth_mode.length > 0;
      return hasTokens || hasApiKey || hasMode;
    } catch {
      return false;
    }
  }

  private async waitForReadiness(baseUrl: string): Promise<void> {
    const deadline = Date.now() + Number(process.env.AIO_SANDBOX_READINESS_TIMEOUT_MS ?? 60_000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/v1/docs`);
        if (res.ok) return;
        lastError = new Error(`/v1/docs responded ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await this.delay(250);
    }
    throw new Error(
      `codex login container not ready: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /** POST /v1/shell/exec, tolerating the AIO `data`-nested result envelope. */
  private async exec(
    baseUrl: string,
    command: string,
  ): Promise<{ exitCode: number; output: string }> {
    const res = await fetch(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) throw new Error(`/v1/shell/exec responded ${res.status}`);
    const raw = (await res.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    const d = ((raw?.data ?? raw) ?? {}) as Record<string, unknown>;
    const codeRaw = d.exit_code ?? d.exitCode ?? d.code;
    const exitCode =
      typeof codeRaw === 'number'
        ? codeRaw
        : typeof codeRaw === 'string' && /^-?\d+$/.test(codeRaw.trim())
          ? Number.parseInt(codeRaw.trim(), 10)
          : Number.NaN;
    const output =
      (typeof d.output === 'string' && d.output) ||
      (typeof d.stdout === 'string' && d.stdout) ||
      (typeof d.stderr === 'string' && d.stderr) ||
      '';
    return { exitCode, output };
  }

  private async teardown(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    await this.teardownContainer(session.container, session.containerName);
  }

  private async teardownContainer(
    container: Docker.Container,
    name: string,
  ): Promise<void> {
    this.allContainers.delete(name);
    await container.stop({ t: 0 }).catch(() => undefined);
    await container.remove({ force: true }).catch(() => undefined);
    this.logger.debug(`reclaimed codex login container ${name}`);
  }

  /** Idle window after which a session whose client stopped polling is reclaimed. */
  private static readonly ABANDONED_AFTER_MS = 2 * 60 * 1000;

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const [key, s] of [...this.sessions]) {
      // Reclaim a hard-expired session OR one the client clearly abandoned (no
      // poll for ABANDONED_AFTER_MS — tab killed / navigated away with the
      // best-effort cancel lost) so a transient container is not held the full TTL.
      if (
        now - s.startedAtMs > CodexDeviceLoginService.SESSION_TTL_MS ||
        now - s.lastPolledAtMs > CodexDeviceLoginService.ABANDONED_AFTER_MS
      ) {
        await this.teardown(key).catch(() => undefined);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
