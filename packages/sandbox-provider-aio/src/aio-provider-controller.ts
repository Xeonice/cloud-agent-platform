import type {
  SandboxConnection,
  SandboxCreateObservation,
  SandboxExternalBoundaryGuard,
  SandboxInventoryReconcileInput,
  SandboxInventoryReconcileResult,
  SandboxOwnershipFence,
  SandboxReadoptionTarget,
  SandboxResolvedEnvironmentMetadata,
  SandboxTeardownResult,
} from '@cap/sandbox-core';
import { Readable } from 'node:stream';
import {
  normalizeSandboxCommandResult,
  runSandboxExternalBoundary,
  SandboxProvisioningStageError,
  scrubSandboxCommandOutput,
} from '@cap/sandbox-core';
import {
  AIO_SANDBOX_CONTAINER_PREFIX,
  AIO_SANDBOX_RESOURCE_GENERATION_LABEL,
  AIO_SANDBOX_SESSION_PROBE_TIMEOUT_MS,
  AIO_SANDBOX_TRIM_TIMEOUT_MS,
  buildAioLocalSandboxProvisionSpec,
  buildAioSandboxBaseUrl,
  buildAioSandboxConnection,
  buildAioSandboxContainerName,
  parseAioTaskIdFromContainerNames,
  type AioLocalSandboxContainerConfig,
  type AioLocalSandboxEnv,
  type AioLocalSandboxProvisionSpec,
} from './aio-local-provider.js';
import { extractFilesFromTar } from './tar-extract.js';

export type AioFetch = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface AioDockerContainer {
  readonly id?: string;
  start(options?: { readonly abortSignal?: AbortSignal }): Promise<void>;
  stop(options?: { readonly t?: number }): Promise<void>;
  remove(options?: { readonly force?: boolean }): Promise<void>;
  inspect(): Promise<unknown>;
  getArchive(options: { readonly path: string }): Promise<NodeJS.ReadableStream>;
  putArchive(
    archive: NodeJS.ReadableStream,
    options: { readonly path: string },
  ): Promise<unknown>;
}

export interface AioDockerContainerInfo {
  readonly Id: string;
  readonly Names?: readonly string[];
}

export interface AioDockerImageInspect {
  readonly Id?: string;
  readonly RepoDigests?: readonly string[];
}

export interface AioDockerImage {
  inspect(): Promise<AioDockerImageInspect>;
}

export interface AioDockerClient<TContainer extends AioDockerContainer = AioDockerContainer> {
  createContainer(
    options: AioLocalSandboxContainerConfig & {
      readonly abortSignal?: AbortSignal;
    },
  ): Promise<TContainer>;
  getContainer(idOrName: string): TContainer;
  getImage(reference: string): AioDockerImage;
  listContainers(options: {
    readonly all: false;
    readonly filters: {
      readonly name: readonly string[];
      readonly status: readonly string[];
    };
  }): Promise<readonly AioDockerContainerInfo[]>;
}

export interface AioProviderControllerLogger {
  debug?(message: string): void;
  log?(message: string): void;
  warn?(message: string): void;
}

export interface AioSandboxExecResult {
  readonly exitCode: number;
  readonly output: string;
}

export interface AioSandboxContainerControllerOptions<
  TContainer extends AioDockerContainer = AioDockerContainer,
> {
  readonly docker: AioDockerClient<TContainer>;
  readonly fetch?: AioFetch;
  readonly env?: AioLocalSandboxEnv;
  readonly logger?: AioProviderControllerLogger;
  readonly delay?: (ms: number) => Promise<void>;
}

export interface AioProvisionedContainer<TContainer extends AioDockerContainer> {
  readonly spec: AioLocalSandboxProvisionSpec;
  readonly container: TContainer;
  readonly connection: SandboxConnection;
  readonly providerSandboxId: string;
}

interface AioRunningSandboxInventoryItem {
  readonly taskId: string;
  readonly providerSandboxId: string;
}

export interface AioTeardownHooks {
  /** Exact physical sandbox incarnation authorized by the durable owner CAS. */
  readonly ownership?: SandboxOwnershipFence;
  /** Immutable Docker container id persisted with the selected run. */
  readonly providerSandboxId?: string;
  beforeStop?(args: {
    readonly taskId: string;
    readonly baseUrl: string;
  }): Promise<void>;
}

export class AioSandboxContainerController<
  TContainer extends AioDockerContainer = AioDockerContainer,
