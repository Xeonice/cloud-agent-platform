import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PreconditionFailedException,
  type OnApplicationShutdown,
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
import type {
  ProviderTerminalStoryGatewayResourceState,
  ProviderTerminalStoryTelemetryEvent,
} from './terminal.gateway';

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
  readonly cleanupEvidence?: ProviderTerminalStoryCleanupEvidence;
}

export interface ProviderTerminalStoryCleanupEvidence {
  readonly gatewayOwnerReleased: boolean;
  readonly gatewayViewersReleased: boolean;
  readonly providerAbsent: boolean;
  readonly backingRepoRemoved: boolean;
  readonly telemetryObserverReleased: boolean;
}

export interface ProviderTerminalStoryInventoryEntry {
  readonly sequence: number;
  readonly event: ProviderTerminalStoryTelemetryEvent;
}

export interface ProviderTerminalStoryInventoryView {
  readonly sessionId: string;
  readonly events: readonly ProviderTerminalStoryInventoryEntry[];
  readonly truncated: boolean;
  readonly gateway: ProviderTerminalStoryGatewayResourceState;
}

export interface CreateProviderTerminalStorySessionInput {
  readonly provider?: string;
  readonly ttlMs?: number;
}

interface ProviderTerminalStorySessionRecord extends ProviderTerminalStorySessionView {
  readonly backingRepoId: string;
  readonly timer?: NodeJS.Timeout;
  readonly inventory: ProviderTerminalStoryMutableInventory;
  readonly telemetrySubscription?: { dispose(): void };
}

interface ProviderTerminalStoryMutableInventory {
  readonly events: ProviderTerminalStoryInventoryEntry[];
  nextSequence: number;
  truncated: boolean;
}

interface ProviderTerminalStorySetupLifecycle {
  readonly sessionId: string;
  readonly provider: SandboxProvider;
  readonly abortController: AbortController;
  readonly settled: Promise<void>;
  readonly settle: () => void;
  backingRepoId: string | null;
  telemetrySubscription?: { dispose(): void };
}

const STORY_ENABLE_ENV = 'CAP_PROVIDER_TERMINAL_STORY';
const STORY_PROVIDER_ENV = 'CAP_PROVIDER_TERMINAL_STORY_PROVIDER';
const STORY_DEFAULT_TTL_MS = 10 * 60_000;
const STORY_MIN_TTL_MS = 10_000;
const STORY_MAX_TTL_MS = 30 * 60_000;
const STORY_REPO_GIT_SOURCE = 'provider-terminal-story://local-fixture';
const STORY_MAX_INVENTORY_EVENTS = 4_096;
const STORY_SHUTDOWN_CLEANUP_ATTEMPTS = 3;
const STORY_SHUTDOWN_CLEANUP_RETRY_MS = 50;
const REQUIRED_CAPABILITIES: readonly SandboxProviderCapability[] = [
  'terminal.websocket',
] as const;

