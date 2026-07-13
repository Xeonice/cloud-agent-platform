import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type {
  CodexDeviceLoginStartResponse,
  CodexDeviceLoginStatus,
  SessionUser,
} from '@cap/contracts';

import {
  CODEX_DEVICE_LOGIN_RUNNER,
  isCodexDeviceLoginRunnerError,
  type CodexDeviceLoginRunner,
  type CodexDeviceLoginRunnerHandle,
} from './codex-device-login-runner';
import { SettingsService } from './settings.service';

type ActiveDeviceLoginStatus =
  | 'preparing'
  | 'awaiting_authorization'
  | 'finalizing';
type TerminalDeviceLoginStatus =
  | 'connected'
  | 'cancelled'
  | 'expired'
  | 'error';
type DeviceLoginStatus = ActiveDeviceLoginStatus | TerminalDeviceLoginStatus;

interface DeviceLoginSession {
  readonly sessionId: string;
  readonly generation: string;
  readonly accountId: string;
  readonly operator: SessionUser;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly abortController: AbortController;
  status: DeviceLoginStatus;
  verificationUri?: string;
  userCode?: string;
  message?: string;
  handle?: CodexDeviceLoginRunnerHandle;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  cleanupPromise?: Promise<void>;
  /**
   * Once assigned, encrypted persistence is the attempt's linearization point:
   * cancellation/deadline waits for its outcome instead of publishing a false
   * cancelled/expired terminal state after the database may have committed.
   */
  persistencePromise?: Promise<void>;
}

const TERMINAL_STATUSES = new Set<DeviceLoginStatus>([
  'connected',
  'cancelled',
  'expired',
  'error',
]);

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 2 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_PREPARE_TIMEOUT_MS = 30_000;
const DEFAULT_IO_TIMEOUT_MS = 10_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 3_000;

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates the file-backed ChatGPT credential before it crosses the existing
 * encrypted SettingsService persistence boundary. Never return the parsed
 * token object or include it in an exception/log.
 */
export function isValidCodexChatgptCredential(authJson: string): boolean {
  try {
    const value = JSON.parse(authJson) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const auth = value as {
      auth_mode?: unknown;
      tokens?: unknown;
    };
    if (auth.auth_mode !== 'chatgpt') return false;
    if (
      auth.tokens === null ||
      typeof auth.tokens !== 'object' ||
      Array.isArray(auth.tokens)
    ) {
      return false;
    }
    const tokens = auth.tokens as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
    return (
      nonEmptyString(tokens.access_token) &&
      nonEmptyString(tokens.refresh_token)
    );
  } catch {
    return false;
  }
}

/**
 * Owns account/session policy for official Codex device login. Disposable
 * Docker/App Server mechanics stay behind CodexDeviceLoginRunner.
 *
 * A session record is inserted before any await, so POST can immediately return
 * `preparing` and cancellation can win even while the worker is being created.
 */
