import type {
  GitCloneSpec,
  SandboxCommandExecutor,
  SandboxCommandExecutionResult,
  SandboxPreflightResult,
  SandboxProviderDescriptor,
  SandboxRuntimePrivateFilePort,
  SandboxTranscriptSourceBase,
} from '@cap-console/sandbox-core';
import {
  classifySandboxRuntimeCommandExecution,
  SandboxRuntimeCommandExecutionError,
  SandboxRuntimeModelSetupError,
  scrubSandboxCommandOutput,
  validateSandboxRuntimePreflightCommandDescriptor,
  validateSandboxRuntimeSetupCommandDescriptor,
} from '@cap-console/sandbox-core';
import {
  SANDBOX_METADATA_PATH,
  parseSandboxMetadataText,
  type SandboxMetadata,
} from '@cap-console/contracts';
import {
  AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS,
  AIO_SANDBOX_TRIM_TIMEOUT_MS,
  AIO_SANDBOX_WORKSPACE_DIR,
  defineAioSandboxProviderFromDocker,
  scrubAioExecSecrets,
  type AioSandboxContainerController,
} from '@cap-console/sandbox-provider-aio';
import { defineHttpCloudSandboxProvider } from '@cap-console/sandbox-cloud-http';
import {
  createBoxLiteRuntimePreflight,
  defineBoxLiteSandboxProvider,
  readBoxLiteProviderConfig,
  requiredToolsForBoxLiteCapabilities,
} from '@cap-console/sandbox-provider-boxlite';
import {
  buildSandboxImageParameterSetupCommands,
  removeSandboxImageParameterFile,
  removeSandboxImageParameterFileBestEffort,
  type SandboxHostImageParameterProfile,
} from './image-parameters.js';
import { materializeTaskModel } from './model-material.js';
import {
  SandboxProviderRouter,
  type RoutableSandboxProvider,
} from '../provider-center/router.js';
import type {
  SandboxWorkspaceMaterializationHook,
} from '@cap-console/sandbox-core';
import {
  deliverSandboxGitWorkspaceStaged,
  materializeSandboxGitWorkspaceStaged,
} from '../workspace/git.js';
import { readConfiguredWorkspaceTransferLiveness } from './deployment-environment.js';
import type {
  SandboxHostHarness,
  SandboxHostLogger,
  SandboxHostRuntime,
} from './harness.js';
import {
  DEFAULT_CLOUD_HTTP_CAPABILITIES,
  configuredFamilyAllowsProviderFamily,
  explicitProviderFamilyLabel,
  readBoxLiteRuntimeRequiredTools,
  readConfiguredSandboxProviderFamily,
  readNumberEnv,
  readOptionalEnv,
  readSandboxLocationEnv,
  readSandboxProviderCapabilitiesEnv,
} from './config.js';

export type HarnessRoutableSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
> = RoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>;

export function createConfiguredSandboxProvider<
  TCloneSpec = GitCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
  TAuthMaterial = unknown,
