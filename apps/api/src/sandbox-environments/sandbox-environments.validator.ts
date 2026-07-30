import Docker from 'dockerode';
import { Injectable, Logger } from '@nestjs/common';
import type {
  Runtime,
  SandboxEnvironmentResources,
  SandboxMetadata,
  SandboxEnvironmentSource,
  SandboxEnvironmentValidation,
} from '@cap-console/contracts';
import {
  SANDBOX_METADATA_PATH,
  parseSandboxMetadataText,
} from '@cap-console/contracts';
import {
  AIO_SANDBOX_WORKSPACE_DIR,
  AioSandboxContainerController,
  BOXLITE_TERMINAL_BYTE_BRIDGE_PROBE_COMMAND,
  BoxLiteRestClient,
  createNonPersistingSandboxProvisioningDiagnosticObserver,
  readBoxLiteProviderConfig,
  readBoxLiteRuntimeRequiredTools,
  requiredToolsForBoxLiteCapabilities,
  resolveConfiguredProviderProvisioningPolicyForFamily,
  sourceChecksum,
  sourceDigest,
  sourceReference,
  validateAioEnvironment,
  validateBoxLiteEnvironment,
  type AioDockerClient,
  type AioEnvironmentValidationCommand,
  type BoxLiteEnvironmentValidationCommand,
  type SandboxEnvironmentProviderFamily,
  type SandboxPreflightProbeResult,
  type SandboxResolvedEnvironmentMetadata,
} from '@cap-console/sandbox';

export const SANDBOX_ENVIRONMENT_VALIDATION_RUNNER = Symbol(
  'SANDBOX_ENVIRONMENT_VALIDATION_RUNNER',
);

export interface SandboxEnvironmentValidationTarget {
  readonly id: string;
  readonly name: string;
  readonly source: SandboxEnvironmentSource;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly resources?: SandboxEnvironmentResources | null;
  /** Runtime ids whose concrete CLI artifacts must be verified in this image. */
  readonly runtimeIds?: readonly string[];
  /** @deprecated Single-runtime compatibility input. */
  readonly runtimeId?: string | null;
  readonly contractVersion?: string | null;
}

export interface SandboxEnvironmentValidationOutcome {
  readonly status: SandboxEnvironmentValidation['status'];
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string | null;
  readonly sourceKind: string;
  readonly resolvedLocator?: string | null;
  readonly resolvedDigest?: string | null;
  readonly resolvedChecksum?: string | null;
  readonly runtimeArtifactChecksums?: Readonly<Record<string, string>> | null;
  readonly cliArtifactChecksum?: string | null;
  readonly sandboxMetadata?: SandboxMetadata | null;
  readonly resourceSnapshot?: SandboxEnvironmentResources | null;
  readonly probes?: readonly SandboxPreflightProbeResult[];
  readonly error?: string | null;
}

export interface SandboxEnvironmentValidationRunner {
  resolveImmutableTarget?(
    target: SandboxEnvironmentValidationTarget,
  ): Promise<SandboxEnvironmentValidationTarget>;
  validate(
    target: SandboxEnvironmentValidationTarget,
  ): Promise<SandboxEnvironmentValidationOutcome>;
}

