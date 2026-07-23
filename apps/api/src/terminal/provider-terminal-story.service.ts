import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import {
  providerMatchesSandboxTerminalStoryRequest,
  resolveSandboxTerminalStoryReadiness,
  selectSandboxProvider,
  type SandboxTerminalStoryProvider,
  type SandboxTerminalStoryReadiness,
  type SandboxProviderCapability,
  type SelectedSandboxRun,
} from '@cap/sandbox';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { TerminalGateway } from './terminal.gateway';

export type ProviderTerminalStoryProvider = SandboxTerminalStoryProvider;
export type ProviderTerminalStoryReadiness = SandboxTerminalStoryReadiness;

export interface ProviderTerminalStorySessionView {
  readonly sessionId: string;
  readonly status: 'running' | 'tearing_down' | 'torn_down';
  readonly providerId: string;
  readonly requestedProvider: ProviderTerminalStoryProvider;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly terminalPath: '/terminal';
  readonly teardownError?: string;
}

export interface CreateProviderTerminalStorySessionInput {
  readonly provider?: string;
  readonly ttlMs?: number;
}

interface ProviderTerminalStorySessionRecord extends ProviderTerminalStorySessionView {
  readonly backingRepoId: string;
  readonly timer?: NodeJS.Timeout;
}

const STORY_ENABLE_ENV = 'CAP_PROVIDER_TERMINAL_STORY';
const STORY_PROVIDER_ENV = 'CAP_PROVIDER_TERMINAL_STORY_PROVIDER';
const STORY_DEFAULT_TTL_MS = 10 * 60_000;
const STORY_MIN_TTL_MS = 10_000;
const STORY_MAX_TTL_MS = 30 * 60_000;
const STORY_REPO_GIT_SOURCE = 'provider-terminal-story://local-fixture';
const REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
] as const;

@Injectable()
export class ProviderTerminalStoryService {
  private readonly logger = new Logger(ProviderTerminalStoryService.name);
  private readonly sessions = new Map<string, ProviderTerminalStorySessionRecord>();

  constructor(
    @Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider,
    private readonly gateway: TerminalGateway,
    private readonly prisma: PrismaService,
  ) {}

  async readiness(rawProvider?: string): Promise<ProviderTerminalStoryReadiness> {
    const capabilities = this.sandbox.getProviderCapabilities?.() ?? [];
    try {
      return resolveSandboxTerminalStoryReadiness({
        enabled: storyEnabled(),
        rawProvider,
        envProvider: process.env[STORY_PROVIDER_ENV],
        capabilities,
        requiredCapabilities: REQUIRED_CAPABILITIES,
        enableEnvName: STORY_ENABLE_ENV,
      });
    } catch (err) {
      throw new PreconditionFailedException(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async createSession(
    input: CreateProviderTerminalStorySessionInput = {},
  ): Promise<ProviderTerminalStorySessionView> {
    const readiness = await this.readiness(input.provider);
    if (!readiness.enabled) {
      throw new ForbiddenException(readiness.reason);
    }
    if (!readiness.ready) {
      throw new PreconditionFailedException(readiness.reason);
    }

    const sessionId = `terminal-story-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const ttlMs = normalizeTtl(input.ttlMs);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const selected = selectSandboxProvider(this.sandbox, REQUIRED_CAPABILITIES);
    let selectedRun: SelectedSandboxRun | null = null;
    let providerId = readiness.providerId ?? 'unknown';
    let backingRepoId: string | null = null;

    try {
      backingRepoId = await this.createBackingTask(sessionId);
      const connection = await selected.provider.provision({
        taskId: sessionId,
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
      });
      selectedRun =
        (await selected.provider.getSelectedSandboxRun?.(sessionId)) ?? null;
      providerId = selectedRun?.providerId ?? providerId;

      if (
        !providerMatchesSandboxTerminalStoryRequest(
          readiness.requestedProvider,
          providerId,
        )
      ) {
        await selected.provider.teardownSandbox(sessionId).catch(() => undefined);
        throw new PreconditionFailedException(
          `provider-backed terminal story requested ${readiness.requestedProvider}, but selected provider was ${providerId}; refusing fallback`,
        );
      }

      this.gateway.openSession(connection, selectedRun, {
        mode: 'provider-story-fixture',
        recordExit: false,
      });

      const timer = setTimeout(() => {
        void this.teardownSession(sessionId).catch((err: unknown) => {
          this.logger.warn(
            `provider terminal story ${sessionId}: TTL cleanup failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }, ttlMs);
      timer.unref?.();

      const record: ProviderTerminalStorySessionRecord = {
        sessionId,
        status: 'running',
        providerId,
        requestedProvider: readiness.requestedProvider,
        createdAt: new Date().toISOString(),
        expiresAt,
        terminalPath: '/terminal',
        backingRepoId,
        timer,
      };
      this.sessions.set(sessionId, record);
      return publicSessionView(record);
    } catch (err) {
      this.gateway.unregisterSession(sessionId);
      await selected.provider.teardownSandbox(sessionId).catch(() => undefined);
      if (backingRepoId) await this.deleteBackingRepo(backingRepoId);
      throw err;
    }
  }