>(
  host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >,
): SandboxProviderRouter<TCloneSpec, TRuntimeId, TTranscriptSource> {
  const providerFamily = readConfiguredSandboxProviderFamily();
  // Shared hook seam (design D1): both BoxLite and AIO inherit the detached
  // workspace-transfer path and the deployment's dual-gate liveness knobs
  // from this single wiring point; provider packages stay detach-agnostic.
  const workspaceMaterialization = createConfiguredWorkspaceMaterializationHook();
  const providers: SandboxProviderDescriptor<
    HarnessRoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  >[] = [];

  if (configuredFamilyAllowsProviderFamily(providerFamily, 'aio')) {
    providers.push(createAioProviderDescriptor(host, workspaceMaterialization));
  }

  const cloudBaseUrl = readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_BASE_URL');
  if (providerFamily === 'cloud-http' && !cloudBaseUrl) {
    throw new Error(
      'CAP_SANDBOX_PROVIDER=cloud-http selected but CAP_SANDBOX_CLOUD_HTTP_BASE_URL is not configured',
    );
  }
  if (cloudBaseUrl && configuredFamilyAllowsProviderFamily(providerFamily, 'cloud-http')) {
    providers.push(
      defineHttpCloudSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>({
        id: readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_ID') ?? 'cloud-http',
        baseUrl: cloudBaseUrl,
        apiToken: readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_TOKEN'),
        capabilities: readSandboxProviderCapabilitiesEnv(
          'CAP_SANDBOX_CLOUD_HTTP_CAPABILITIES',
          DEFAULT_CLOUD_HTTP_CAPABILITIES,
        ),
        priority: readNumberEnv('CAP_SANDBOX_CLOUD_HTTP_PRIORITY', 50),
      }),
    );
  }

  const boxlite = readBoxLiteProviderConfig();
  if (providerFamily === 'boxlite' && boxlite.status !== 'valid') {
    throw new Error(
      boxlite.status === 'disabled'
        ? `CAP_SANDBOX_PROVIDER=boxlite selected but BoxLite is disabled: ${boxlite.reason}`
        : `CAP_SANDBOX_PROVIDER=boxlite selected but BoxLite config is invalid: ${boxlite.errors.join('; ')}`,
    );
  }
  if (
    boxlite.status === 'valid' &&
    configuredFamilyAllowsProviderFamily(providerFamily, 'boxlite')
  ) {
    const baseBoxLitePreflight = createBoxLiteRuntimePreflight({
      requiredTools: mergeToolLists(
        requiredToolsForBoxLiteCapabilities(boxlite.config.capabilities),
        readBoxLiteRuntimeRequiredTools(),
      ),
      workspacePath: boxlite.config.workspacePath,
      requireTerminalByteBridge:
        boxlite.config.protocolMode === 'native' &&
        (boxlite.config.capabilities.includes('terminal.websocket') ||
          boxlite.config.capabilities.includes('terminal.interactive')),
    });
    providers.push(
      defineBoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>({
        config: boxlite.config,
        preflight: async (context) => {
          const sandboxMetadata = await readSandboxMetadata({
            executor: context.executor,
            taskId: context.taskId,
            runtimeId: context.runtimeId ?? null,
            providerLabel: 'BoxLite',
            scrubOutput: scrubSandboxCommandOutput,
          });
          const result = await baseBoxLitePreflight(context);
          return {
            ...result,
            metadata: { ...(result.metadata ?? {}), sandboxMetadata },
          };
        },
        resolveRuntimeId: async (taskId) =>
          (
            await resolveProvisionRuntime({
              host,
              taskId,
              providerLabel: 'BoxLite',
            })
          ).id,
        runtimeSetup: ({
          taskId,
          modelIntent,
          executor,
          workspacePath,
          runtimeId,
          runtimePrivateFiles,
        }) =>
          runBoxLiteRuntimeSetup({
            taskId,
            modelIntent,
            executor,
            workspacePath,
            runtimeId,
            runtimePrivateFiles,
            host,
          }),
        transcriptRead: ({ taskId, runtimeId, executor, workspacePath }) =>
          readBoxLiteTranscriptSource({
            taskId,
            runtimeId,
            executor,
            workspacePath,
            host,
          }),
        preStopCleanup: ({ taskId, executor }) =>
          removeSandboxImageParameterFileBestEffort({
            executor,
            taskId,
            warn: (message) => host.logger?.warn?.(message),
          }),
        resolveEnvironment: async ({ taskId, runtimeId }) =>
          (await host.provisionLookup.getResolvedEnvironment?.(
            taskId,
            'boxlite',
            runtimeId ?? null,
          )) ?? null,
        workspaceMaterialization,
        workspaceDelivery: deliverSandboxGitWorkspaceStaged,
      }),
    );
  }

  return new SandboxProviderRouter<TCloneSpec, TRuntimeId, TTranscriptSource>(
    providers,
    {
      preferLocation: readSandboxLocationEnv('CAP_SANDBOX_PREFER_LOCATION'),
      explicitProviderFamily: explicitProviderFamilyLabel(providerFamily),
      ownerStore: host.ownerStore,
      resolveTaskProviderId: async (taskId) => {
        const context = await host.provisionLookup.getTaskLaunchContext(taskId);
        if (context.modelIntent.kind === 'runtime-default') return null;
        const providerId = context.environment?.providerId;
        if (!providerId) {
          throw new SandboxRuntimeModelSetupError('snapshot');
        }
        return providerId;
      },
    },
  );
}

/**
 * Wrap the staged materialization helper with the deployment's detached
 * workspace-transfer options: the `workspace_transfer` stage runs as a
 * detached supervised job (launch + short polling execs) under the configured
 * dual-gate liveness knobs. Knob validation fails fast at provider
 * construction, mirroring the other config readers.
 */
function createConfiguredWorkspaceMaterializationHook(): SandboxWorkspaceMaterializationHook {
  const liveness = readConfiguredWorkspaceTransferLiveness();
  return (context) =>
    materializeSandboxGitWorkspaceStaged({
      ...context,
      detachedTransfer: {
        ...(context.detachedTransfer ?? {}),
        liveness,
      },
    });
}