@Injectable()
export class DefaultSandboxEnvironmentValidationRunner
  implements SandboxEnvironmentValidationRunner
{
  private readonly logger = new Logger(
    DefaultSandboxEnvironmentValidationRunner.name,
  );

  async resolveImmutableTarget(
    target: SandboxEnvironmentValidationTarget,
  ): Promise<SandboxEnvironmentValidationTarget> {
    if (target.providerFamily === 'aio') {
      const controller = new AioSandboxContainerController({
        docker: new Docker() as unknown as AioDockerClient,
      });
      const resolved = await controller.resolveImageIdentity(
        sourceReference(target.source),
      );
      return {
        ...target,
        source: {
          ...target.source,
          image: resolved.locator,
          digest: resolved.digest,
        },
      };
    }
    if (target.providerFamily === 'boxlite') {
      const reference = sourceReference(target.source);
      const separator = reference.lastIndexOf('@');
      const qualifiedDigest =
        separator >= 0 ? reference.slice(separator + 1) : null;
      const digest = sourceDigest(target.source) ?? qualifiedDigest;
      if (!digest?.startsWith('sha256:')) {
        throw new Error(
          'BoxLite deployment image requires a digest-qualified reference.',
        );
      }
      const locator = reference.endsWith(`@${digest}`)
        ? reference
        : `${reference.split('@', 1)[0]}@${digest}`;
      return {
        ...target,
        source: { ...target.source, image: locator, digest },
      };
    }
    throw new Error('Deployment provider cannot resolve an immutable source.');
  }

  async validate(
    target: SandboxEnvironmentValidationTarget,
  ): Promise<SandboxEnvironmentValidationOutcome> {
    let provisioningPolicy;
    try {
      provisioningPolicy =
        resolveConfiguredProviderProvisioningPolicyForFamily({
          providerFamily: target.providerFamily,
          resources: target.resources,
        });
    } catch (error) {
      return failedOutcome(
        target,
        error instanceof Error ? error.message : String(error),
      );
    }
    target = Object.freeze({
      ...target,
      resources: provisioningPolicy.resources ?? Object.freeze({}),
    });
    const environment = toResolvedEnvironment(
      target,
      provisioningPolicy.resources,
    );
    const runtimeIds = validationRuntimeIds(target);
    if (target.providerFamily === 'aio') {
      const controller = new AioSandboxContainerController({
        docker: new Docker() as unknown as AioDockerClient,
      });
      const result = await validateAioEnvironment({
        environment,
        controller,
        diagnostics:
          createNonPersistingSandboxProvisioningDiagnosticObserver(),
        requiredCommands: requiredAioCommands(runtimeIds),
        onCleanupError: () =>
          this.logger.error('AIO environment probe cleanup failed.'),
      });
      return normalizeProviderOutcome(target, result);
    }
    if (target.providerFamily === 'boxlite') {
      const configResult = readBoxLiteProviderConfig();
      if (configResult.status !== 'valid') {
        const error =
          configResult.status === 'disabled'
            ? configResult.reason
            : configResult.errors.join('; ');
        return failedOutcome(target, error);
      }
      const client = new BoxLiteRestClient({
        baseUrl: configResult.config.endpoint,
        apiToken: configResult.config.apiToken,
        timeoutMs: configResult.config.timeoutMs,
        protocolMode: configResult.config.protocolMode,
        pathPrefix: configResult.config.pathPrefix,
      });
      const result = await validateBoxLiteEnvironment({
        environment,
        client,
        diagnostics:
          createNonPersistingSandboxProvisioningDiagnosticObserver(),
        workspacePath: configResult.config.workspacePath,
        requiredCommands: requiredBoxLiteCommands({
          runtimeIds,
          workspacePath: configResult.config.workspacePath,
          requiredTools: [
            ...requiredToolsForBoxLiteCapabilities(
              configResult.config.capabilities,
            ),
            ...readBoxLiteRuntimeRequiredTools(),
          ],
          requireTerminalByteBridge:
            configResult.config.protocolMode === 'native' &&
            (configResult.config.capabilities.includes('terminal.websocket') ||
              configResult.config.capabilities.includes(
                'terminal.interactive',
              )),
        }),
        onCleanupError: () =>
          this.logger.error('BoxLite environment probe cleanup failed.'),
      });
      return normalizeProviderOutcome(target, result);
    }
    return failedOutcome(
      target,
      `Unsupported sandbox environment provider family: ${target.providerFamily}`,
    );
  }
}