@Injectable()
export class ProviderTerminalStoryService implements OnApplicationShutdown {
  private readonly logger = new Logger(ProviderTerminalStoryService.name);
  private readonly sessions = new Map<string, ProviderTerminalStorySessionRecord>();
  private readonly teardownPromises = new Map<
    string,
    Promise<ProviderTerminalStorySessionView>
  >();
  private readonly inFlightCreates = new Map<
    string,
    ProviderTerminalStorySetupLifecycle
  >();
  private readonly failedSetupCleanups = new Map<
    string,
    ProviderTerminalStorySetupLifecycle
  >();
  private readonly setupCleanupPromises = new Map<
    string,
    Promise<ProviderTerminalStoryCleanupEvidence>
  >();
  private acceptingCreates = true;
  private cleanupAllPromise?: Promise<void>;

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
    cancellationSignal?: AbortSignal,
  ): Promise<ProviderTerminalStorySessionView> {
    this.assertAcceptingCreates();
    assertStoryRequestActive(cancellationSignal);
    const readiness = await this.readiness(input.provider);
    this.assertAcceptingCreates();
    assertStoryRequestActive(cancellationSignal);
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
    const inventory: ProviderTerminalStoryMutableInventory = {
      events: [],
      nextSequence: 1,
      truncated: false,
    };
    let settleSetup!: () => void;
    const setupSettled = new Promise<void>((resolve) => {
      settleSetup = resolve;
    });
    const setupAbortController = new AbortController();
    const detachRequestCancellation = linkAbortSignal(
      cancellationSignal,
      setupAbortController,
    );
    const lifecycle: ProviderTerminalStorySetupLifecycle = {
      sessionId,
      provider: selected.provider,
      abortController: setupAbortController,
      settled: setupSettled,
      settle: settleSetup,
      backingRepoId: null,
    };

    // Register before the first durable allocation. Shutdown closes admission,
    // aborts this signal, then awaits `settled` before exact cleanup, so setup
    // cannot allocate a late owner/provider resource after a cleanup snapshot.
    this.inFlightCreates.set(sessionId, lifecycle);

    try {
      const backingRepoId = await this.createBackingTask(sessionId);
      lifecycle.backingRepoId = backingRepoId;
      assertStoryRequestActive(setupAbortController.signal);
      const connection = await selected.provider.provision({
        taskId: sessionId,
        cloneSpec: null,
        modelIntent: { kind: 'runtime-default' },
        runtimeId: 'codex',
        executionMode: 'interactive-pty',
        cancellationSignal: setupAbortController.signal,
      });
      assertStoryRequestActive(setupAbortController.signal);
      selectedRun =
        (await selected.provider.getSelectedSandboxRun?.(sessionId)) ?? null;
      assertStoryRequestActive(setupAbortController.signal);
      providerId = selectedRun?.providerId ?? providerId;

      if (
        !providerMatchesSandboxTerminalStoryRequest(
          readiness.requestedProvider,
          providerId,
        )
      ) {
        throw new PreconditionFailedException(
          `provider-backed terminal story requested ${readiness.requestedProvider}, but selected provider was ${providerId}; refusing fallback`,
        );
      }

      lifecycle.telemetrySubscription =
        this.gateway.observeProviderTerminalStory(sessionId, {
          onEvent: (event) => appendInventoryEvent(inventory, event),
        });
      this.gateway.openSession(connection, selectedRun, {
        mode: 'provider-story-fixture',
        recordExit: false,
      });
      assertStoryRequestActive(setupAbortController.signal);

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
        inventory,
        telemetrySubscription: lifecycle.telemetrySubscription,
      };
      this.sessions.set(sessionId, record);
      return publicSessionView(record);
    } catch (err) {
      const cleanupConfirmed = await this.cleanupSetupWithRetries(
        lifecycle,
        STORY_SHUTDOWN_CLEANUP_ATTEMPTS,
      );
      if (!cleanupConfirmed) {
        // Keep the exact selected provider/task/repo identity reachable. A later
        // shutdown retry must never infer absence from this failed setup call.
        this.failedSetupCleanups.set(sessionId, lifecycle);
        throw new Error(
          'provider terminal story setup failed and exact cleanup was incomplete',
        );
      }
      this.failedSetupCleanups.delete(sessionId);
      throw err;
    } finally {
      detachRequestCancellation();
      this.inFlightCreates.delete(sessionId);
      lifecycle.settle();
    }
  }

  getSession(sessionId: string): ProviderTerminalStorySessionView {
    const record = this.sessions.get(sessionId);
    if (!record) throw new NotFoundException('provider terminal story session not found');
    return publicSessionView(record);
  }

  getInventory(sessionId: string): ProviderTerminalStoryInventoryView {
    const record = this.sessions.get(sessionId);
    if (!record) throw new NotFoundException('provider terminal story session not found');
    return {
      sessionId,
      events: record.inventory.events.map((entry) => ({
        sequence: entry.sequence,
        event: { ...entry.event },
      })),
      truncated: record.inventory.truncated,
      gateway: this.gateway.getProviderTerminalStoryResourceState(sessionId),
    };
  }

  async teardownSession(sessionId: string): Promise<ProviderTerminalStorySessionView> {
    const record = this.sessions.get(sessionId);
    if (!record) throw new NotFoundException('provider terminal story session not found');
    if (record.status === 'torn_down' && !record.teardownError) {
      return publicSessionView(record);
    }
    const inFlight = this.teardownPromises.get(sessionId);
    if (inFlight) return inFlight;

    const teardown = this.performTeardown(record).finally(() => {
      this.teardownPromises.delete(sessionId);
    });
    this.teardownPromises.set(sessionId, teardown);
    return teardown;
  }

  private async performTeardown(
    record: ProviderTerminalStorySessionRecord,
  ): Promise<ProviderTerminalStorySessionView> {
    const { sessionId } = record;
    if (record.timer) clearTimeout(record.timer);
    const tearingDown: ProviderTerminalStorySessionRecord = {
      ...record,
      status: 'tearing_down',
      timer: undefined,
    };
    this.sessions.set(sessionId, tearingDown);
    const teardownErrors: string[] = [];
    let gatewayCleanupCallSucceeded = true;
    try {
      this.gateway.unregisterSession(sessionId);
    } catch {
      gatewayCleanupCallSucceeded = false;
    }
    let gatewayResources: ProviderTerminalStoryGatewayResourceState = {
      ownerRegistered: true,
      activeViewerCount: 1,
    };
    let gatewayStateObserved = true;
    try {
      gatewayResources =
        this.gateway.getProviderTerminalStoryResourceState(sessionId);
    } catch {
      gatewayStateObserved = false;
    }
    const gatewayOwnerReleased =
      gatewayCleanupCallSucceeded &&
      gatewayStateObserved &&
      !gatewayResources.ownerRegistered;
    const gatewayViewersReleased =
      gatewayCleanupCallSucceeded &&
      gatewayStateObserved &&
      gatewayResources.activeViewerCount === 0;
    if (!gatewayOwnerReleased || !gatewayViewersReleased) {
      teardownErrors.push('gateway cleanup failed');
    }
    let telemetryObserverReleased = record.telemetrySubscription === undefined;
    if (record.telemetrySubscription) {
      try {
        record.telemetrySubscription.dispose();
        telemetryObserverReleased = true;
      } catch {
        teardownErrors.push('telemetry cleanup failed');
      }
    }
    let providerAbsent = false;
    let providerCleanupFailed = false;
    try {
      await this.sandbox.teardownSandbox(sessionId);
    } catch {
      providerCleanupFailed = true;
    }
    try {
      providerAbsent = !(await this.sandbox.sandboxExists(sessionId));
    } catch {
      providerAbsent = false;
    }
    if (providerCleanupFailed || !providerAbsent) {
      teardownErrors.push('provider cleanup failed');
    }
    let backingRepoRemoved = false;
    try {
      await this.deleteBackingRepo(record.backingRepoId);
      backingRepoRemoved = true;
    } catch {
      teardownErrors.push('backing repo cleanup failed');
    }
    const teardownError = teardownErrors.join('; ') || undefined;
    const done: ProviderTerminalStorySessionRecord = {
      sessionId,
      status: 'torn_down',
      providerId: tearingDown.providerId,
      requestedProvider: tearingDown.requestedProvider,
      createdAt: tearingDown.createdAt,
      expiresAt: tearingDown.expiresAt,
      terminalPath: '/terminal',
      backingRepoId: tearingDown.backingRepoId,
      inventory: tearingDown.inventory,
      cleanupEvidence: {
        gatewayOwnerReleased,
        gatewayViewersReleased,
        providerAbsent,
        backingRepoRemoved,
        telemetryObserverReleased,
      },
      ...(telemetryObserverReleased
        ? {}
        : { telemetrySubscription: record.telemetrySubscription }),
      ...(teardownError ? { teardownError } : {}),
    };
    this.sessions.set(sessionId, done);
    return publicSessionView(done);
  }

  private async cleanupSetupWithRetries(
    lifecycle: ProviderTerminalStorySetupLifecycle,
    attempts: number,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const evidence = await this.cleanupSetupOnce(lifecycle);
      if (cleanupEvidenceConfirmed(evidence)) {
        this.failedSetupCleanups.delete(lifecycle.sessionId);
        return true;
      }
      if (attempt < attempts) {
        await delayStoryCleanupRetry();
      }
    }
    return false;
  }

  private async cleanupSetupOnce(
    lifecycle: ProviderTerminalStorySetupLifecycle,
  ): Promise<ProviderTerminalStoryCleanupEvidence> {
    const inFlight = this.setupCleanupPromises.get(lifecycle.sessionId);
    if (inFlight) return inFlight;

    const cleanup = this.performSetupCleanup(lifecycle);
    this.setupCleanupPromises.set(lifecycle.sessionId, cleanup);
    try {
      return await cleanup;
    } finally {
      if (this.setupCleanupPromises.get(lifecycle.sessionId) === cleanup) {
        this.setupCleanupPromises.delete(lifecycle.sessionId);
      }
    }
  }

  private async performSetupCleanup(
    lifecycle: ProviderTerminalStorySetupLifecycle,
  ): Promise<ProviderTerminalStoryCleanupEvidence> {
    const { sessionId } = lifecycle;
    try {
      this.gateway.unregisterSession(sessionId);
    } catch {
      // The exact state probe below is authoritative. Some owners throw after
      // already releasing their resource, which must not turn proven absence
      // into a permanent, non-retryable setup record.
    }

    let gatewayResources: ProviderTerminalStoryGatewayResourceState = {
      ownerRegistered: true,
      activeViewerCount: 1,
    };
    let gatewayStateObserved = true;
    try {
      gatewayResources =
        this.gateway.getProviderTerminalStoryResourceState(sessionId);
    } catch {
      gatewayStateObserved = false;
    }
    const gatewayOwnerReleased =
      gatewayStateObserved && !gatewayResources.ownerRegistered;
    const gatewayViewersReleased =
      gatewayStateObserved && gatewayResources.activeViewerCount === 0;

    let telemetryObserverReleased =
      lifecycle.telemetrySubscription === undefined;
    if (lifecycle.telemetrySubscription) {
      try {
        lifecycle.telemetrySubscription.dispose();
        lifecycle.telemetrySubscription = undefined;
        telemetryObserverReleased = true;
      } catch {
        telemetryObserverReleased = false;
      }
    }

    try {
      await lifecycle.provider.teardownSandbox(sessionId);
    } catch {
      // `sandboxExists` is the exact absence proof. A teardown transport may
      // fail after the provider has already removed the selected task resource.
    }
    let providerAbsent = false;
    try {
      providerAbsent = !(await lifecycle.provider.sandboxExists(sessionId));
    } catch {
      providerAbsent = false;
    }

    let backingRepoRemoved = lifecycle.backingRepoId === null;
    if (lifecycle.backingRepoId) {
      try {
        await this.deleteBackingRepo(lifecycle.backingRepoId);
        lifecycle.backingRepoId = null;
        backingRepoRemoved = true;
      } catch {
        backingRepoRemoved = false;
      }
    }

    return {
      gatewayOwnerReleased,
      gatewayViewersReleased,
      providerAbsent,
      backingRepoRemoved,
      telemetryObserverReleased,
    };
  }

  async cleanupAll(): Promise<void> {
    const inFlight = this.cleanupAllPromise;
    if (inFlight) return inFlight;

    const cleanup = this.drainAndCleanupAll();
    this.cleanupAllPromise = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.cleanupAllPromise === cleanup) this.cleanupAllPromise = undefined;
    }
  }

  private async drainAndCleanupAll(): Promise<void> {
    // Closing admission happens before the first await. Every already-admitted
    // create owns a registered lifecycle, so this snapshot is complete.
    this.acceptingCreates = false;
    const creating = [...this.inFlightCreates.values()];
    for (const lifecycle of creating) lifecycle.abortController.abort();
    await Promise.allSettled(creating.map((lifecycle) => lifecycle.settled));

    let pending = new Set<string>();
    for (const [sessionId, session] of this.sessions) {
      if (!storyCleanupConfirmed(publicSessionView(session))) pending.add(sessionId);
    }
    for (const sessionId of this.failedSetupCleanups.keys()) pending.add(sessionId);

    for (
      let attempt = 1;
      attempt <= STORY_SHUTDOWN_CLEANUP_ATTEMPTS && pending.size > 0;
      attempt += 1
    ) {
      const outcomes = await Promise.all(
        [...pending].map(async (sessionId) => {
          const session = this.sessions.get(sessionId);
          if (session) {
            try {
              const result = await this.teardownSession(sessionId);
              return storyCleanupConfirmed(result) ? null : sessionId;
            } catch {
              return sessionId;
            }
          }

          const lifecycle = this.failedSetupCleanups.get(sessionId);
          if (!lifecycle) return null;
          const evidence = await this.cleanupSetupOnce(lifecycle);
          if (!cleanupEvidenceConfirmed(evidence)) return sessionId;
          this.failedSetupCleanups.delete(sessionId);
          return null;
        }),
      );
      pending = new Set(
        outcomes.filter((sessionId): sessionId is string => sessionId !== null),
      );
      if (pending.size > 0 && attempt < STORY_SHUTDOWN_CLEANUP_ATTEMPTS) {
        await delayStoryCleanupRetry();
      }
    }
    if (pending.size > 0) {
      throw new Error(
        `provider terminal story cleanup remained incomplete for ${pending.size} session(s)`,
      );
    }
  }

  async onApplicationShutdown(_signal?: string): Promise<void> {
    await this.cleanupAll();
  }

  private assertAcceptingCreates(): void {
    if (!this.acceptingCreates) {
      throw new PreconditionFailedException(
        'provider terminal story service is shutting down',
      );
    }
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

function storyCleanupConfirmed(
  session: ProviderTerminalStorySessionView,
): boolean {
  const evidence = session.cleanupEvidence;
  return (
    session.status === 'torn_down' &&
    session.teardownError === undefined &&
    evidence !== undefined &&
    cleanupEvidenceConfirmed(evidence)
  );
}

function cleanupEvidenceConfirmed(
  evidence: ProviderTerminalStoryCleanupEvidence,
): boolean {
  return (
    evidence.gatewayOwnerReleased &&
    evidence.gatewayViewersReleased &&
    evidence.providerAbsent &&
    evidence.backingRepoRemoved &&
    evidence.telemetryObserverReleased
  );
}

function storyEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[STORY_ENABLE_ENV] ?? '');
}

function assertStoryRequestActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('provider terminal story request cancelled');
  }
}

function linkAbortSignal(
  source: AbortSignal | undefined,
  target: AbortController,
): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort();
  if (source.aborted) {
    target.abort();
    return () => undefined;
  }
  source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function delayStoryCleanupRetry(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, STORY_SHUTDOWN_CLEANUP_RETRY_MS),
  );
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
    ...(record.cleanupEvidence
      ? { cleanupEvidence: { ...record.cleanupEvidence } }
      : {}),
    ...(record.teardownError ? { teardownError: record.teardownError } : {}),
  };
}

function appendInventoryEvent(
  inventory: ProviderTerminalStoryMutableInventory,
  event: ProviderTerminalStoryTelemetryEvent,
): void {
  if (inventory.events.length >= STORY_MAX_INVENTORY_EVENTS) {
    inventory.truncated = true;
    return;
  }
  inventory.events.push({
    sequence: inventory.nextSequence++,
    event: { ...event },
  });
}