function createAioProviderDescriptor<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(
  host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >,
  workspaceMaterialization: SandboxWorkspaceMaterializationHook,
): SandboxProviderDescriptor<
  HarnessRoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
> {
  const provisionRuntimes = new Map<string, SandboxHostRuntime<TAuthMaterial>>();

  return defineAioSandboxProviderFromDocker<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >({
    priority: readNumberEnv('CAP_SANDBOX_LOCAL_PRIORITY', 10),
    logger: host.logger,
    hooks: {
      provisionLookup: {
        getTaskPrompt: (taskId) => host.provisionLookup.getTaskPrompt(taskId),
        getRuntimeId: async (taskId) => {
          const runtime = await resolveProvisionRuntime({
            host,
            taskId,
            providerLabel: 'AIO',
          });
          provisionRuntimes.set(taskId, runtime);
          return runtime.id as TRuntimeId;
        },
        getResolvedEnvironment: async (taskId, runtimeId) =>
          (await host.provisionLookup.getResolvedEnvironment?.(
            taskId,
            'aio',
            runtimeId === null || runtimeId === undefined ? null : String(runtimeId),
          )) ?? null,
      },
      runtimePreflight: async ({ taskId, executor, runtimeId }) => {
        const runtime = resolveProvisionHookRuntime({
          provisionRuntimes,
          host,
          taskId,
          runtimeId,
          providerLabel: 'AIO',
        });
        const sandboxMetadata = await runRuntimePreflight({
          executor,
          taskId,
          runtime,
          logger: host.logger,
          providerLabel: 'AIO',
          scrubOutput: scrubAioExecSecrets,
        });
        return {
          status: 'passed',
          checkedAt: new Date().toISOString(),
          runtimeId: runtime.id,
          metadata: { sandboxMetadata },
        };
      },
      runtimeSetup: async ({
        taskId,
        modelIntent,
        executor,
        runtimeId,
        runtimePrivateFiles,
      }) => {
        try {
          const runtime = resolveProvisionHookRuntime({
            provisionRuntimes,
            host,
            taskId,
            runtimeId,
            providerLabel: 'AIO',
          });
          await runImageParameterSetup({
            executor,
            runtimePrivateFiles,
            taskId,
            host,
            logger: host.logger,
            providerLabel: 'AIO',
            providerFamily: 'aio',
            runtimeId: runtime.id,
            scrubOutput: scrubAioExecSecrets,
          });
          await materializeTaskModel(executor, modelIntent);
          await runRuntimeSetup({
            executor,
            taskId,
            runtime,
            runtimePrivateFiles,
            workspaceDir: AIO_SANDBOX_WORKSPACE_DIR,
            host,
            logger: host.logger,
            providerLabel: 'AIO',
          });
        } finally {
          provisionRuntimes.delete(taskId);
        }
      },
      skillPreinstall: ({ taskId, executor }) =>
        preinstallSkills({ host, executor, taskId }),
      transcriptRead: ({ taskId, runtimeId, controller }) =>
        readAioTranscriptSource({
          taskId,
          runtimeId,
          controller,
          host,
        }),
      preStopTrim: async ({ taskId, executor }) => {
        await removeSandboxImageParameterFile({
          executor,
          taskId,
        });
        await trimRuntimeHomeBeforeStop({
          host,
          executor,
          taskId,
        });
      },
      workspaceMaterialization,
      workspaceDelivery: deliverSandboxGitWorkspaceStaged,
    },
  });
}

async function resolveRuntime<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly taskId: string;
  readonly providerLabel: string;
}): Promise<SandboxHostRuntime<TAuthMaterial> | undefined> {
  try {
    return (await args.host.runtimeRegistry.resolveForTask?.(args.taskId)) ?? undefined;
  } catch {
    args.host.logger?.warn?.(
      `could not resolve AgentRuntime for ${args.providerLabel} task ${args.taskId} (defaulting)`,
    );
    return undefined;
  }
}

async function resolveProvisionRuntime<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly taskId: string;
  readonly providerLabel: string;
}): Promise<SandboxHostRuntime<TAuthMaterial>> {
  return (
    (await resolveRuntime(args)) ??
    args.host.runtimeRegistry.resolve(null)
  );
}