  getSession(sessionId: string): ProviderTerminalStorySessionView {
    const record = this.sessions.get(sessionId);
    if (!record) throw new NotFoundException('provider terminal story session not found');
    return publicSessionView(record);
  }

  async teardownSession(sessionId: string): Promise<ProviderTerminalStorySessionView> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new NotFoundException('provider terminal story session not found');
    if (record.timer) clearTimeout(record.timer);
    const tearingDown: ProviderTerminalStorySessionRecord = {
      ...record,
      status: 'tearing_down',
      timer: undefined,
    };
    this.sessions.set(sessionId, tearingDown);
    this.gateway.unregisterSession(sessionId);
    let teardownError: string | undefined;
    try {
      await this.sandbox.teardownSandbox(sessionId);
    } catch (err) {
      teardownError = err instanceof Error ? err.message : String(err);
    }
    try {
      await this.deleteBackingRepo(record.backingRepoId);
    } catch (err) {
      const repoError = err instanceof Error ? err.message : String(err);
      teardownError = teardownError
        ? `${teardownError}; backing repo cleanup failed: ${repoError}`
        : `backing repo cleanup failed: ${repoError}`;
    }
    const done: ProviderTerminalStorySessionRecord = {
      ...tearingDown,
      status: 'torn_down',
      ...(teardownError ? { teardownError } : {}),
    };
    this.sessions.set(sessionId, done);
    return publicSessionView(done);
  }

  async cleanupAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) => this.teardownSession(sessionId)),
    );
  }

  private async createBackingTask(sessionId: string): Promise<string> {
    const repo = await this.prisma.repo.create({
      data: {
        name: `provider-terminal-story-${sessionId}`,
        gitSource: STORY_REPO_GIT_SOURCE,
        tasks: {
          create: {
            id: sessionId,
            prompt: 'Provider terminal story fixture',
            status: 'running',
          },
        },
      },
      select: { id: true },
    });
    return repo.id;
  }

  /**
   * Removes the throwaway fixture Repo created by {@link createBackingTask}.
   *
   * Deliberately does NOT cascade into the repo-store (add-repo-content-store).
   * This row is a story-harness fixture, gated behind `CAP_PROVIDER_TERMINAL_STORY`
   * and written straight through Prisma: it never passes an import surface, so
   * `RepoStoreService.acquire()` is never called for it and no `<repoId>.git`
   * mirror can exist on the volume. Wiring `remove()` in here would add a
   * guaranteed no-op (plus a repo-store dependency) to a harness path. The
   * operator-reachable delete cascade lives on `DELETE /repos/:repoId`
   * (`RepoCopyService.deleteRepo`), which is what real Repos are deleted through.
   *
   * It also intentionally keeps using `deleteMany` rather than that service: the
   * fixture repo OWNS a running story task, which the real delete surface refuses
   * (`repo_has_tasks`) — here the cascade to that one task IS the teardown.
   */
  private async deleteBackingRepo(repoId: string): Promise<void> {
    await this.prisma.repo.deleteMany({ where: { id: repoId } });
  }
}

function storyEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[STORY_ENABLE_ENV] ?? '');
}

function normalizeTtl(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return STORY_DEFAULT_TTL_MS;
  return Math.min(STORY_MAX_TTL_MS, Math.max(STORY_MIN_TTL_MS, Math.trunc(raw)));
}

function publicSessionView(
  record: ProviderTerminalStorySessionRecord,
): ProviderTerminalStorySessionView {
  return {
    sessionId: record.sessionId,
    status: record.status,
    providerId: record.providerId,
    requestedProvider: record.requestedProvider,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    terminalPath: '/terminal',
    ...(record.teardownError ? { teardownError: record.teardownError } : {}),
  };
}