function normalizeProviderOutcome(
  target: SandboxEnvironmentValidationTarget,
  result: {
    readonly status: 'passed' | 'failed';
    readonly providerFamily: SandboxEnvironmentProviderFamily;
    readonly sourceKind?: string;
    readonly resolvedLocator?: string;
    readonly resolvedDigest?: string;
    readonly resolvedChecksum?: string;
    readonly resourceSnapshot?: SandboxEnvironmentResources;
    readonly probes?: readonly SandboxPreflightProbeResult[];
    readonly error?: string;
  },
): SandboxEnvironmentValidationOutcome {
  if (result.status === 'passed') {
    try {
      const sandboxMetadata = metadataFromProbes(result.probes ?? []);
      const runtimeIds = validationRuntimeIds(target);
      assertRuntimesDeclared(runtimeIds, sandboxMetadata);
      const runtimeArtifactChecksums = runtimeArtifactChecksumsFromProbes(
        runtimeIds,
        result.probes ?? [],
      );
      const cliArtifactChecksum =
        runtimeIds.length === 1
          ? runtimeArtifactChecksums[runtimeIds[0]!]
          : null;
      return {
        status: result.status,
        providerFamily: result.providerFamily,
        runtimeId: target.runtimeId ?? null,
        sourceKind: result.sourceKind ?? target.source.kind,
        resolvedLocator: result.resolvedLocator ?? null,
        resolvedDigest: result.resolvedDigest ?? sourceDigest(target.source) ?? null,
        resolvedChecksum: result.resolvedChecksum ?? sourceChecksum(target.source) ?? null,
        runtimeArtifactChecksums,
        cliArtifactChecksum,
        sandboxMetadata,
        resourceSnapshot: result.resourceSnapshot ?? target.resources ?? null,
        probes: result.probes,
        error: null,
      };
    } catch (error) {
      const message = `sandbox metadata validation failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        ...failedOutcome(target, message),
        resourceSnapshot: result.resourceSnapshot ?? target.resources ?? null,
        resolvedLocator: result.resolvedLocator ?? null,
        resolvedDigest: result.resolvedDigest ?? sourceDigest(target.source) ?? null,
        resolvedChecksum: result.resolvedChecksum ?? sourceChecksum(target.source) ?? null,
        probes: [
          ...(result.probes ?? []),
          { name: 'sandbox-metadata-validation', ok: false, output: message },
        ],
      };
    }
  }
  return {
    status: result.status,
    providerFamily: result.providerFamily,
    runtimeId: target.runtimeId ?? null,
    sourceKind: result.sourceKind ?? target.source.kind,
    resolvedLocator: result.resolvedLocator ?? null,
    resolvedDigest: result.resolvedDigest ?? sourceDigest(target.source) ?? null,
    resolvedChecksum: result.resolvedChecksum ?? sourceChecksum(target.source) ?? null,
    runtimeArtifactChecksums: null,
    cliArtifactChecksum: null,
    sandboxMetadata: null,
    resourceSnapshot: result.resourceSnapshot ?? target.resources ?? null,
    probes: result.probes,
    error: result.error ?? null,
  };
}

export function metadataFromProbes(
  probes: readonly SandboxPreflightProbeResult[],
): SandboxMetadata {
  const probe = probes.find((candidate) => candidate.name === 'sandbox-metadata');
  if (!probe?.ok || !probe.output) {
    throw new Error(`${SANDBOX_METADATA_PATH} is missing or unreadable`);
  }
  return parseSandboxMetadataText(probe.output.trim());
}

export function assertRuntimeDeclared(
  runtimeId: string | null | undefined,
  metadata: SandboxMetadata,
) {
  if (runtimeId === null || runtimeId === undefined) return;
  const runtime = asRuntime(runtimeId);
  if (runtime === null) {
    // FAIL CLOSED. The previous guard only ran for the two ids it named, so an
    // unrecognised runtime skipped image validation entirely and provisioned
    // against an image that never declared it.
    throw new Error(
      `selected runtime "${runtimeId}" is not a runtime this deployment knows; its image dependency cannot be verified`,
    );
  }
  if (!metadata.dependencies[runtime]) {
    throw new Error(`selected runtime dependency ${runtime} is not declared`);
  }
}

export function assertRuntimesDeclared(
  runtimeIds: readonly string[],
  metadata: SandboxMetadata,
): void {
  for (const runtimeId of runtimeIds) assertRuntimeDeclared(runtimeId, metadata);
}

export function runtimeArtifactChecksumsFromProbes(
  runtimeIds: readonly string[],
  probes: readonly SandboxPreflightProbeResult[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    runtimeIds.map((runtimeId) => [
      normalizeRuntimeId(runtimeId),
      requireRuntimeArtifactChecksum(runtimeId, probes),
    ]),
  );
}

export function runtimeArtifactChecksumFromProbes(
  runtimeId: string | null | undefined,
  probes: readonly SandboxPreflightProbeResult[],
): string | null {
  if (runtimeId === null || runtimeId === undefined) return null;
  if (asRuntime(runtimeId) === null) {
    throw new Error(
      `no runtime artifact checksum is defined for runtime "${runtimeId}"`,
    );
  }
  return requireRuntimeArtifactChecksum(runtimeId, probes);
}

function requireRuntimeArtifactChecksum(
  runtimeId: string,
  probes: readonly SandboxPreflightProbeResult[],
): string {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  const probe =
    probes.find(
      (candidate) =>
        candidate.name === `runtime-artifact-checksum:${normalizedRuntimeId}`,
    ) ??
    probes.find((candidate) => candidate.name === 'runtime-artifact-checksum');
  const digest = probe?.ok ? probe.output?.trim() : undefined;
  if (!digest || !/^[a-f0-9]{64}$/i.test(digest)) {
    throw new Error(`selected runtime artifact checksum is unavailable`);
  }
  return `sha256:${digest.toLowerCase()}`;
}

function toResolvedEnvironment(
  target: SandboxEnvironmentValidationTarget,
  resources?: SandboxEnvironmentResources,
): SandboxResolvedEnvironmentMetadata {
  return {
    id: target.id,
    environmentId: target.id,
    name: target.name,
    providerFamily: target.providerFamily,
    runtimeId:
      validationRuntimeIds(target).length === 1
        ? validationRuntimeIds(target)[0]
        : undefined,
    sourceKind: target.source.kind,
    sourceRef: sourceReference(target.source),
    digest: sourceDigest(target.source),
    checksum: sourceChecksum(target.source),
    contractVersion: target.contractVersion ?? undefined,
    resources,
  };
}

function failedOutcome(
  target: SandboxEnvironmentValidationTarget,
  error: string,
): SandboxEnvironmentValidationOutcome {
  return {
    status: 'failed',
    providerFamily: target.providerFamily,
    runtimeId: target.runtimeId ?? null,
    sourceKind: target.source.kind,
    resolvedLocator: null,
    resolvedDigest: sourceDigest(target.source) ?? null,
    resolvedChecksum: sourceChecksum(target.source) ?? null,
    runtimeArtifactChecksums: null,
    cliArtifactChecksum: null,
    sandboxMetadata: null,
    resourceSnapshot: target.resources ?? null,
    probes: [{ name: 'validation-error', ok: false, output: error }],
    error,
  };
}

function requiredAioCommands(
  runtimeIds: readonly string[],
): readonly AioEnvironmentValidationCommand[] {
  return [
    { name: 'sandbox-metadata', command: `cat ${SANDBOX_METADATA_PATH}` },
    { name: 'workspace-path', command: `test -d ${AIO_SANDBOX_WORKSPACE_DIR}` },
    { name: 'shell', command: 'command -v sh' },
    { name: 'git', command: 'command -v git' },
    ...runtimeCommands(runtimeIds),
  ];
}

export function requiredBoxLiteCommands(args: {
  readonly runtimeIds: readonly string[];
  readonly workspacePath: string;
  readonly requiredTools: readonly string[];
  readonly requireTerminalByteBridge: boolean;
}): readonly BoxLiteEnvironmentValidationCommand[] {
  const commands: BoxLiteEnvironmentValidationCommand[] = [
    { name: 'sandbox-metadata', command: `cat ${SANDBOX_METADATA_PATH}` },
    { name: 'workspace-path', command: `test -d ${args.workspacePath}` },
    { name: 'shell', command: 'command -v sh' },
    { name: 'git', command: 'command -v git' },
    ...runtimeCommands(args.runtimeIds),
    ...[...new Set(args.requiredTools)].sort().map((tool) => ({
      name: `required-tool:${tool}`,
      command: requiredToolCommand(tool),
    })),
  ];
  if (args.requireTerminalByteBridge) {
    commands.push({
      name: 'terminal-byte-bridge',
      command: BOXLITE_TERMINAL_BYTE_BRIDGE_PROBE_COMMAND,
    });
  }
  return commands.filter(
    (command, index) =>
      commands.findIndex((candidate) => candidate.command === command.command) ===
      index,
  );
}

function requiredToolCommand(tool: string): string {
  if (!/^[A-Za-z0-9._+-]+$/.test(tool)) {
    throw new Error(`Invalid BoxLite required tool name: ${tool}`);
  }
  return `command -v ${tool}`;
}

/**
 * The image preflight each runtime requires, as a TOTAL mapping over the closed
 * runtime union: the CLI that must be on PATH, and the artifact-checksum probe
 * that pins WHICH build of it is installed.
 *
 * Previously an if-chain ending in `return []`. That was the worst possible
 * shape for this decision: an unrecognised runtime produced NO probes at all, so
 * the environment validated as healthy and the real failure surfaced much later
 * as an operational error with nothing connecting it to the omission. Keyed on
 * `Record<Runtime, …>`, adding an id is a compile error here.
 */
const RUNTIME_PREFLIGHT_COMMANDS: Record<
  Runtime,
  { readonly probeName: string; readonly executable: string }
> = {
  codex: { probeName: 'codex-runtime', executable: 'codex' },
  'claude-code': { probeName: 'claude-runtime', executable: 'claude' },
};

function runtimeCommands(
  runtimeIds: readonly string[],
): readonly AioEnvironmentValidationCommand[] {
  const multiRuntime = runtimeIds.length > 1;
  return runtimeIds.flatMap((runtimeId) => {
    const runtime = asRuntime(runtimeId);
    if (runtime === null) {
      // FAIL CLOSED. Returning no probes would let an image validate without
      // ever proving the runtime is installed in it.
      throw new Error(
        `no image preflight is defined for runtime "${runtimeId}"; an environment cannot be validated for a runtime whose artifacts are unknown`,
      );
    }
    const { probeName, executable } = RUNTIME_PREFLIGHT_COMMANDS[runtime];
    return [
      { name: probeName, command: `command -v ${executable}` },
      {
        name: multiRuntime
          ? `runtime-artifact-checksum:${runtime}`
          : 'runtime-artifact-checksum',
        command: `node /usr/local/bin/runtime-artifact-checksum.mjs ${runtime}`,
      },
    ];
  });
}

/** Every runtime CAP knows about — derived from the preflight mapping, never re-listed. */
const CAP_RUNTIME_IDS = Object.keys(RUNTIME_PREFLIGHT_COMMANDS) as readonly Runtime[];

function validationRuntimeIds(
  target: SandboxEnvironmentValidationTarget,
): readonly string[] {
  const requested =
    target.runtimeIds ??
    (target.runtimeId ? [target.runtimeId] : CAP_RUNTIME_IDS);
  return [...new Set(requested.map(normalizeRuntimeId))].sort();
}

/**
 * Historical spellings a caller may still present, mapped to the canonical id.
 * A table rather than a comparison: an alias is DATA, and expressing it as a
 * branch is indistinguishable from a decision keyed on which agent is running.
 */
const RUNTIME_ID_ALIASES: Readonly<Record<string, Runtime>> = { claude: 'claude-code' };

function normalizeRuntimeId(runtimeId: string): string {
  return RUNTIME_ID_ALIASES[runtimeId] ?? runtimeId;
}

/** Narrow a presented id to the closed union, or `null` when it is not one. */
function asRuntime(runtimeId: string | null | undefined): Runtime | null {
  if (typeof runtimeId !== 'string') return null;
  const normalized = normalizeRuntimeId(runtimeId);
  return normalized in RUNTIME_PREFLIGHT_COMMANDS ? (normalized as Runtime) : null;
}