function resolveRuntimeFromId<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly runtimeId?: TRuntimeId | null;
  readonly providerLabel: string;
}): SandboxHostRuntime<TAuthMaterial> {
  try {
    return args.host.runtimeRegistry.resolve(args.runtimeId ?? null);
  } catch {
    args.host.logger?.warn?.(
      `could not resolve AgentRuntime "${String(args.runtimeId ?? 'default')}" for ${args.providerLabel} (defaulting)`,
    );
    return args.host.runtimeRegistry.resolve(null);
  }
}

function resolveProvisionHookRuntime<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly provisionRuntimes: ReadonlyMap<
    string,
    SandboxHostRuntime<TAuthMaterial>
  >;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly providerLabel: string;
}): SandboxHostRuntime<TAuthMaterial> {
  const cached = args.provisionRuntimes.get(args.taskId);
  if (cached) return cached;
  if (args.runtimeId === null || args.runtimeId === undefined) {
    throw new SandboxRuntimeModelSetupError('runtime-resolution');
  }
  return resolveRequiredRuntimeFromId({
    host: args.host,
    runtimeId: args.runtimeId,
  });
}

function resolveRequiredRuntimeFromId<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly runtimeId: TRuntimeId;
}): SandboxHostRuntime<TAuthMaterial> {
  try {
    return args.host.runtimeRegistry.resolve(args.runtimeId);
  } catch {
    throw new SandboxRuntimeModelSetupError('runtime-resolution');
  }
}

async function runImageParameterSetup<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly executor: SandboxCommandExecutor;
  readonly runtimePrivateFiles: SandboxRuntimePrivateFilePort;
  readonly taskId: string;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly logger?: SandboxHostLogger;
  readonly providerLabel: string;
  readonly providerFamily: 'aio' | 'boxlite';
  readonly runtimeId: string;
  readonly scrubOutput: (output: string) => string;
}): Promise<void> {
  const profile = await resolveImageParameterProfile({
    host: args.host,
    taskId: args.taskId,
    providerFamily: args.providerFamily,
    runtimeId: args.runtimeId,
    logger: args.logger,
  });
  const commands = buildSandboxImageParameterSetupCommands(profile);
  if (commands.length === 0) return;

  for (const { command, tolerateUnresolvedExit, privateFiles } of commands) {
    try {
      for (const file of privateFiles) {
        await args.runtimePrivateFiles.writeFile(file);
      }
    } catch {
      throw new Error(
        `image parameter setup for ${args.providerLabel} task ${args.taskId} failed: private file write did not settle`,
      );
    }
    const { exitCode } = await runSandboxCommand(args.executor, command);
    if (setupCommandFailed(exitCode, tolerateUnresolvedExit)) {
      throw new Error(
        `image parameter setup for ${args.providerLabel} task ${args.taskId} failed: exit_code ${exitCode}`,
      );
    }
  }
  args.logger?.debug?.(
    `provisioned ${args.providerLabel} image parameters for task ${args.taskId} (${commands.length} command(s))`,
  );
}

async function resolveImageParameterProfile<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly taskId: string;
  readonly providerFamily: 'aio' | 'boxlite';
  readonly runtimeId: string;
  readonly logger?: SandboxHostLogger;
}): Promise<SandboxHostImageParameterProfile | null> {
  if (!args.host.provisionLookup.getTaskImageParameterProfile) return null;
  try {
    return (
      (await args.host.provisionLookup.getTaskImageParameterProfile(
        args.taskId,
        args.providerFamily,
        args.runtimeId,
      )) ??
      null
    );
  } catch {
    args.logger?.warn?.(
      `task ${args.taskId}: could not resolve image parameters (skipping)`,
    );
    return null;
  }
}

async function runRuntimePreflight<TAuthMaterial>(args: {
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
  readonly runtime: SandboxHostRuntime<TAuthMaterial>;
  readonly logger?: SandboxHostLogger;
  readonly providerLabel: string;
  readonly scrubOutput: (output: string) => string;
}): Promise<SandboxMetadata> {
  const sandboxMetadata = await readSandboxMetadata({
    executor: args.executor,
    taskId: args.taskId,
    runtimeId: args.runtime.id,
    providerLabel: args.providerLabel,
    scrubOutput: args.scrubOutput,
  });
  const probes = args.runtime.preflightProbes();
  for (const [index, probe] of probes.entries()) {
    const descriptor = validateSandboxRuntimePreflightCommandDescriptor(
      probe.descriptor,
      index + 1,
    );
    const classification = await classifySandboxRuntimeCommandExecution({
      executor: args.executor,
      request: { command: probe.command },
      descriptor,
    });
    if (classification.outcome !== 'succeeded') {
      throw new SandboxRuntimeCommandExecutionError(
        descriptor,
        classification,
      );
    }
  }
  args.logger?.debug?.(
    `runtime "${args.runtime.id}" ${args.providerLabel} preflight passed for task ${args.taskId} (${probes.length} probe(s))`,
  );
  return sandboxMetadata;
}

