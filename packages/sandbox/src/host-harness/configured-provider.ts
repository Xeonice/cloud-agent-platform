import type {
  GitCloneSpec,
  SandboxCommandExecutor,
  SandboxCommandExecutionResult,
  SandboxPreflightResult,
  SandboxProviderDescriptor,
  SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import { scrubSandboxCommandOutput } from '@cap/sandbox-core';
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
import {
  SandboxProviderRouter,
  type RoutableSandboxProvider,
} from '../provider-center/router.js';
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
  const providers: SandboxProviderDescriptor<
    HarnessRoutableSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>
  >[] = [];

  if (providerFamilyAllowsAio(providerFamily)) {
    providers.push(createAioProviderDescriptor(host));
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
    providers.push(
      defineBoxLiteSandboxProvider<TCloneSpec, TRuntimeId, TTranscriptSource>({
        config: boxlite.config,
        preflight: createBoxLiteRuntimePreflight({
          requiredTools: mergeToolLists(
            requiredToolsForBoxLiteCapabilities(boxlite.config.capabilities),
            readBoxLiteRuntimeRequiredTools(),
          ),
          workspacePath: boxlite.config.workspacePath,
        }),
        runtimeSetup: ({ taskId, executor, workspacePath }) =>
          runBoxLiteRuntimeSetup({
            taskId,
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
      }),
    );
  }

  return new SandboxProviderRouter<TCloneSpec, TRuntimeId, TTranscriptSource>(
    providers,
    {
      preferLocation: readSandboxLocationEnv('CAP_SANDBOX_PREFER_LOCATION'),
      explicitProviderFamily: explicitProviderFamilyLabel(providerFamily),
      ownerStore: host.ownerStore,
    },
  );
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
        getCloneSpec: (taskId) => host.provisionLookup.getCloneSpec(taskId),
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
        await runRuntimePreflight({
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
        };
      },
      runtimeSetup: async ({ taskId, executor, runtimeId }) => {
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
          await runRuntimeSetup({
            executor,
            taskId,
            runtime,
            workspaceDir: AIO_SANDBOX_WORKSPACE_DIR,
            host,
            logger: host.logger,
            providerLabel: 'AIO',
            scrubOutput: scrubAioExecSecrets,
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
  return (
    args.provisionRuntimes.get(args.taskId) ??
    resolveRuntimeFromId({
      host: args.host,
      runtimeId: args.runtimeId,
      providerLabel: args.providerLabel,
    })
  );
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
}): Promise<void> {
  const probes = args.runtime.preflightProbes();
  if (probes.length === 0) return;

  for (const probe of probes) {
    const { exitCode, output } = await runSandboxCommand(
      args.executor,
      probe.command,
    );
    if (exitCode !== 0) {
      const scrubbed = args.scrubOutput(output).trim();
      throw new Error(
        `runtime "${args.runtime.id}" preflight for task ${args.taskId} failed: ` +
          `${probe.name} (${probe.command}) exit_code ${exitCode}` +
          (scrubbed ? ` - ${scrubbed}` : ''),
      );
    }
  }
  args.logger?.debug?.(
    `runtime "${args.runtime.id}" ${args.providerLabel} preflight passed for task ${args.taskId} (${probes.length} probe(s))`,
  );
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
  readonly scrubOutput: (output: string) => string;
}): Promise<void> {
  const [material, prompt] = await Promise.all([
    args.host.materialResolvers.resolve(args.runtime, {
      taskId: args.taskId,
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

  for (const { command, tolerateUnresolvedExit } of plan.commands) {
    const { exitCode, output } = await runSandboxCommand(args.executor, command);
    if (setupCommandFailed(exitCode, tolerateUnresolvedExit)) {
      const scrubbed = args.scrubOutput(output).trim();
      throw new Error(
        `runtime "${args.runtime.id}" setup for task ${args.taskId} failed: exit_code ${exitCode}` +
          (scrubbed ? ` - ${scrubbed}` : ''),
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

async function runBoxLiteRuntimeSetup<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
  TAuthMaterial,
>(args: {
  readonly taskId: string;
  readonly executor: SandboxCommandExecutor;
  readonly workspacePath: string;
  readonly host: SandboxHostHarness<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource,
    TAuthMaterial
  >;
}): Promise<void> {
  const runtime = await resolveProvisionRuntime({
    host: args.host,
    taskId: args.taskId,
    providerLabel: 'BoxLite',
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
  await runRuntimeSetup({
    executor: args.executor,
    taskId: args.taskId,
    runtime,
    workspaceDir: args.workspacePath,
    host: args.host,
    logger: args.host.logger,
    providerLabel: 'BoxLite',
    scrubOutput: scrubSandboxCommandOutput,
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
