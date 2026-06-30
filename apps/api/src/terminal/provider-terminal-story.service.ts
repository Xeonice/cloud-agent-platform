import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import {
  readBoxLiteProviderConfig,
  selectSandboxProvider,
  type SandboxProviderCapability,
  type SelectedSandboxRun,
} from '@cap/sandbox';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import {
  readConfiguredSandboxProviderFamily,
  type ConfiguredSandboxProviderFamily,
} from '../sandbox/sandbox-provider-family';
import { TerminalGateway } from './terminal.gateway';

export type ProviderTerminalStoryProvider = 'auto' | 'aio' | 'boxlite';

export interface ProviderTerminalStoryReadiness {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly requestedProvider: ProviderTerminalStoryProvider;
  readonly configuredProvider: ConfiguredSandboxProviderFamily;
  readonly providerId: string | null;
  readonly reason: string | null;
  readonly capabilities: readonly SandboxProviderCapability[];
}

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
    const requestedProvider = readRequestedProvider(rawProvider);
    const configuredProvider = readConfiguredSandboxProviderFamily();
    const capabilities = this.sandbox.getProviderCapabilities?.() ?? [];
    if (!storyEnabled()) {
      return {
        enabled: false,
        ready: false,
        requestedProvider,
        configuredProvider,
        providerId: null,
        reason: `${STORY_ENABLE_ENV}=1 is required to create provider-backed terminal stories`,
        capabilities,
      };
    }

    const providerReadiness = await this.validateProviderReadiness(
      requestedProvider,
      configuredProvider,
      capabilities,
    );
    return {
      enabled: true,
      ready: providerReadiness.ready,
      requestedProvider,
      configuredProvider,
      providerId: providerReadiness.providerId,
      reason: providerReadiness.reason,
      capabilities,
    };
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
      });
      selectedRun =
        (await selected.provider.getSelectedSandboxRun?.(sessionId)) ?? null;
      providerId = selectedRun?.providerId ?? providerId;

      if (!providerMatches(readiness.requestedProvider, providerId)) {
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

  private async validateProviderReadiness(
    requestedProvider: ProviderTerminalStoryProvider,
    configuredProvider: ConfiguredSandboxProviderFamily,
    capabilities: readonly SandboxProviderCapability[],
  ): Promise<{ ready: boolean; providerId: string | null; reason: string | null }> {
    if (configuredProvider === 'control-plane') {
      return {
        ready: false,
        providerId: null,
        reason: 'CAP_SANDBOX_PROVIDER=control-plane has no sandbox provider for terminal stories',
      };
    }
    if (!hasAllCapabilities(capabilities, REQUIRED_CAPABILITIES)) {
      return {
        ready: false,
        providerId: null,
        reason: `configured sandbox provider is missing required capabilities: ${missingCapabilities(
          capabilities,
          REQUIRED_CAPABILITIES,
        ).join(', ')}`,
      };
    }
    if (requestedProvider === 'aio') {
      if (configuredProvider === 'boxlite') {
        return {
          ready: false,
          providerId: null,
          reason: 'provider-backed terminal story requested aio, but CAP_SANDBOX_PROVIDER=boxlite is configured',
        };
      }
      return { ready: true, providerId: 'aio-local', reason: null };
    }
    if (requestedProvider === 'boxlite') {
      return this.validateBoxLiteReadiness(configuredProvider);
    }
    if (configuredProvider === 'boxlite') {
      return this.validateBoxLiteReadiness(configuredProvider);
    }
    return { ready: true, providerId: null, reason: null };
  }

  private async validateBoxLiteReadiness(
    configuredProvider: ConfiguredSandboxProviderFamily,
  ): Promise<{ ready: boolean; providerId: string | null; reason: string | null }> {
    if (configuredProvider !== 'boxlite') {
      return {
        ready: false,
        providerId: null,
        reason: 'BoxLite provider-backed terminal story requires CAP_SANDBOX_PROVIDER=boxlite so setup cannot fall back to AIO',
      };
    }
    const config = readBoxLiteProviderConfig();
    if (config.status === 'disabled') {
      return { ready: false, providerId: null, reason: config.reason };
    }
    if (config.status === 'invalid') {
      return {
        ready: false,
        providerId: null,
        reason: `BoxLite config is invalid: ${config.errors.join('; ')}`,
      };
    }
    const missing = missingCapabilities(config.config.capabilities, [
      'terminal.websocket',
      'terminal.interactive',
    ]);
    if (missing.length > 0) {
      return {
        ready: false,
        providerId: config.config.providerId,
        reason: `BoxLite interactive terminal capability is required: missing ${missing.join(', ')}`,
      };
    }
    if (config.config.terminalMode !== 'pty') {
      return {
        ready: false,
        providerId: config.config.providerId,
        reason: 'BOXLITE_TERMINAL_MODE=pty is required for provider-backed terminal stories',
      };
    }
    const endpoint = await probeBoxLiteEndpoint(config.config.apiToken);
    if (!endpoint.ready) {
      return {
        ready: false,
        providerId: config.config.providerId,
        reason: endpoint.reason,
      };
    }
    return { ready: true, providerId: config.config.providerId, reason: null };
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

  private async deleteBackingRepo(repoId: string): Promise<void> {
    await this.prisma.repo.deleteMany({ where: { id: repoId } });
  }
}

function storyEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[STORY_ENABLE_ENV] ?? '');
}

function readRequestedProvider(raw?: string): ProviderTerminalStoryProvider {
  const value = (raw ?? process.env[STORY_PROVIDER_ENV] ?? 'auto').trim();
  if (value === 'aio' || value === 'boxlite' || value === 'auto') return value;
  throw new PreconditionFailedException(
    `invalid provider-backed terminal story provider: ${value}`,
  );
}

function normalizeTtl(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return STORY_DEFAULT_TTL_MS;
  return Math.min(STORY_MAX_TTL_MS, Math.max(STORY_MIN_TTL_MS, Math.trunc(raw)));
}

function hasAllCapabilities(
  capabilities: readonly SandboxProviderCapability[],
  required: readonly SandboxProviderCapability[],
): boolean {
  return missingCapabilities(capabilities, required).length === 0;
}

function missingCapabilities(
  capabilities: readonly SandboxProviderCapability[],
  required: readonly SandboxProviderCapability[],
): SandboxProviderCapability[] {
  return required.filter((capability) => !capabilities.includes(capability));
}

function providerMatches(
  requested: ProviderTerminalStoryProvider,
  providerId: string,
): boolean {
  if (requested === 'auto') return true;
  const normalized = providerId.toLowerCase();
  return requested === 'aio'
    ? normalized.includes('aio')
    : normalized.includes('boxlite');
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

async function probeBoxLiteEndpoint(
  apiToken: string,
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const endpoint = (
    process.env.BOXLITE_READINESS_ENDPOINT ??
    process.env.BOXLITE_ENDPOINT ??
    ''
  ).replace(/\/+$/, '');
  const healthPath = process.env.BOXLITE_HEALTH_PATH ?? '/health';
  const path = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  if (!endpoint) return { ready: false, reason: 'BOXLITE_ENDPOINT is not set' };
  const url = `${endpoint}${path}`;
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiToken}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return { ready: true };
    if (response.status === 401 || response.status === 403) {
      return {
        ready: false,
        reason: `BoxLite readiness failed with HTTP ${response.status}; check BOXLITE_API_TOKEN`,
      };
    }
    return {
      ready: false,
      reason: `BoxLite readiness failed with HTTP ${response.status} at ${url}`,
    };
  } catch (err) {
    return {
      ready: false,
      reason: `BoxLite endpoint is not reachable at ${url}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