/**
 * Historical runtime spellings a caller may still present, mapped to the id the
 * image metadata declares. Data, not a decision: the provider does not branch on
 * WHICH runtime is running, it only canonicalises the key it looks up.
 */
const RUNTIME_DEPENDENCY_KEY_ALIASES: Readonly<Record<string, string>> = {
  claude: 'claude-code',
};

function normalizeRuntimeDependencyKey(runtimeId: string): string {
  return RUNTIME_DEPENDENCY_KEY_ALIASES[runtimeId] ?? runtimeId;
}

/**
 * D3 — transcript read strategies, dispatched for real.
 *
 * The 2026-07-28 fail-loud-on-unknown-runtime change ruled this seam a false
 * seam and collapsed it to a single-member loud throw
 * (`assertSingleNewestJsonlSupported`). That ruling is explicitly SUPERSEDED
 * here because its triggering condition changed: a per-message JSON directory
 * store (opencode's session layout) is a demonstrated second read shape. The
 * vocabulary names SHAPES, not runtimes — a third runtime reusing the JSONL
 * layout declares `single-newest-jsonl` instead of forcing a fake member — and
 * the second member exists and dispatches even though no registered runtime
 * declares it yet.
 *
 * NOTE(unlock-extension-axes integration): these member names mirror the
 * contracts `TranscriptReadStrategy` vocabulary landed by the
 * contracts-runtime-tables track (task 1.7). Once that track is merged this
 * local alias is re-pointed at the contracts declaration.
 */
type TranscriptReadStrategyKind = 'single-newest-jsonl' | 'per-message-json-dir';

/**
 * What a provider must supply for the strategies to read through. The medium
 * carries provider mechanics (docker archive, executor find/cat); the strategy
 * table below owns WHAT is read, so neither side branches on the other.
 */
interface TranscriptArtifactMedium {
  /** Content of the newest artifact file matching the glob, or null when absent. */
  readNewestMatching(dir: string, filenameGlob: RegExp): Promise<string | null>;
  /**
   * Contents of ALL matching artifact files in ascending path order, or null
   * when the directory cannot be enumerated or a member cannot be read.
   */
  readAllMatching(
    dir: string,
    filenameGlob: RegExp,
  ): Promise<readonly string[] | null>;
}

type TranscriptStrategyReader = (args: {
  readonly medium: TranscriptArtifactMedium;
  readonly dir: string;
  readonly filenameGlob: RegExp;
}) => Promise<string | null>;

/**
 * Total dispatch over the strategy vocabulary: every member has an
 * implementation, and a kind outside the vocabulary misses the table and is
 * refused loudly by name in {@link resolveTranscriptStrategyReader}.
 */
const TRANSCRIPT_READ_STRATEGIES: Record<
  TranscriptReadStrategyKind,
  TranscriptStrategyReader
> = {
  'single-newest-jsonl': ({ medium, dir, filenameGlob }) =>
    medium.readNewestMatching(dir, filenameGlob),
  'per-message-json-dir': async ({ medium, dir, filenameGlob }) => {
    const documents = await medium.readAllMatching(dir, filenameGlob);
    if (documents === null || documents.length === 0) return null;
    return `${documents
      .map((document) => document.replace(/\n+$/u, ''))
      .join('\n')}\n`;
  },
};

/**
 * Resolve the reader for a runtime-declared strategy, refusing an unknown one
 * loudly. Returning null for an unimplemented strategy once made it
 * indistinguishable from a task that simply has no transcript — the operator
 * saw an empty session and nothing said why. That loud boundary is preserved:
 * only the vocabulary behind it grew from one member to a real dispatch.
 */
function resolveTranscriptStrategyReader(
  kind: string,
  providerLabel: string,
): TranscriptStrategyReader {
  const reader = (
    TRANSCRIPT_READ_STRATEGIES as Record<string, TranscriptStrategyReader | undefined>
  )[kind];
  if (!reader) {
    throw new Error(
      `${providerLabel} cannot read transcripts with strategy "${kind}": ` +
        `known strategies are ${Object.keys(TRANSCRIPT_READ_STRATEGIES).join(', ')}`,
    );
  }
  return reader;
}

