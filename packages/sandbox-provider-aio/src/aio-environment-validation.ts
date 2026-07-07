import type {
  SandboxPreflightProbeResult,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox-core';
import type { AioSandboxContainerController } from './aio-provider-controller.js';

export interface AioEnvironmentValidationCommand {
  readonly name: string;
  readonly command: string;
}

export interface AioEnvironmentValidationResult {
  readonly status: 'passed' | 'failed';
  readonly providerFamily: 'aio';
  readonly sourceKind: string | undefined;
  readonly resolvedDigest?: string;
  readonly probes: readonly SandboxPreflightProbeResult[];
  readonly error?: string;
}

export async function validateAioEnvironment(args: {
  readonly taskId?: string;
  readonly environment: SandboxResolvedEnvironmentMetadata;
  readonly controller: AioSandboxContainerController;
  readonly requiredCommands?: readonly AioEnvironmentValidationCommand[];
}): Promise<AioEnvironmentValidationResult> {
  const taskId = args.taskId ?? `env-probe-${Date.now()}`;
  const probes: SandboxPreflightProbeResult[] = [];
  const sourceKind = args.environment.sourceKind;

  try {
    if (sourceKind !== 'aio-docker-image') {
      throw new Error(`AIO cannot validate environment source ${sourceKind ?? 'unknown'}`);
    }
    const provisioned = await args.controller.createAndStart(taskId, args.environment);
    probes.push({
      name: 'create-container',
      ok: true,
      output: provisioned.spec.image,
    });
    await args.controller.waitForReadiness({
      baseUrl: provisioned.connection.baseUrl,
      taskId,
      timeoutMs: provisioned.spec.readinessTimeoutMs,
    });
    probes.push({
      name: 'http-ready',
      ok: true,
      command: 'GET /v1/docs',
    });
    for (const probe of args.requiredCommands ?? []) {
      const result = await args.controller.runSandboxExec(
        provisioned.connection.baseUrl,
        probe.command,
      );
      const ok = result.exitCode === 0;
      probes.push({
        name: probe.name,
        command: probe.command,
        ok,
        output: result.output,
      });
      if (!ok) {
        throw new Error(
          `AIO environment probe ${probe.name} failed with exit_code ${result.exitCode}`,
        );
      }
    }
    return {
      status: 'passed',
      providerFamily: 'aio',
      sourceKind,
      resolvedDigest: args.environment.digest,
      probes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (probes.length === 0 || probes.at(-1)?.ok !== false) {
      probes.push({ name: 'validation-error', ok: false, output: message });
    }
    return {
      status: 'failed',
      providerFamily: 'aio',
      sourceKind,
      resolvedDigest: args.environment.digest,
      probes,
      error: message,
    };
  } finally {
    await args.controller.removeSandbox(taskId).catch(() => undefined);
  }
}
