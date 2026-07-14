import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { Injectable, Logger } from '@nestjs/common';
import type {
  SandboxMetadata,
  SandboxEnvironmentSource,
  SandboxEnvironmentValidation,
} from '@cap/contracts';
import {
  SANDBOX_METADATA_PATH,
  parseSandboxMetadataText,
} from '@cap/contracts';
import {
  AIO_SANDBOX_WORKSPACE_DIR,
  AioSandboxContainerController,
  BoxLiteRestClient,
  readBoxLiteProviderConfig,
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
} from '@cap/sandbox';

export const SANDBOX_ENVIRONMENT_VALIDATION_RUNNER = Symbol(
  'SANDBOX_ENVIRONMENT_VALIDATION_RUNNER',
);

export interface SandboxEnvironmentValidationTarget {
  readonly id: string;
  readonly name: string;
  readonly source: SandboxEnvironmentSource;
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  /** Runtime ids whose concrete CLI artifacts must be verified in this image. */
  readonly runtimeIds?: readonly string[];
  /** @deprecated Single-runtime compatibility input. */
  readonly runtimeId?: string | null;
  readonly probeTaskId?: string;
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
    const environment = toResolvedEnvironment(target);
    const runtimeIds = validationRuntimeIds(target);
    if (target.providerFamily === 'aio') {
      const controller = new AioSandboxContainerController({
        docker: new Docker() as unknown as AioDockerClient,
      });
      const result = await validateAioEnvironment({
        taskId: target.probeTaskId ?? buildProbeTaskId(),
        environment,
        controller,
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
        taskId: target.probeTaskId ?? buildProbeTaskId(),
        environment,
        client,
        workspacePath: configResult.config.workspacePath,
        requiredCommands: requiredBoxLiteCommands({
          runtimeIds,
          workspacePath: configResult.config.workspacePath,
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
        probes: result.probes,
        error: null,
      };
    } catch (error) {
      const message = `sandbox metadata validation failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        ...failedOutcome(target, message),
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
  const key = runtimeId === 'claude' ? 'claude-code' : runtimeId;
  if ((key === 'codex' || key === 'claude-code') && !metadata.dependencies[key]) {
    throw new Error(`selected runtime dependency ${key} is not declared`);
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
  if (runtimeId !== 'codex' && runtimeId !== 'claude-code' && runtimeId !== 'claude') {
    return null;
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

function requiredBoxLiteCommands(args: {
  readonly runtimeIds: readonly string[];
  readonly workspacePath: string;
}): readonly BoxLiteEnvironmentValidationCommand[] {
  return [
    { name: 'sandbox-metadata', command: `cat ${SANDBOX_METADATA_PATH}` },
    { name: 'workspace-path', command: `test -d ${args.workspacePath}` },
    { name: 'shell', command: 'command -v sh' },
    { name: 'git', command: 'command -v git' },
    ...runtimeCommands(args.runtimeIds),
  ];
}

function runtimeCommands(
  runtimeIds: readonly string[],
): readonly AioEnvironmentValidationCommand[] {
  const multiRuntime = runtimeIds.length > 1;
  return runtimeIds.flatMap((runtimeId) => {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (normalizedRuntimeId === 'codex') {
      return [
        { name: 'codex-runtime', command: 'command -v codex' },
        {
          name: multiRuntime
            ? 'runtime-artifact-checksum:codex'
            : 'runtime-artifact-checksum',
          command: 'node /usr/local/bin/runtime-artifact-checksum.mjs codex',
        },
      ];
    }
    if (normalizedRuntimeId === 'claude-code') {
      return [
        { name: 'claude-runtime', command: 'command -v claude' },
        {
          name: multiRuntime
            ? 'runtime-artifact-checksum:claude-code'
            : 'runtime-artifact-checksum',
          command:
            'node /usr/local/bin/runtime-artifact-checksum.mjs claude-code',
        },
      ];
    }
    return [];
  });
}

const CAP_RUNTIME_IDS = ['codex', 'claude-code'] as const;

function validationRuntimeIds(
  target: SandboxEnvironmentValidationTarget,
): readonly string[] {
  const requested =
    target.runtimeIds ??
    (target.runtimeId ? [target.runtimeId] : CAP_RUNTIME_IDS);
  return [...new Set(requested.map(normalizeRuntimeId))].sort();
}

function normalizeRuntimeId(runtimeId: string): string {
  return runtimeId === 'claude' ? 'claude-code' : runtimeId;
}

function buildProbeTaskId(): string {
  return `env-probe-${randomUUID()}`;
}