async function readSandboxMetadata(args: {
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
  readonly runtimeId: string | null;
  readonly providerLabel: string;
  readonly scrubOutput: (output: string) => string;
}): Promise<SandboxMetadata> {
  const { exitCode, output } = await runSandboxCommand(
    args.executor,
    `cat ${SANDBOX_METADATA_PATH}`,
  );
  if (exitCode !== 0) {
    throw new Error(
      `sandbox metadata preflight for ${args.providerLabel} task ${args.taskId} failed: ` +
        `${SANDBOX_METADATA_PATH} exit_code ${exitCode}`,
    );
  }
  let metadata: SandboxMetadata;
  try {
    metadata = parseSandboxMetadataText(output.trim());
  } catch (error) {
    throw new Error(
      `sandbox metadata preflight for ${args.providerLabel} task ${args.taskId} failed: ` +
        args.scrubOutput(String(error)),
    );
  }
  // EVERY named runtime must be declared by the image — no allow-list.
  //
  // This previously ran only for the two ids it spelled out, which made it
  // fail-OPEN: a runtime outside that pair skipped image validation entirely and
  // provisioned against an image that never declared it. The provider is
  // deliberately runtime-agnostic (`runtimeId` is an opaque string here), so it
  // has no business knowing WHICH runtimes exist — only that whichever one was
  // selected has to appear in the metadata.
  const key = args.runtimeId === null ? null : normalizeRuntimeDependencyKey(args.runtimeId);
  if (key !== null && !metadata.dependencies[key]) {
    throw new Error(
      `sandbox metadata preflight for ${args.providerLabel} task ${args.taskId} failed: ` +
        `selected runtime dependency ${key} is not declared`,
    );
  }
  return metadata;
}

async function runRuntimeSetup<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
  readonly runtime: SandboxHostRuntime<TAuthMaterial>;
  readonly runtimePrivateFiles: SandboxRuntimePrivateFilePort;
  readonly workspaceDir: string;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly logger?: SandboxHostLogger;
  readonly providerLabel: string;
}): Promise<void> {
  const launchContext = await args.host.provisionLookup.getTaskLaunchContext(
    args.taskId,
  );
  const [material, prompt] = await Promise.all([
    args.host.materialResolvers.resolve(args.runtime, {
      taskId: args.taskId,
      ownerUserId: launchContext.ownerUserId,
    }),
    args.host.provisionLookup.getTaskPrompt(args.taskId),
  ]);
  const plan = args.runtime.sandboxSetupCommands(
    {
      taskId: args.taskId,
      workspaceDir: args.workspaceDir,
      prompt: prompt ?? null,
    },
    material,
  );
  if (!plan.ok) {
    throw new Error(
      `runtime "${args.runtime.id}" setup for task ${args.taskId} failed: ${plan.reason}`,
    );
  }

  for (const [index, command] of plan.commands.entries()) {
    const descriptor = validateSandboxRuntimeSetupCommandDescriptor(
      command.descriptor,
      index + 1,
    );
    try {
      for (const file of command.privateFiles ?? []) {
        await args.runtimePrivateFiles.writeFile(file);
      }
    } catch {
      throw new SandboxRuntimeCommandExecutionError(descriptor, {
        settlement: 'indeterminate',
        outcome: 'indeterminate',
        cause: 'settlement_unknown',
        retryable: true,
        exitCode: null,
      });
    }
    const classification = await classifySandboxRuntimeCommandExecution({
      executor: args.executor,
      request: { command: command.command },
      descriptor,
    });
    if (
      classification.outcome !== 'succeeded' &&
      !(
        classification.settlement === 'indeterminate' &&
        command.tolerateUnresolvedExit
      )
    ) {
      throw new SandboxRuntimeCommandExecutionError(
        descriptor,
        classification,
      );
    }
  }
  args.logger?.debug?.(
    `provisioned ${args.providerLabel} runtime "${args.runtime.id}" setup for task ${args.taskId} (${plan.commands.length} command(s))`,
  );
}

function setupCommandFailed(
  exitCode: number,
  tolerateUnresolvedExit: boolean,
): boolean {
  return Number.isNaN(exitCode) ? !tolerateUnresolvedExit : exitCode !== 0;
}