@Injectable()
export class CodexDeviceLoginService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodexDeviceLoginService.name);
  private readonly sessionsById = new Map<string, DeviceLoginSession>();
  private readonly activeSessionByAccount = new Map<string, string>();
  private readonly backgroundWork = new Set<Promise<void>>();
  private readonly sessionTtlMs = positiveIntegerFromEnv(
    'CODEX_DEVICE_LOGIN_SESSION_TTL_MS',
    DEFAULT_SESSION_TTL_MS,
  );
  private readonly terminalRetentionMs = positiveIntegerFromEnv(
    'CODEX_DEVICE_LOGIN_TERMINAL_RETENTION_MS',
    DEFAULT_TERMINAL_RETENTION_MS,
  );
  private readonly sweepIntervalMs = positiveIntegerFromEnv(
    'CODEX_DEVICE_LOGIN_SWEEP_INTERVAL_MS',
    DEFAULT_SWEEP_INTERVAL_MS,
  );
  private readonly prepareTimeoutMs = positiveIntegerFromEnv(
    'CODEX_DEVICE_LOGIN_PREPARE_TIMEOUT_MS',
    DEFAULT_PREPARE_TIMEOUT_MS,
  );
  private readonly ioTimeoutMs = positiveIntegerFromEnv(
    'CODEX_DEVICE_LOGIN_IO_TIMEOUT_MS',
    DEFAULT_IO_TIMEOUT_MS,
  );
  private readonly cancelTimeoutMs = positiveIntegerFromEnv(
    'CODEX_DEVICE_LOGIN_CANCEL_TIMEOUT_MS',
    DEFAULT_CANCEL_TIMEOUT_MS,
  );
  private sweeper?: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(
    private readonly settings: SettingsService,
    @Inject(CODEX_DEVICE_LOGIN_RUNNER)
    private readonly runner: CodexDeviceLoginRunner,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.runner.disposeOrphans({ timeoutMs: this.ioTimeoutMs });
    } catch (error) {
      this.logger.warn(
        `Codex 登录孤儿工作器清理失败 (${this.errorCategory(error)})`,
      );
    }
    if (this.destroyed) return;
    this.sweeper = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweeper.unref?.();
  }

  /**
   * Create or recover the account's sole active attempt. This method performs no
   * asynchronous preparation before returning the shared start contract.
   */
  async start(operator: SessionUser): Promise<CodexDeviceLoginStartResponse> {
    const accountId = this.requireAccountId(operator);
    const now = Date.now();
    const existingId = this.activeSessionByAccount.get(accountId);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing && !this.isTerminal(existing.status)) {
        if (now < existing.expiresAtMs) return this.startResponse(existing);
        this.finishTerminal(
          existing,
          'expired',
          'CAP 登录会话已到期，请重新发起连接。',
          true,
        );
      } else {
        this.activeSessionByAccount.delete(accountId);
      }
    }

    if (this.destroyed) {
      throw new Error('codex device login service is shutting down');
    }

    const sessionId = randomUUID();
    const session: DeviceLoginSession = {
      sessionId,
      generation: randomUUID(),
      accountId,
      operator,
      createdAtMs: now,
      expiresAtMs: now + this.sessionTtlMs,
      abortController: new AbortController(),
      status: 'preparing',
    };

    // These writes must happen before background work is started.
    this.sessionsById.set(sessionId, session);
    this.activeSessionByAccount.set(accountId, sessionId);
    session.deadlineTimer = setTimeout(
      () => this.expireIfCurrent(session),
      this.sessionTtlMs,
    );
    session.deadlineTimer.unref?.();

    const work = this.runSession(session, session.generation);
    this.backgroundWork.add(work);
    void work.finally(() => this.backgroundWork.delete(work));
    return this.startResponse(session);
  }

  async getStatus(
    operator: SessionUser,
    sessionId: string,
  ): Promise<CodexDeviceLoginStatus> {
    const accountId = this.requireAccountId(operator);
    const session = this.sessionsById.get(sessionId);
    if (!session || session.accountId !== accountId) {
      throw this.sessionNotFound();
    }
    if (
      !this.isTerminal(session.status) &&
      !session.persistencePromise &&
      Date.now() >= session.expiresAtMs
    ) {
      this.finishTerminal(
        session,
        'expired',
        'CAP 登录会话已到期，请重新发起连接。',
        true,
      );
    }
    return this.statusResponse(session);
  }

  /** Unknown or cross-account session ids are intentionally indistinguishable. */
  async cancel(operator: SessionUser, sessionId: string): Promise<void> {
    const accountId = this.requireAccountId(operator);
    const session = this.sessionsById.get(sessionId);
    if (!session || session.accountId !== accountId || this.isTerminal(session.status)) {
      return;
    }

    // The encrypted write has already crossed its synchronous commit boundary.
    // Keep this session current and report the real persistence outcome rather
    // than allowing a retry that an older in-flight write could overwrite.
    if (session.persistencePromise) {
      await session.persistencePromise;
      return;
    }

    this.finishTerminal(session, 'cancelled', undefined, true);
    await session.cleanupPromise;
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.sweeper) clearInterval(this.sweeper);

    const sessions = [...this.sessionsById.values()];
    for (const session of sessions) {
      if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
      if (session.retentionTimer) clearTimeout(session.retentionTimer);
      // A database write cannot be aborted honestly. Let it publish connected
      // or error while preventing every earlier lifecycle phase from continuing.
      if (!session.persistencePromise) session.abortController.abort();
    }

    await Promise.all(
      sessions.map((session) =>
        this.cleanupHandle(
          session,
          !this.isTerminal(session.status) && !session.persistencePromise,
        ),
      ),
    );
    await Promise.allSettled([...this.backgroundWork]);

    // A non-conforming runner may resolve after observing the abort signal and
    // therefore publish its handle after the first cleanup pass. Waiting for
    // every tracked run closes that race; this second pass reclaims any such
    // late handle before the module drops its in-memory ownership records.
    await Promise.all(
      sessions.map((session) =>
        this.cleanupHandle(
          session,
          !this.isTerminal(session.status) && !session.persistencePromise,
        ),
      ),
    );

    for (const session of sessions) {
      if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
      if (session.retentionTimer) clearTimeout(session.retentionTimer);
      session.abortController.abort();
    }
    this.sessionsById.clear();
    this.activeSessionByAccount.clear();
  }

  private async runSession(
    session: DeviceLoginSession,
    generation: string,
  ): Promise<void> {
    let handle: CodexDeviceLoginRunnerHandle | undefined;
    try {
      handle = await this.runner.start({
        sessionId: session.sessionId,
        signal: session.abortController.signal,
        timeoutMs: Math.min(this.prepareTimeoutMs, this.remainingMs(session)),
      });

      if (
        this.destroyed ||
        session.abortController.signal.aborted ||
        !this.canTransition(session, ['preparing'], generation)
      ) {
        await this.disposeStaleHandle(handle, true);
        return;
      }
      session.handle = handle;
      session.status = 'awaiting_authorization';
      session.verificationUri = handle.authorization.verificationUrl;
      session.userCode = handle.authorization.userCode;

      const completion = await handle.waitForCompletion({
        signal: session.abortController.signal,
        timeoutMs: this.remainingMs(session),
      });
      if (!this.canTransition(session, ['awaiting_authorization'], generation)) return;
      if (!completion.success) {
        this.finishTerminal(
          session,
          'error',
          'device_login_authorization_failed: Codex 授权未完成。',
          false,
        );
        return;
      }

      session.status = 'finalizing';
      this.clearPublicAuthorization(session);

      const authJson = await handle.readCredential({
        signal: session.abortController.signal,
        timeoutMs: Math.min(this.ioTimeoutMs, this.remainingMs(session)),
      });
      if (!this.canTransition(session, ['finalizing'], generation)) return;
      if (!isValidCodexChatgptCredential(authJson)) {
        this.finishTerminal(
          session,
          'error',
          'device_login_credential_invalid: Codex 登录凭据无效，请重新授权。',
          false,
        );
        return;
      }

      // There is no asynchronous gap between the final generation check and
      // assigning persistencePromise. DELETE/deadline therefore either wins
      // before this boundary, or waits for the real encrypted-write outcome.
      if (!this.canTransition(session, ['finalizing'], generation)) return;
      const persistence = this.persistCredential(session, generation, authJson);
      session.persistencePromise = persistence;
      await persistence;
    } catch (error) {
      if (this.destroyed) return;
      if (!this.isLiveGeneration(session, generation)) return;
      if (Date.now() >= session.expiresAtMs) {
        this.finishTerminal(
          session,
          'expired',
          'CAP 登录会话已到期，请重新发起连接。',
          true,
        );
        return;
      }
      this.finishTerminal(
        session,
        'error',
        this.safeErrorMessage(error),
        false,
      );
    } finally {
      if (handle && this.isTerminal(session.status)) {
        await handle.dispose().catch(() => undefined);
      }
    }
  }

  private async persistCredential(
    session: DeviceLoginSession,
    generation: string,
    authJson: string,
  ): Promise<void> {
    try {
      await this.settings.saveCredential(session.operator, {
        mode: 'official',
        authJson,
      });
    } catch {
      if (this.canTransition(session, ['finalizing'], generation)) {
        this.finishTerminal(
          session,
          'error',
          'device_login_persistence_failed: Codex 登录凭据保存失败，请重试。',
          false,
        );
      }
      return;
    }

    if (this.canTransition(session, ['finalizing'], generation)) {
      this.finishTerminal(session, 'connected', undefined, false);
    }
  }

  private finishTerminal(
    session: DeviceLoginSession,
    status: TerminalDeviceLoginStatus,
    message: string | undefined,
    requestCancel: boolean,
  ): boolean {
    if (!this.isLiveGeneration(session)) return false;

    session.status = status;
    session.message = message;
    this.clearPublicAuthorization(session);
    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = undefined;
    }
    if (this.activeSessionByAccount.get(session.accountId) === session.sessionId) {
      this.activeSessionByAccount.delete(session.accountId);
    }
    session.abortController.abort();
    session.cleanupPromise = this.cleanupHandle(session, requestCancel);
    this.scheduleTerminalRemoval(session);
    this.logger.debug(
      `Codex 登录会话 ${session.sessionId} 进入 ${status} (${this.messageCategory(message)})`,
    );
    return true;
  }

  private async cleanupHandle(
    session: DeviceLoginSession,
    requestCancel: boolean,
  ): Promise<void> {
    const handle = session.handle;
    if (!handle) return;
    if (requestCancel) {
      try {
        await handle.cancel({ timeoutMs: this.cancelTimeoutMs });
      } catch (error) {
        this.logCleanupFailure(session, error);
      }
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await handle.dispose();
        if (session.handle === handle) session.handle = undefined;
        return;
      } catch (error) {
        this.logCleanupFailure(session, error);
        if (attempt < 2) await this.delay(50 * 2 ** attempt);
      }
    }
  }

  private async disposeStaleHandle(
    handle: CodexDeviceLoginRunnerHandle,
    requestCancel: boolean,
  ): Promise<void> {
    if (requestCancel) {
      await handle.cancel({ timeoutMs: this.cancelTimeoutMs }).catch((error) => {
        this.logger.warn(
          `Codex 迟到登录工作器取消失败 (${this.errorCategory(error)})`,
        );
      });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await handle.dispose();
        return;
      } catch (error) {
        this.logger.warn(
          `Codex 迟到登录工作器清理失败 (${this.errorCategory(error)})`,
        );
        if (attempt < 2) await this.delay(50 * 2 ** attempt);
      }
    }
  }

  private expireIfCurrent(session: DeviceLoginSession): void {
    if (!this.isLiveGeneration(session) || session.persistencePromise) return;
    this.finishTerminal(
      session,
      'expired',
      'CAP 登录会话已到期，请重新发起连接。',
      true,
    );
  }

  private sweep(): void {
    const now = Date.now();
    for (const session of this.sessionsById.values()) {
      if (
        !this.isTerminal(session.status) &&
        !session.persistencePromise &&
        now >= session.expiresAtMs
      ) {
        this.expireIfCurrent(session);
      }
    }
  }

  private scheduleTerminalRemoval(session: DeviceLoginSession): void {
    if (session.retentionTimer) clearTimeout(session.retentionTimer);
    session.retentionTimer = setTimeout(() => {
      void (async () => {
        if (this.sessionsById.get(session.sessionId) !== session) return;
        if (session.handle) {
          await this.cleanupHandle(session, false);
          if (session.handle) {
            this.scheduleTerminalRemoval(session);
            return;
          }
        }
        this.sessionsById.delete(session.sessionId);
      })();
    }, this.terminalRetentionMs);
    session.retentionTimer.unref?.();
  }

  private isLiveGeneration(
    session: DeviceLoginSession,
    generation: string = session.generation,
  ): boolean {
    return (
      this.sessionsById.get(session.sessionId) === session &&
      session.generation === generation &&
      !this.isTerminal(session.status)
    );
  }

  private canTransition(
    session: DeviceLoginSession,
    from: readonly ActiveDeviceLoginStatus[],
    generation: string = session.generation,
  ): boolean {
    return (
      this.isLiveGeneration(session, generation) &&
      this.activeSessionByAccount.get(session.accountId) === session.sessionId &&
      from.includes(session.status as ActiveDeviceLoginStatus) &&
      Date.now() < session.expiresAtMs
    );
  }

  private isTerminal(status: DeviceLoginStatus): status is TerminalDeviceLoginStatus {
    return TERMINAL_STATUSES.has(status);
  }

  private remainingMs(session: DeviceLoginSession): number {
    return Math.max(1, session.expiresAtMs - Date.now());
  }

  private clearPublicAuthorization(session: DeviceLoginSession): void {
    session.verificationUri = undefined;
    session.userCode = undefined;
  }

  private startResponse(
    session: DeviceLoginSession,
  ): CodexDeviceLoginStartResponse {
    return {
      sessionId: session.sessionId,
      status: 'preparing',
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    };
  }

  private statusResponse(session: DeviceLoginSession): CodexDeviceLoginStatus {
    const common = {
      sessionId: session.sessionId,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    };
    switch (session.status) {
      case 'preparing':
        return { ...common, status: 'preparing' };
      case 'awaiting_authorization':
        return {
          ...common,
          status: 'awaiting_authorization',
          verificationUri: session.verificationUri as string,
          userCode: session.userCode as string,
        };
      case 'finalizing':
        return { ...common, status: 'finalizing' };
      case 'connected':
        return { ...common, status: 'connected' };
      case 'cancelled':
        return { ...common, status: 'cancelled' };
      case 'expired':
        return {
          ...common,
          status: 'expired',
          message: session.message ?? 'CAP 登录会话已到期，请重新发起连接。',
        };
      case 'error':
        return {
          ...common,
          status: 'error',
          message: session.message ?? 'device_login_failed: Codex 登录失败，请重试。',
        };
    }
  }

  private requireAccountId(operator: SessionUser): string {
    const accountId = operator?.id;
    if (!nonEmptyString(accountId)) {
      throw new Error('codex device login requires an authenticated account session');
    }
    return accountId;
  }

  private sessionNotFound(): NotFoundException {
    return new NotFoundException({
      error: 'device_login_session_not_found',
      message: '登录会话不存在或已结束，请重新发起连接。',
    });
  }

  private safeErrorMessage(error: unknown): string {
    if (isCodexDeviceLoginRunnerError(error)) {
      return `${error.category}: ${error.message}`;
    }
    return 'device_login_failed: Codex 登录失败，请重试。';
  }

  private errorCategory(error: unknown): string {
    return isCodexDeviceLoginRunnerError(error)
      ? error.category
      : 'device_login_cleanup_failed';
  }

  private messageCategory(message: string | undefined): string {
    if (!message) return 'none';
    const separator = message.indexOf(':');
    return separator > 0 ? message.slice(0, separator) : 'session_deadline';
  }

  private logCleanupFailure(session: DeviceLoginSession, error: unknown): void {
    this.logger.warn(
      `Codex 登录会话 ${session.sessionId} 工作器清理失败 (${this.errorCategory(error)})`,
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
