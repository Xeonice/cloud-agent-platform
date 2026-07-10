import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { Injectable } from '@nestjs/common';
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
  readonly runtimeId?: string | null;
  readonly contractVersion?: string | null;
}

export interface SandboxEnvironmentValidationOutcome {
  readonly status: SandboxEnvironmentValidation['status'];
  readonly providerFamily: SandboxEnvironmentProviderFamily;
  readonly runtimeId?: string | null;
  readonly sourceKind: string;
  readonly resolvedDigest?: string | null;
  readonly resolvedChecksum?: string | null;
  readonly sandboxMetadata?: SandboxMetadata | null;
  readonly probes?: readonly SandboxPreflightProbeResult[];
  readonly error?: string | null;
}

export interface SandboxEnvironmentValidationRunner {
  validate(
    target: SandboxEnvironmentValidationTarget,
  ): Promise<SandboxEnvironmentValidationOutcome>;
}

@Injectable()
export class DefaultSandboxEnvironmentValidationRunner
  implements SandboxEnvironmentValidationRunner
{
  async validate(
    target: SandboxEnvironmentValidationTarget,
  ): Promise<SandboxEnvironmentValidationOutcome> {
    const environment = toResolvedEnvironment(target);
    if (target.providerFamily === 'aio') {
      const controller = new AioSandboxContainerController({
        docker: new Docker() as unknown as AioDockerClient,
      });
      const result = await validateAioEnvironment({
        taskId: buildProbeTaskId(),
        environment,
        controller,
        requiredCommands: requiredAioCommands(target.runtimeId),
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
        taskId: buildProbeTaskId(),
        environment,
        client,
        workspacePath: configResult.config.workspacePath,
        requiredCommands: requiredBoxLiteCommands({
          runtimeId: target.runtimeId,
          workspacePath: configResult.config.workspacePath,
        }),
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
    readonly resolvedDigest?: string;
    readonly resolvedChecksum?: string;
    readonly probes?: readonly SandboxPreflightProbeResult[];
    readonly error?: string;
  },
): SandboxEnvironmentValidationOutcome {
  if (result.status === 'passed') {
    try {
      const sandboxMetadata = metadataFromProbes(result.probes ?? []);
      assertRuntimeDeclared(target.runtimeId, sandboxMetadata);
      return {
        status: result.status,
        providerFamily: result.providerFamily,
        runtimeId: target.runtimeId ?? null,
        sourceKind: result.sourceKind ?? target.source.kind,
        resolvedDigest: result.resolvedDigest ?? sourceDigest(target.source) ?? null,
        resolvedChecksum: result.resolvedChecksum ?? sourceChecksum(target.source) ?? null,
        sandboxMetadata,
        probes: result.probes,
        error: null,
      };
    } catch (error) {
      const message = `sandbox metadata validation failed: ${error instanceof Error ? error.message : String(error)}`;
      return {
        ...failedOutcome(target, message),
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
    resolvedDigest: result.resolvedDigest ?? sourceDigest(target.source) ?? null,
    resolvedChecksum: result.resolvedChecksum ?? sourceChecksum(target.source) ?? null,
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

function toResolvedEnvironment(
  target: SandboxEnvironmentValidationTarget,
): SandboxResolvedEnvironmentMetadata {
  return {
    id: target.id,
    environmentId: target.id,
    name: target.name,
    providerFamily: target.providerFamily,
    runtimeId: target.runtimeId ?? undefined,
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
    resolvedDigest: sourceDigest(target.source) ?? null,
    resolvedChecksum: sourceChecksum(target.source) ?? null,
    sandboxMetadata: null,
    probes: [{ name: 'validation-error', ok: false, output: error }],
    error,
  };
}

function requiredAioCommands(
  runtimeId: string | null | undefined,
): readonly AioEnvironmentValidationCommand[] {
  return [
    { name: 'sandbox-metadata', command: `cat ${SANDBOX_METADATA_PATH}` },
    { name: 'workspace-path', command: `test -d ${AIO_SANDBOX_WORKSPACE_DIR}` },
    { name: 'shell', command: 'command -v sh' },
    { name: 'git', command: 'command -v git' },
    ...runtimeCommands(runtimeId),
  ];
}

function requiredBoxLiteCommands(args: {
  readonly runtimeId: string | null | undefined;
  readonly workspacePath: string;
}): readonly BoxLiteEnvironmentValidationCommand[] {
  return [
    { name: 'sandbox-metadata', command: `cat ${SANDBOX_METADATA_PATH}` },
    { name: 'workspace-path', command: `test -d ${args.workspacePath}` },
    { name: 'shell', command: 'command -v sh' },
    { name: 'git', command: 'command -v git' },
    ...runtimeCommands(args.runtimeId),
  ];
}

function runtimeCommands(
  runtimeId: string | null | undefined,
): readonly AioEnvironmentValidationCommand[] {
  if (!runtimeId) return [];
  if (runtimeId === 'codex') {
    return [{ name: 'codex-runtime', command: 'command -v codex' }];
  }
  if (runtimeId === 'claude-code' || runtimeId === 'claude') {
    return [{ name: 'claude-runtime', command: 'command -v claude' }];
  }
  return [];
}

function buildProbeTaskId(): string {
  return `env-probe-${randomUUID()}`;
}