async function preinstallSkills<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
}): Promise<void> {
  if (!args.host.provisionLookup.getTaskSkills) return;

  let skills: readonly string[] = [];
  try {
    skills = await args.host.provisionLookup.getTaskSkills(args.taskId);
  } catch {
    args.host.logger?.warn?.(
      `task ${args.taskId}: could not resolve selected skills (skipping preinstall)`,
    );
    return;
  }
  if (skills.length === 0) return;

  if (!args.host.skillInstallers) {
    args.host.logger?.warn?.(
      `task ${args.taskId}: selected skills cannot be preinstalled because no skill installer registry is wired`,
    );
    return;
  }

  for (const id of skills) {
    const installer = args.host.skillInstallers.resolveSkillInstaller(id);
    if (!installer) {
      args.host.logger?.warn?.(
        `task ${args.taskId}: skill "${id}" is not allowlisted; skipping (not executed)`,
      );
      continue;
    }
    const command = `${installer
      .command(AIO_SANDBOX_WORKSPACE_DIR)
      .join(' ')} < /dev/null`;
    try {
      const { exitCode } = await args.executor.exec({
        command,
        timeoutMs: AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS,
      });
      if (exitCode !== 0) {
        args.host.logger?.warn?.(
          `task ${args.taskId}: skill "${id}" (${installer.label}) installer exit_code ${exitCode} - degrading (runtime launches without it)`,
        );
        continue;
      }
      args.host.logger?.debug?.(
        `task ${args.taskId}: preinstalled skill "${id}" (${installer.label})`,
      );
    } catch {
      args.host.logger?.warn?.(
        `task ${args.taskId}: skill "${id}" (${installer.label}) preinstall failed/timed out - degrading (runtime launches without it)`,
      );
    }
  }
}

async function trimRuntimeHomeBeforeStop<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
}): Promise<void> {
  const runtime =
    (await resolveRuntime({
      host: args.host,
      taskId: args.taskId,
      providerLabel: 'AIO',
    })) ?? args.host.runtimeRegistry.resolve(null);
  for (const command of runtime.preStopTrimCommands()) {
    await runTrimCommandStrict({
      executor: args.executor,
      taskId: args.taskId,
      command,
    });
  }
}

async function runTrimCommandStrict(args: {
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
  readonly command: string;
}): Promise<void> {
  let result: SandboxCommandExecutionResult;
  try {
    result = await args.executor.exec({
      command: args.command,
      timeoutMs: AIO_SANDBOX_TRIM_TIMEOUT_MS,
    });
  } catch {
    throw new Error(
      `pre-stop private cleanup for task ${args.taskId} did not settle`,
    );
  }
  if (result.exitCode !== 0 || result.timedOut === true) {
    throw new Error(
      `pre-stop private cleanup for task ${args.taskId} was not confirmed`,
    );
  }
}

async function readAioTranscriptSource<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly controller: Pick<AioSandboxContainerController, 'readSingleNewestJsonl'>;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
}): Promise<TTranscriptSource | null> {
  const runtime = resolveRuntimeFromId({
    host: args.host,
    runtimeId: args.runtimeId,
    providerLabel: 'AIO',
  });
  const reader = resolveTranscriptStrategyReader(
    runtime.readTranscriptSource.kind,
    'AIO',
  );

  const { dir, filenameGlob } = runtime.transcriptArtifact({
    taskId: args.taskId,
    workspaceDir: AIO_SANDBOX_WORKSPACE_DIR,
    sessionId: args.host.sessionIdForTask?.(args.taskId),
  });
  const jsonl = await reader({
    medium: createAioTranscriptMedium(args.taskId, args.controller),
    dir,
    filenameGlob,
  });
  if (jsonl === null) return null;
  return createTranscriptSource(args.host, {
    format: runtime.transcriptFormat,
    jsonl,
  });
}

/**
 * The AIO container controller exposes exactly one artifact read call
 * (`readSingleNewestJsonl`), so per-message enumeration is a declared provider
 * capability GAP that fails loudly where it is — distinct from an unknown
 * strategy, which is refused by {@link resolveTranscriptStrategyReader} before
 * any medium is touched.
 */
function createAioTranscriptMedium(
  taskId: string,
  controller: Pick<AioSandboxContainerController, 'readSingleNewestJsonl'>,
): TranscriptArtifactMedium {
  return {
    readNewestMatching: (dir, filenameGlob) =>
      controller.readSingleNewestJsonl(taskId, dir, filenameGlob),
    readAllMatching: async () => {
      throw new Error(
        'AIO cannot enumerate per-message transcript artifacts: the container ' +
          'controller only exposes readSingleNewestJsonl',
      );
    },
  };
}

