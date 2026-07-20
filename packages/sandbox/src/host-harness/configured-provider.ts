import type {
  GitCloneSpec,
  SandboxCommandExecutor,
  SandboxCommandExecutionResult,
  SandboxPreflightResult,
  SandboxProviderDescriptor,
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import {
  classifySandboxRuntimeCommandExecution,
  SandboxRuntimeCommandExecutionError,
  SandboxRuntimeModelSetupError,
  scrubSandboxCommandOutput,
  validateSandboxRuntimePreflightCommandDescriptor,
  validateSandboxRuntimeSetupCommandDescriptor,
} from '@cap/sandbox-core';
import {
  SANDBOX_METADATA_PATH,
  parseSandboxMetadataText,
  type SandboxMetadata,
} from '@cap/contracts';
import {
  AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS,
  AIO_SANDBOX_TRIM_TIMEOUT_MS,
  AIO_SANDBOX_WORKSPACE_DIR,
  defineAioSandboxProviderFromDocker,
  scrubAioExecSecrets,
  type AioSandboxContainerController,
} from '@cap/sandbox-provider-aio';
import { defineHttpCloudSandboxProvider } from '@cap/sandbox-cloud-http';
import {
  createBoxLiteRuntimePreflight,
  defineBoxLiteSandboxProvider,
  readBoxLiteProviderConfig,
  requiredToolsForBoxLiteCapabilities,
} from '@cap/sandbox-provider-boxlite';
import {
  buildSandboxImageParameterSetupCommands,
  removeSandboxImageParameterFileBestEffort,
  scrubSandboxImageParameterSecrets,
  type SandboxHostImageParameterProfile,
} from './image-parameters.js';
import { materializeTaskModel } from './model-material.js';
import {
  SandboxProviderRouter,
  type RoutableSandboxProvider,
} from '../provider-center/router.js';
import type {
  SandboxWorkspaceMaterializationHook,
} from '@cap/sandbox-core';
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
  explicitProviderFamilyLabel,
  providerFamilyAllowsAio,
  providerFamilyAllowsBoxLite,
  providerFamilyAllowsCloudHttp,
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

  if (providerFamilyAllowsAio(providerFamily)) {
    providers.push(createAioProviderDescriptor(host, workspaceMaterialization));
  }

  const cloudBaseUrl = readOptionalEnv('CAP_SANDBOX_CLOUD_HTTP_BASE_URL');
  if (cloudBaseUrl && providerFamilyAllowsCloudHttp(providerFamily)) {
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
    providerFamilyAllowsBoxLite(providerFamily)
  ) {
    const baseBoxLitePreflight = createBoxLiteRuntimePreflight({
      requiredTools: mergeToolLists(
        requiredToolsForBoxLiteCapabilities(boxlite.config.capabilities),
        readBoxLiteRuntimeRequiredTools(),
      ),
      workspacePath: boxlite.config.workspacePath,
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
        }) =>
          runBoxLiteRuntimeSetup({
            taskId,
            modelIntent,
            executor,
            workspacePath,
            runtimeId,
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
        getResolvedEnvironment: (taskId, runtimeId) =>
          host.provisionLookup.getResolvedEnvironment?.(
            taskId,
            'aio',
            runtimeId === null || runtimeId === undefined ? null : String(runtimeId),
          ) ?? null,
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
      runtimeSetup: async ({ taskId, modelIntent, executor, runtimeId }) => {
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
        await captureAndPersistAioCodexAuth({
          host,
          executor,
          taskId,
        });
        await removeSandboxImageParameterFileBestEffort({
          executor,
          taskId,
          warn: (message) => host.logger?.warn?.(message),
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
  } catch (err) {
    args.host.logger?.warn?.(
      `could not resolve AgentRuntime for ${args.providerLabel} task ${args.taskId} (defaulting): ${
        err instanceof Error ? err.message : String(err)
      }`,
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
  } catch (err) {
    args.host.logger?.warn?.(
      `could not resolve AgentRuntime "${String(args.runtimeId ?? 'default')}" for ${args.providerLabel} (defaulting): ${
        err instanceof Error ? err.message : String(err)
      }`,
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
  readonly runtimeId?: string | null;
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

  for (const { command, tolerateUnresolvedExit } of commands) {
    const { exitCode, output } = await runSandboxCommand(args.executor, command);
    if (setupCommandFailed(exitCode, tolerateUnresolvedExit)) {
      const scrubbed = scrubSandboxImageParameterSecrets(
        args.scrubOutput(output),
        profile,
      ).trim();
      throw new Error(
        `image parameter setup for ${args.providerLabel} task ${args.taskId} failed: exit_code ${exitCode}` +
          (scrubbed ? ` - ${scrubbed}` : ''),
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
  readonly runtimeId?: string | null;
  readonly logger?: SandboxHostLogger;
}): Promise<SandboxHostImageParameterProfile | null> {
  if (!args.host.provisionLookup.getTaskImageParameterProfile) return null;
  try {
    return (
      (await args.host.provisionLookup.getTaskImageParameterProfile(
        args.taskId,
        args.providerFamily,
        args.runtimeId ?? null,
      )) ??
      null
    );
  } catch (err) {
    args.logger?.warn?.(
      `task ${args.taskId}: could not resolve image parameters (skipping): ${
        err instanceof Error ? err.message : String(err)
      }`,
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
        args.scrubOutput(error instanceof Error ? error.message : String(error)),
    );
  }
  const key = args.runtimeId === 'claude' ? 'claude-code' : args.runtimeId;
  if ((key === 'codex' || key === 'claude-code') && !metadata.dependencies[key]) {
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
  } catch (err) {
    args.host.logger?.warn?.(
      `task ${args.taskId}: could not resolve selected skills (skipping preinstall): ${
        err instanceof Error ? err.message : String(err)
      }`,
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
      const { exitCode, output } = await args.executor.exec({
        command,
        timeoutMs: AIO_SANDBOX_SKILL_INSTALL_TIMEOUT_MS,
      });
      if (exitCode !== 0) {
        const scrubbed = scrubAioExecSecrets(output);
        args.host.logger?.warn?.(
          `task ${args.taskId}: skill "${id}" (${installer.label}) installer exit_code ${exitCode} - degrading (runtime launches without it)` +
            (scrubbed ? ` - ${scrubbed.trim().slice(0, 300)}` : ''),
        );
        continue;
      }
      args.host.logger?.debug?.(
        `task ${args.taskId}: preinstalled skill "${id}" (${installer.label})`,
      );
    } catch (err) {
      args.host.logger?.warn?.(
        `task ${args.taskId}: skill "${id}" (${installer.label}) preinstall failed/timed out - degrading (runtime launches without it): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function captureAndPersistAioCodexAuth<
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
  if (!args.host.codexAuthSource) return;
  try {
    const runtime = await resolveRuntime({
      host: args.host,
      taskId: args.taskId,
      providerLabel: 'AIO',
    });
    if (runtime && runtime.id !== 'codex') return;
    const res = await runSandboxCommand(
      args.executor,
      'cat /home/gem/.codex/auth.json 2>/dev/null',
    );
    if (res.exitCode !== 0) return;
    const authJson = res.output.trim();
    if (!authJson) return;
    await args.host.codexAuthSource.persistRefreshedAuth(
      args.taskId,
      authJson,
    );
  } catch (err) {
    args.host.logger?.warn?.(
      `codex auth refresh-persist skipped for ${args.taskId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
    await runTrimCommandBestEffort({
      executor: args.executor,
      taskId: args.taskId,
      command,
      logger: args.host.logger,
    });
  }
}

async function runTrimCommandBestEffort(args: {
  readonly executor: SandboxCommandExecutor;
  readonly taskId: string;
  readonly command: string;
  readonly logger?: SandboxHostLogger;
}): Promise<void> {
  try {
    const result = await args.executor.exec({
      command: args.command,
      timeoutMs: AIO_SANDBOX_TRIM_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      args.logger?.warn?.(
        `pre-stop HOME trim for task ${args.taskId} exited ${result.exitCode} (not fatal)`,
      );
    }
  } catch (err) {
    args.logger?.warn?.(
      `pre-stop HOME trim for task ${args.taskId} failed (not fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
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
  if (runtime.readTranscriptSource.kind !== 'single-newest-jsonl') {
    return null;
  }

  const { dir, filenameGlob } = runtime.transcriptArtifact({
    taskId: args.taskId,
    workspaceDir: AIO_SANDBOX_WORKSPACE_DIR,
    sessionId: args.host.sessionIdForTask?.(args.taskId),
  });
  const jsonl = await args.controller.readSingleNewestJsonl(
    args.taskId,
    dir,
    filenameGlob,
  );
  if (jsonl === null) return null;
  return createTranscriptSource(args.host, {
    format: runtime.transcriptFormat,
    jsonl,
  });
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
  if (runtime.readTranscriptSource.kind !== 'single-newest-jsonl') {
    return null;
  }

  const { dir, filenameGlob } = runtime.transcriptArtifact({
    taskId: args.taskId,
    workspaceDir: args.workspacePath,
    sessionId: args.host.sessionIdForTask?.(args.taskId),
  });
  const jsonl = await readBoxLiteSingleNewestJsonl(
    args.executor,
    dir,
    filenameGlob,
  );
  if (jsonl === null) return null;
  return createTranscriptSource(args.host, {
    format: runtime.transcriptFormat,
    jsonl,
  });
}

async function readBoxLiteSingleNewestJsonl(
  executor: SandboxCommandExecutor,
  dir: string,
  filenameGlob: RegExp,
): Promise<string | null> {
  const listed = await executor.exec({
    command: `find ${shellQuote(dir)} -type f -print`,
  });
  if (listed.exitCode !== 0) return null;
  const paths = (listed.stdout || listed.output)
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((path) => {
      filenameGlob.lastIndex = 0;
      return filenameGlob.test(path);
    })
    .sort((left, right) => left.localeCompare(right));
  const newest = paths.at(-1);
  if (!newest) return null;
  const read = await executor.exec({ command: `cat ${shellQuote(newest)}` });
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
  readonly modelIntent: import('@cap/sandbox-core').TaskModelIntent;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly runtimeId?: string | null;
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