> {
  private readonly docker: AioDockerClient<TContainer>;
  private readonly fetchImpl: AioFetch;
  private readonly env?: AioLocalSandboxEnv;
  private readonly logger?: AioProviderControllerLogger;
  private readonly delayImpl: (ms: number) => Promise<void>;
  private readonly containers = new Map<string, TContainer>();
  private readonly connections = new Map<string, SandboxConnection>();
  private readonly readopted = new Set<string>();
  private readonly providerSandboxIds = new Map<string, string>();
  private readoptScan?: Promise<void>;

  constructor(options: AioSandboxContainerControllerOptions<TContainer>) {
    this.docker = options.docker;
    this.fetchImpl =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init) as ReturnType<AioFetch>);
    this.env = options.env;
    this.logger = options.logger;
    this.delayImpl =
      options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getConnection(taskId: string): SandboxConnection | undefined {
    return this.connections.get(taskId);
  }

  getProviderSandboxId(taskId: string): string | undefined {
    return this.providerSandboxIds.get(taskId);
  }

  resolveBaseUrl(taskId: string): string {
    return this.connections.get(taskId)?.baseUrl ?? buildAioSandboxBaseUrl(taskId);
  }

  /** Resolve a mutable Docker reference before create into a consumable identity. */
  async resolveImageIdentity(reference: string): Promise<{
    readonly locator: string;
    readonly digest: string;
  }> {
    const inspected = await this.docker.getImage(reference).inspect();
    const repoDigest = [...(inspected.RepoDigests ?? [])]
      .filter((candidate) => candidate.includes('@sha256:'))
      .sort()[0];
    if (repoDigest) {
      return {
        locator: repoDigest,
        digest: repoDigest.slice(repoDigest.indexOf('@') + 1),
      };
    }
    const imageId = inspected.Id?.trim();
    if (imageId?.startsWith('sha256:')) {
      return { locator: imageId, digest: imageId };
    }
    throw new Error('AIO image has no provider-consumable immutable identity.');
  }

  async createAndStart(
    taskId: string,
    environment?: SandboxResolvedEnvironmentMetadata | null,
    labels?: Readonly<Record<string, string>>,
    options: {
      readonly signal?: AbortSignal;
      readonly ownership?: SandboxOwnershipFence;
      readonly externalBoundaryGuard?: SandboxExternalBoundaryGuard;
      readonly onSandboxCreateObserved?: (
        observation: SandboxCreateObservation,
      ) => Promise<void>;
    } = {},
  ): Promise<AioProvisionedContainer<TContainer>> {
    const resourceGeneration = aioResourceGeneration(options.ownership);
    const spec = buildAioLocalSandboxProvisionSpec({
      taskId,
      env: this.env,
      environment,
      labels:
        resourceGeneration === undefined
          ? labels
          : {
              ...labels,
              [AIO_SANDBOX_RESOURCE_GENERATION_LABEL]: resourceGeneration,
            },
    });
    assertAioProvisionSignal(options.signal);
    const existing = await this.adoptExistingContainer(
      spec,
      options.signal,
      resourceGeneration,
      options.externalBoundaryGuard,
      options.onSandboxCreateObserved,
    );
    if (existing) return existing;

    const created = await runSandboxExternalBoundary({
      taskId,
      action: 'sandbox.create',
      guard: options.externalBoundaryGuard,
      signal: options.signal,
      run: async () => {
        const result = await settleAioExternalAction(() =>
          this.docker.createContainer({
            ...spec.containerConfig,
            abortSignal: options.signal,
          }),
        );
        if (result.ok) {
          await options.onSandboxCreateObserved?.({
            kind: 'created',
            providerSandboxId: requireCreatedContainerId(result.value),
          });
        } else if (isDefinitiveAioCreateWithoutResource(result.error)) {
          await options.onSandboxCreateObserved?.({ kind: 'not-created' });
        }
        return result;
      },
    });
    if (!created.ok) {
      const { error } = created;
      // Two replicas can both confirm 404 before the deterministic-name create.
      // Only a confirmed Docker name conflict may enter the readopt path; every
      // other control-plane error remains indeterminate and fails closed.
      if (isDockerContainerNameConflict(error, spec.containerName)) {
        const raced = await this.adoptExistingContainer(
          spec,
          options.signal,
          resourceGeneration,
          options.externalBoundaryGuard,
          options.onSandboxCreateObserved,
        );
        if (raced) return raced;
      }
      throw error;
    }
    const container = created.value;
    const providerSandboxId = requireCreatedContainerId(container);
    this.containers.set(taskId, container);
    this.providerSandboxIds.set(taskId, providerSandboxId);
    let started: SettledAioExternalAction<void>;
    try {
      started = await runSandboxExternalBoundary({
        taskId,
        action: 'sandbox.start',
        guard: options.externalBoundaryGuard,
        signal: options.signal,
        run: () =>
          settleAioExternalAction(() =>
            container.start({ abortSignal: options.signal }),
          ),
      });
    } catch (error) {
      this.containers.delete(taskId);
      this.providerSandboxIds.delete(taskId);
      throw error;
    }
    if (!started.ok) {
      this.containers.delete(taskId);
      this.providerSandboxIds.delete(taskId);
      if (!options.ownership && !options.externalBoundaryGuard) {
        await container.remove({ force: true }).catch(() => undefined);
      }
      throw started.error;
    }
    this.logger?.debug?.(`provisioned AIO container ${spec.containerName} from ${spec.image}`);
    return {
      spec,
      container,
      connection: spec.connection,
      providerSandboxId,
    };
  }

  private async adoptExistingContainer(
    spec: AioLocalSandboxProvisionSpec,
    signal?: AbortSignal,
    resourceGeneration?: string,
    externalBoundaryGuard?: SandboxExternalBoundaryGuard,
    onSandboxCreateObserved?: (
      observation: SandboxCreateObservation,
    ) => Promise<void>,
  ): Promise<AioProvisionedContainer<TContainer> | null> {
    assertAioProvisionSignal(signal);
    const container = this.docker.getContainer(spec.containerName);
    const inspection = await runSandboxExternalBoundary({
      taskId: spec.taskId,
      action: 'sandbox.inspect',
      guard: externalBoundaryGuard,
      signal,
      run: async () => {
        const result = await settleAioExternalAction(() => container.inspect());
        if (result.ok) {
          assertExistingContainerMatchesProvision(
            spec,
            result.value,
            resourceGeneration,
          );
          await onSandboxCreateObserved?.({
            kind: 'created',
            providerSandboxId: requireInspectedContainerId(result.value),
          });
        }
        return result;
      },
    });
    if (!inspection.ok) {
      if (isDockerNotFound(inspection.error)) return null;
      throw inspection.error;
    }
    const inspected = inspection.value;
    const providerSandboxId = requireInspectedContainerId(inspected);
    this.containers.set(spec.taskId, container);
    this.providerSandboxIds.set(spec.taskId, providerSandboxId);
    if (!isInspectedContainerRunning(inspected)) {
      if (externalBoundaryGuard) {
        const started = await runSandboxExternalBoundary({
          taskId: spec.taskId,
          action: 'sandbox.start',
          guard: externalBoundaryGuard,
          signal,
          run: () =>
            settleAioExternalAction(() =>
              container.start({ abortSignal: signal }),
            ),
        });
        if (!started.ok) {
          const confirmed = await runSandboxExternalBoundary({
            taskId: spec.taskId,
            action: 'sandbox.inspect',
            guard: externalBoundaryGuard,
            signal,
            run: () => container.inspect(),
          });
          if (!isInspectedContainerRunning(confirmed)) throw started.error;
        }
        assertAioProvisionSignal(signal);
        return {
          spec,
          container,
          connection: spec.connection,
          providerSandboxId,
        };
      }
      try {
        await container.start({ abortSignal: signal });
      } catch (error) {
        // A concurrent owner may have started it after our inspect. Accept only
        // a fresh authoritative inspect that confirms Running=true.
        const confirmed = await container.inspect();
        if (!isInspectedContainerRunning(confirmed)) throw error;
      }
    }
    assertAioProvisionSignal(signal);
    return {
      spec,
      container,
      connection: spec.connection,
      providerSandboxId,
    };
  }

  registerConnection(connection: SandboxConnection): SandboxConnection {
    this.connections.set(connection.taskId, connection);
    return connection;
  }

  async waitForReadiness(args: {
    readonly baseUrl: string;
    readonly taskId: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly externalBoundaryGuard?: SandboxExternalBoundaryGuard;
  }): Promise<void> {
    const intervalMs = 250;
    const deadline = Date.now() + args.timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (args.signal?.aborted) {
        throw new Error(`AIO sandbox readiness was aborted for task ${args.taskId}`);
      }
      const attempt = await runSandboxExternalBoundary({
        taskId: args.taskId,
        action: 'sandbox.readiness',
        guard: args.externalBoundaryGuard,
        signal: args.signal,
        run: () =>
          settleAioExternalAction(() =>
            this.fetchImpl(`${args.baseUrl}/v1/docs`, {
              signal: args.signal,
            }),
          ),
      });
      if (attempt.ok) {
        const res = attempt.value;
        if (res.ok) return;
        lastError = new Error(`/v1/docs responded with status ${res.status}`);
      } else {
        lastError = attempt.error;
      }
      await this.delayImpl(intervalMs);
    }

    // Raw HTTP/network diagnostics stay provider-local. Admission needs only
    // the stable, provider-neutral active stage.
    void lastError;
    throw new SandboxProvisioningStageError('readiness');
  }

  async teardownSandbox(
    taskId: string,
    hooks: AioTeardownHooks = {},
  ): Promise<SandboxTeardownResult> {
    const connection = this.connections.get(taskId);
    const target = await this.inspectSandboxTarget(
      taskId,
      hooks.providerSandboxId,
      hooks.ownership,
    );
    if (!target) {
      this.clearTaskHandles(taskId);
      return { kind: 'already-absent' };
    }
    const inspected = target.inspected;
    const inspectedId = requireInspectedContainerId(inspected);
    // Pin every destructive operation to the immutable id returned by the
    // fresh inspection. A deterministic name may be rebound to a replacement.
    const container = this.docker.getContainer(inspectedId);
    this.clearTaskHandles(taskId);

    if (!isInspectedContainerRunning(inspected)) {
      return { kind: 'found-and-cleaned' };
    }
    const baseUrl = connection?.baseUrl ?? buildAioSandboxBaseUrl(taskId);
    await hooks.beforeStop?.({ taskId, baseUrl });
    await this.stopContainerAndConfirm(container, hooks.ownership);
    return { kind: 'found-and-cleaned' };
  }

  async removeSandbox(
    taskId: string,
    options: {
      readonly bestEffort?: boolean;
      readonly ownership?: SandboxOwnershipFence;
      readonly providerSandboxId?: string;
    } = {},
  ): Promise<void> {
    if (options.ownership || options.providerSandboxId) {
      await this.removeTargetContainerAndConfirm(taskId, options);
      return;
    }
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    this.clearTaskHandles(taskId);
    if (options.bestEffort === false) {
      await container.remove({ force: true });
      return;
    }
    await container.remove({ force: true }).catch(() => undefined);
  }

  /**
   * Non-command guest file transport used only by the redacted secret port.
   * The archive bytes are zeroed after Docker confirms transfer completion.
   */
  async putPrivateArchive(
    taskId: string,
    directory: string,
    archive: Uint8Array,
  ): Promise<void> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    const copy = Buffer.from(archive);
    try {
      await container.putArchive(Readable.from(copy), { path: directory });
    } finally {
      copy.fill(0);
    }
  }

  /** Force-stop every guest process and prove the sandbox is no longer retained. */
  async removeSandboxAndConfirm(
    taskId: string,
    ownership?: SandboxOwnershipFence,
    providerSandboxId?: string,
  ): Promise<SandboxTeardownResult> {
    if (ownership || providerSandboxId) {
      return this.removeTargetContainerAndConfirm(taskId, {
        ownership,
        providerSandboxId,
      });
    }
    try {
      if (await this.isSandboxConfirmedAbsent(taskId)) {
        this.clearTaskHandles(taskId);
        return { kind: 'already-absent' };
      }
    } catch {
      // Inspect transport uncertainty must not prevent a force-removal attempt.
    }
    try {
      await this.removeSandbox(taskId, { bestEffort: false });
    } catch {
      // A lost Docker remove response is ambiguous: the force-removal may have
      // completed. Always use the post-remove inspect as the final authority.
    }
    let confirmedAbsent = false;
    try {
      confirmedAbsent = await this.isSandboxConfirmedAbsent(taskId);
    } catch {
      // Only a confirmed Docker 404 may settle credential-bearing cleanup.
    }
    if (!confirmedAbsent) {
      throw new Error('AIO sandbox removal could not be confirmed');
    }
    return { kind: 'found-and-cleaned' };
  }

  private async stopContainerAndConfirm(
    container: TContainer,
    ownership?: SandboxOwnershipFence,
  ): Promise<void> {
    let stopError: unknown;
    try {
      await container.stop({ t: 0 });
    } catch (error) {
      stopError = error;
    }
    let inspected: unknown;
    try {
      inspected = await container.inspect();
    } catch (error) {
      if (isDockerNotFound(error)) return;
      throw stopError ?? error;
    }
    if (ownership) assertInspectedResourceGeneration(inspected, ownership);
    if (isInspectedContainerRunning(inspected)) {
      throw stopError ?? new Error('AIO sandbox stop could not be confirmed');
    }
  }

  private async removeTargetContainerAndConfirm(
    taskId: string,
    options: {
      readonly ownership?: SandboxOwnershipFence;
      readonly providerSandboxId?: string;
    },
  ): Promise<SandboxTeardownResult> {
    const target = await this.inspectSandboxTarget(
      taskId,
      options.providerSandboxId,
      options.ownership,
    );
    if (!target) {
      this.clearTaskHandles(taskId);
      return { kind: 'already-absent' };
    }
    const inspected = target.inspected;
    const inspectedId = requireInspectedContainerId(inspected);
    const container = this.docker.getContainer(inspectedId);
    try {
      await container.remove({ force: true });
    } catch {
      // A lost remove response is ambiguous; the pinned container id below is
      // the only authority for whether this exact incarnation still exists.
    }
    try {
      const remaining = await container.inspect();
      if (options.providerSandboxId !== undefined) {
        if (requireInspectedContainerId(remaining) !== inspectedId) {
          throw new Error(
            'AIO removal confirmation changed provider sandbox id',
          );
        }
        assertInspectedTaskId(remaining, taskId);
      }
      if (options.ownership) {
        assertInspectedResourceGeneration(remaining, options.ownership);
      }
    } catch (error) {
      if (isDockerNotFound(error)) {
        this.clearTaskHandles(taskId);
        return { kind: 'found-and-cleaned' };
      }
      throw error;
    }
    throw new Error('AIO sandbox removal could not be confirmed');
  }

  private async inspectSandboxTarget(
    taskId: string,
    providerSandboxId?: string,
    ownership?: SandboxOwnershipFence,
  ): Promise<{ readonly container: TContainer; readonly inspected: unknown } | null> {
    const deterministicName = buildAioSandboxContainerName(taskId);
    const cachedId = this.providerSandboxIds.get(taskId);
    const references = providerSandboxId
      ? ownership && providerSandboxId !== deterministicName
        ? [providerSandboxId, deterministicName]
        : [providerSandboxId]
      : cachedId && cachedId !== deterministicName
        ? [cachedId, deterministicName]
        : [deterministicName];
    for (const reference of references) {
      const container = this.docker.getContainer(reference);
      try {
        const inspected = await container.inspect();
        const inspectedId = requireInspectedContainerId(inspected);
        if (reference === providerSandboxId && inspectedId !== providerSandboxId) {
          throw new Error(
            'AIO cleanup provider sandbox id does not match persisted target',
          );
        }
        if (providerSandboxId !== undefined || ownership !== undefined) {
          assertInspectedTaskId(inspected, taskId);
        }
        if (ownership) assertInspectedResourceGeneration(inspected, ownership);
        return { container, inspected };
      } catch (error) {
        if (!isDockerNotFound(error)) throw error;
      }
    }
    return null;
  }

  private clearTaskHandles(taskId: string): void {
    this.containers.delete(taskId);
    this.connections.delete(taskId);
    this.readopted.delete(taskId);
    this.providerSandboxIds.delete(taskId);
  }

  async isSandboxConfirmedAbsent(taskId: string): Promise<boolean> {
    const container = this.docker.getContainer(
      buildAioSandboxContainerName(taskId),
    );
    try {
      await container.inspect();
      return false;
    } catch (error) {
      if (isDockerNotFound(error)) return true;
      throw error;
    }
  }

  async sandboxExists(taskId: string): Promise<boolean> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    try {
      await container.inspect();
      return true;
    } catch (error) {
      if (isDockerNotFound(error)) return false;
      throw error;
    }
  }

  async readSingleNewestJsonl(
    taskId: string,
    dir: string,
    filenameGlob: RegExp,
  ): Promise<string | null> {
    const container =
      this.containers.get(taskId) ??
      this.docker.getContainer(buildAioSandboxContainerName(taskId));
    let stream: NodeJS.ReadableStream;
    try {
      stream = await container.getArchive({ path: dir });
    } catch {
      return null;
    }
    let tar: Buffer;
    try {
      tar = await streamToBuffer(stream);
    } catch {
      return null;
    }
    const files = extractFilesFromTar(tar, (name) => filenameGlob.test(name));
    if (files.length === 0) return null;
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files[files.length - 1]!.content.toString('utf8');
  }

  async runSandboxExec(
    baseUrl: string,
    command: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AioSandboxExecResult> {
    const res = await this.fetchImpl(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
      signal: options.signal,
    });
    if (!res.ok) {
      return { exitCode: Number.NaN, output: `/v1/shell/exec responded ${res.status}` };
    }
    return parseAioExecResult(await res.json().catch(() => undefined));
  }

  async runShellExecBestEffort(args: {
    readonly baseUrl: string;
    readonly taskId: string;
    readonly command: string;
    readonly timeoutMs?: number;
    readonly label?: string;
  }): Promise<void> {
    const label = args.label ?? 'AIO shell exec';
    try {
      const res = await this.fetchImpl(`${args.baseUrl}/v1/shell/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: args.command }),
        signal: AbortSignal.timeout(args.timeoutMs ?? AIO_SANDBOX_TRIM_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger?.warn?.(
          `${label} for task ${args.taskId} returned HTTP ${res.status} (not fatal)`,
        );
      }
    } catch (err) {
      this.logger?.warn?.(
        `${label} for task ${args.taskId} failed (not fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async listReadoptable(): Promise<string[]> {
    await this.ensureReadoptionScan();
    return [...this.readopted];
  }

  async reconcileSandboxInventory(
    input: SandboxInventoryReconcileInput,
  ): Promise<SandboxInventoryReconcileResult> {
    if (typeof input?.canReap !== 'function') {
      throw new Error(
        'AIO sandbox inventory reconciliation requires a canReap authorization callback',
      );
    }
    const protectedTaskIds = new Set(input.protectedTaskIds);
    const inventory = await this.listRunningSandboxInventory();
    const inspected = inventory.length;
    const candidates = inventory.filter(
      (item) => !protectedTaskIds.has(item.taskId),
    );

    // Resolve every candidate's current state before the first destructive
    // action. One indeterminate Docker inspection therefore cannot cause a
    // different candidate to be reaped on the strength of a stale list result.
    const stillRunning = (
      await Promise.all(
        candidates.map(async (item) => {
          const container = this.docker.getContainer(item.providerSandboxId);
          let inspectedContainer: unknown;
          try {
            inspectedContainer = await container.inspect();
          } catch (error) {
            if (isDockerNotFound(error)) return null;
            throw error;
          }
          if (
            requireInspectedContainerId(inspectedContainer) !==
            item.providerSandboxId
          ) {
            throw new Error(
              'AIO inventory provider sandbox id changed before reconciliation',
            );
          }
          assertInspectedTaskId(inspectedContainer, item.taskId);
          return isInspectedContainerRunning(inspectedContainer)
            ? { item, container }
            : null;
        }),
      )
    ).filter(
      (
        candidate,
      ): candidate is {
        readonly item: AioRunningSandboxInventoryItem;
        readonly container: TContainer;
      } => candidate !== null,
    );

    // Batch-authorize only after every candidate received a fresh physical
    // inspection, and before the first destructive action. If any durable
    // ownership lookup fails, Promise.all rejects and no candidate is reaped.
    // This closes the stale protectedTaskIds snapshot race across replicas.
    const authorized = (
      await Promise.all(
        stillRunning.map(async (candidate) =>
          (await input.canReap(candidate.item)) === true ? candidate : null,
        ),
      )
    ).filter(
      (
        candidate,
      ): candidate is {
        readonly item: AioRunningSandboxInventoryItem;
        readonly container: TContainer;
      } => candidate !== null,
    );

    let reaped = 0;
    for (const { item, container } of authorized) {
      let removeError: unknown;
      try {
        await container.remove({ force: true });
      } catch (error) {
        removeError = error;
      }
      try {
        const remaining = await container.inspect();
        if (requireInspectedContainerId(remaining) !== item.providerSandboxId) {
          throw new Error(
            'AIO inventory provider sandbox id changed during reconciliation',
          );
        }
        assertInspectedTaskId(remaining, item.taskId);
        if (!isInspectedContainerRunning(remaining)) {
          // A concurrent terminal transition won the race. Preserve its
          // stopped container as retained history.
          continue;
        }
      } catch (error) {
        if (isDockerNotFound(error)) {
          this.clearTaskHandles(item.taskId);
          reaped += 1;
          continue;
        }
        throw removeError ?? error;
      }
      throw removeError ?? new Error('AIO orphan removal could not be confirmed');
    }

    if (reaped > 0) {
      this.logger?.log?.(
        `startup sandbox reconciliation: force-removed ${reaped} ` +
          `unprotected running ${AIO_SANDBOX_CONTAINER_PREFIX}* orphan(s) ` +
          `(protected durable work and stopped retained history spared)`,
      );
    }
    return { inspected, reaped };
  }

  async reattach(
    taskId: string,
    target?: SandboxReadoptionTarget,
  ): Promise<SandboxConnection | null> {
    if (!target && !this.readopted.has(taskId)) return null;
    const reference =
      target?.providerSandboxId ??
      this.providerSandboxIds.get(taskId) ??
      buildAioSandboxContainerName(taskId);
    let container = this.docker.getContainer(reference);
    let inspected: unknown;
    try {
      inspected = await container.inspect();
    } catch (error) {
      if (isDockerNotFound(error)) {
        this.clearTaskHandles(taskId);
        return null;
      }
      throw error;
    }
    const providerSandboxId = requireInspectedContainerId(inspected);
    if (
      target?.providerSandboxId !== undefined &&
      providerSandboxId !== target.providerSandboxId
    ) {
      throw new Error('AIO readoption provider sandbox id does not match persisted target');
    }
    assertInspectedTaskId(inspected, taskId);
    if (target?.ownership) {
      assertInspectedResourceGeneration(inspected, target.ownership);
    }
    if (!isInspectedContainerRunning(inspected)) return null;
    container = this.docker.getContainer(providerSandboxId);
    this.containers.set(taskId, container);
    this.providerSandboxIds.set(taskId, providerSandboxId);
    this.readopted.add(taskId);
    const connection = this.connections.get(taskId) ?? buildAioSandboxConnection(taskId);
    this.connections.set(taskId, connection);
    return connection;
  }

  releaseHandles(): void {
    this.containers.clear();
    this.connections.clear();
    this.readopted.clear();
    this.providerSandboxIds.clear();
    this.readoptScan = Promise.resolve();
  }

  private ensureReadoptionScan(): Promise<void> {
    return (this.readoptScan ??= this.scanForReadoption());
  }

  private async scanForReadoption(): Promise<void> {
    try {
      const running = await this.listRunningSandboxInventory();
      const liveness = await Promise.all(
        running.map(async (item) => ({
          item,
          state: await this.probeSessionLiveness(item.taskId),
        })),
      );
      const live = liveness.filter(({ state }) => state === 'live');
      for (const { item } of live) {
        this.reregister(item.taskId, item.providerSandboxId);
        this.readopted.add(item.taskId);
      }
      this.logger?.log?.(
        `startup re-adoption inventory: found ${live.length} still-running ` +
          `${AIO_SANDBOX_CONTAINER_PREFIX}* sandbox(es) with a live agent session ` +
          `(inventory is read-only; orphan cleanup requires explicit reconciliation)`,
      );
    } catch (err) {
      this.logger?.warn?.(
        `startup re-adoption inventory failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }
  }

  private async listRunningSandboxInventory(): Promise<
    readonly AioRunningSandboxInventoryItem[]
  > {
    const running = await this.docker.listContainers({
      all: false,
      filters: {
        name: [AIO_SANDBOX_CONTAINER_PREFIX],
        status: ['running'],
      },
    });
    const inventory: AioRunningSandboxInventoryItem[] = [];
    for (const info of running) {
      const taskId = parseAioTaskIdFromContainerNames(info.Names);
      if (!taskId) continue;
      if (typeof info.Id !== 'string' || info.Id.length === 0) {
        throw new Error('AIO running sandbox inventory is missing container id');
      }
      inventory.push({ taskId, providerSandboxId: info.Id });
    }
    return inventory;
  }

  private reregister(taskId: string, providerSandboxId?: string): void {
    if (!this.containers.has(taskId)) {
      this.containers.set(
        taskId,
        this.docker.getContainer(
          providerSandboxId ?? buildAioSandboxContainerName(taskId),
        ),
      );
    }
    if (providerSandboxId) this.providerSandboxIds.set(taskId, providerSandboxId);
    if (!this.connections.has(taskId)) {
      this.connections.set(taskId, buildAioSandboxConnection(taskId));
    }
  }

  private async probeSessionLiveness(
    taskId: string,
  ): Promise<'live' | 'dead'> {
    const baseUrl = buildAioSandboxBaseUrl(taskId);
    const command = `tmux has-session -t task${taskId}`;
    const res = await this.fetchImpl(`${baseUrl}/v1/shell/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(AIO_SANDBOX_SESSION_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `AIO session liveness probe for task ${taskId} returned HTTP ${res.status}`,
      );
    }
    const { exitCode } = parseAioExecResult(await res.json());
    if (exitCode === 0) return 'live';
    if (exitCode === 1) return 'dead';
    throw new Error(
      `AIO session liveness probe for task ${taskId} returned indeterminate exit code ${String(exitCode)}`,
    );
  }
}

type SettledAioExternalAction<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function settleAioExternalAction<T>(
  run: () => Promise<T>,
): Promise<SettledAioExternalAction<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

export function scrubAioExecSecrets(output: string): string {
  return scrubSandboxCommandOutput(output);
}

export function parseAioExecResult(raw: unknown): AioSandboxExecResult {
  const result = normalizeSandboxCommandResult(raw);
  return { exitCode: result.exitCode, output: result.output };
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function isDockerNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { statusCode?: unknown; status?: unknown; reason?: unknown };
  if (record.statusCode === 404 || record.status === 404) return true;
  return (
    typeof record.reason === 'string' &&
    record.reason.toLowerCase().includes('no such container')
  );
}

function isDefinitiveAioCreateWithoutResource(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { statusCode?: unknown; status?: unknown };
  const status =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : null;
  return status !== null && status >= 400 && status < 500 && status !== 408;
}

function isDockerContainerNameConflict(
  error: unknown,
  containerName: string,
): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as {
    statusCode?: unknown;
    status?: unknown;
    message?: unknown;
    reason?: unknown;
    json?: { message?: unknown };
    body?: { message?: unknown };
  };
  if (record.statusCode !== 409 && record.status !== 409) return false;

  const messages = [
    record.json?.message,
    record.body?.message,
    record.reason,
    record.message,
  ].filter((value): value is string => typeof value === 'string');
  const expectedName = containerName.toLowerCase();
  const quotedNames = [
    `"/${expectedName}"`,
    `"${expectedName}"`,
    `'/${expectedName}'`,
    `'${expectedName}'`,
  ];
  return messages.some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('container name') &&
      normalized.includes('already in use') &&
      quotedNames.some((quoted) => normalized.includes(quoted))
    );
  });
}

function assertAioProvisionSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('AIO sandbox provisioning was aborted');
  }
}

function isInspectedContainerRunning(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const state = (value as { State?: unknown }).State;
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { Running?: unknown }).Running === true
  );
}

function assertExistingContainerMatchesProvision(
  spec: AioLocalSandboxProvisionSpec,
  value: unknown,
  resourceGeneration?: string,
): void {
  if (!value || typeof value !== 'object') {
    throw new Error('Existing AIO sandbox inspection is invalid');
  }
  const record = value as {
    Config?: {
      Image?: unknown;
      Env?: unknown;
      Labels?: Readonly<Record<string, unknown>>;
    };
    HostConfig?: { NetworkMode?: unknown };
  };
  const image = record.Config?.Image;
  const env = record.Config?.Env;
  const network = record.HostConfig?.NetworkMode;
  if (
    image !== spec.containerConfig.Image ||
    network !== spec.containerConfig.HostConfig.NetworkMode ||
    !Array.isArray(env) ||
    !env.includes(`TASK_ID=${spec.taskId}`)
  ) {
    throw new Error(
      'Existing AIO sandbox does not match immutable task provisioning inputs',
    );
  }
  if (
    resourceGeneration !== undefined &&
    record.Config?.Labels?.[AIO_SANDBOX_RESOURCE_GENERATION_LABEL] !==
      resourceGeneration
  ) {
    throw new Error(
      'Existing AIO sandbox resource generation does not match ownership fence',
    );
  }
}

