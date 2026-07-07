import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { Injectable } from '@nestjs/common';
import type {
  SandboxEnvironmentSource,
  SandboxEnvironmentValidation,
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
  return {
    status: result.status,
    providerFamily: result.providerFamily,
    runtimeId: target.runtimeId ?? null,
    sourceKind: result.sourceKind ?? target.source.kind,
    resolvedDigest: result.resolvedDigest ?? sourceDigest(target.source) ?? null,
    resolvedChecksum: result.resolvedChecksum ?? sourceChecksum(target.source) ?? null,
    probes: result.probes,
    error: result.error ?? null,
  };
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
    probes: [{ name: 'validation-error', ok: false, output: error }],
    error,
  };
}

function requiredAioCommands(
  runtimeId: string | null | undefined,
): readonly AioEnvironmentValidationCommand[] {
  return [
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