async function readBoxLiteTranscriptSource<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly taskId: string;
  readonly runtimeId?: TRuntimeId | null;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
}): Promise<TTranscriptSource | null> {
  const runtime = resolveRuntimeFromId({
    host: args.host,
    runtimeId: args.runtimeId,
    providerLabel: 'BoxLite',
  });
  const reader = resolveTranscriptStrategyReader(
    runtime.readTranscriptSource.kind,
    'BoxLite',
  );

  const { dir, filenameGlob } = runtime.transcriptArtifact({
    taskId: args.taskId,
    workspaceDir: args.workspacePath,
    sessionId: args.host.sessionIdForTask?.(args.taskId),
  });
  const jsonl = await reader({
    medium: createBoxLiteTranscriptMedium(args.executor),
    dir,
    filenameGlob,
  });
  if (jsonl === null) return null;
  return createTranscriptSource(args.host, {
    format: runtime.transcriptFormat,
    jsonl,
  });
}

function createBoxLiteTranscriptMedium(
  executor: SandboxCommandExecutor,
): TranscriptArtifactMedium {
  return {
    readNewestMatching: async (dir, filenameGlob) => {
      const paths = await listBoxLiteMatchingFiles(executor, dir, filenameGlob);
      const newest = paths?.at(-1);
      if (!newest) return null;
      return readBoxLiteFile(executor, newest);
    },
    readAllMatching: async (dir, filenameGlob) => {
      const paths = await listBoxLiteMatchingFiles(executor, dir, filenameGlob);
      if (paths === null) return null;
      const contents: string[] = [];
      for (const path of paths) {
        const content = await readBoxLiteFile(executor, path);
        if (content === null) return null;
        contents.push(content);
      }
      return contents;
    },
  };
}

async function listBoxLiteMatchingFiles(
  executor: SandboxCommandExecutor,
  dir: string,
  filenameGlob: RegExp,
): Promise<readonly string[] | null> {
  const listed = await executor.exec({
    command: `find ${shellQuote(dir)} -type f -print`,
  });
  if (listed.exitCode !== 0) return null;
  return (listed.stdout || listed.output)
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((path) => {
      filenameGlob.lastIndex = 0;
      return filenameGlob.test(path);
    })
    .sort((left, right) => left.localeCompare(right));
}

async function readBoxLiteFile(
  executor: SandboxCommandExecutor,
  path: string,
): Promise<string | null> {
  const read = await executor.exec({ command: `cat ${shellQuote(path)}` });
  if (read.exitCode !== 0) return null;
  return read.stdout || read.output;
}

function createTranscriptSource<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(
  host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >,
  source: SandboxTranscriptSourceBase,
): TTranscriptSource {
  return host.transcriptSource?.create(source) ?? (source as TTranscriptSource);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function runBoxLiteRuntimeSetup<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly taskId: string;
  readonly modelIntent: import('@cap-console/sandbox-core').TaskModelIntent;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly runtimeId?: string | null;
  readonly runtimePrivateFiles: SandboxRuntimePrivateFilePort;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
}): Promise<void> {
  if (!args.runtimeId) {
    throw new SandboxRuntimeModelSetupError('runtime-resolution');
  }
  const runtime = resolveRequiredRuntimeFromId({
    host: args.host,
    runtimeId: args.runtimeId as TRuntimeId,
  });
  await runImageParameterSetup({
    executor: args.executor,
    runtimePrivateFiles: args.runtimePrivateFiles,
    taskId: args.taskId,
    host: args.host,
    logger: args.host.logger,
    providerLabel: 'BoxLite',
    providerFamily: 'boxlite',
    runtimeId: runtime.id,
    scrubOutput: scrubSandboxCommandOutput,
  });
  await materializeTaskModel(args.executor, args.modelIntent);
  await runRuntimeSetup({
    executor: args.executor,
    taskId: args.taskId,
    runtime,
    runtimePrivateFiles: args.runtimePrivateFiles,
    workspaceDir: args.workspacePath,
    host: args.host,
    logger: args.host.logger,
    providerLabel: 'BoxLite',
  });
}

async function runSandboxCommand(
  executor: SandboxCommandExecutor,
  command: string,
): Promise<Pick<SandboxCommandExecutionResult, 'exitCode' | 'output'>> {
  const { exitCode, output } = await executor.exec({ command });
  return { exitCode, output };
}

function mergeToolLists(
  ...lists: readonly (readonly string[])[]
): readonly string[] {
  return [...new Set(lists.flat())].sort();
}

export type { SandboxPreflightResult };