function aioResourceGeneration(
  ownership: SandboxOwnershipFence | undefined,
): string | undefined {
  const value = ownership?.resourceGeneration;
  if (value === undefined) return undefined;
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error('AIO sandbox resource generation is invalid');
  }
  return value;
}

function assertInspectedResourceGeneration(
  value: unknown,
  ownership: SandboxOwnershipFence,
): void {
  const expected = aioResourceGeneration(ownership)!;
  if (!value || typeof value !== 'object') {
    throw new Error('Existing AIO sandbox inspection is invalid');
  }
  const labels = (value as {
    Config?: { Labels?: Readonly<Record<string, unknown>> };
  }).Config?.Labels;
  if (labels?.[AIO_SANDBOX_RESOURCE_GENERATION_LABEL] !== expected) {
    throw new Error(
      'Existing AIO sandbox resource generation does not match ownership fence',
    );
  }
}

function assertInspectedTaskId(value: unknown, taskId: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error('Existing AIO sandbox inspection is invalid');
  }
  const env = (value as { Config?: { Env?: unknown } }).Config?.Env;
  if (!Array.isArray(env) || !env.includes(`TASK_ID=${taskId}`)) {
    throw new Error('AIO readoption task id does not match persisted target');
  }
}

function requireCreatedContainerId(container: AioDockerContainer): string {
  if (typeof container.id !== 'string' || container.id.length === 0) {
    throw new Error('Created AIO sandbox is missing container id');
  }
  return container.id;
}

function requireInspectedContainerId(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('Existing AIO sandbox inspection is invalid');
  }
  const id = (value as { Id?: unknown }).Id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Existing AIO sandbox inspection is missing container id');
  }
  return id;
}
