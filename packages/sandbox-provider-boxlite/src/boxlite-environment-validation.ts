import type {
  SandboxPreflightProbeResult,
  SandboxResolvedEnvironmentMetadata,
} from '@cap/sandbox-core';
import type { BoxLiteClient } from './boxlite-client.js';

export interface BoxLiteEnvironmentValidationResult {
  readonly status: 'passed' | 'failed';
  readonly providerFamily: 'boxlite';
  readonly sourceKind: string | undefined;
  readonly resolvedDigest?: string;
  readonly resolvedChecksum?: string;
  readonly probes: readonly SandboxPreflightProbeResult[];
  readonly error?: string;
}

export async function validateBoxLiteEnvironment(args: {
  readonly taskId?: string;
  readonly environment: SandboxResolvedEnvironmentMetadata;
  readonly client: BoxLiteClient;
  readonly workspacePath?: string;
  readonly requiredCommands?: readonly BoxLiteEnvironmentValidationCommand[];
}): Promise<BoxLiteEnvironmentValidationResult> {
  const taskId = args.taskId ?? `env-probe-${Date.now()}`;
  const sandboxId = `probe-${taskId}`;
  const probes: SandboxPreflightProbeResult[] = [];
  const sourceKind = args.environment.sourceKind;

  try {
    const image = resolveBoxLiteValidationImage(args.environment);
    const sandbox = await args.client.createSandbox({
      taskId,
      sandboxId,
      image,
      metadata: {
        provider: 'boxlite',
        sandboxEnvironmentId: args.environment.environmentId ?? args.environment.id,
        sandboxEnvironmentSourceKind: args.environment.sourceKind,
      },
    });
    probes.push({
      name: 'create-sandbox',
      ok: true,
      output: sandbox.image ?? image,
    });

    if (args.client.startExecution) {
      await args.client.startExecution({
        sandboxId: sandbox.id,
        command: 'true',
        cwd: args.workspacePath,
      });
      probes.push({ name: 'start-execution', ok: true, command: 'true' });
    }

    const exec = await args.client.exec({
      sandboxId: sandbox.id,
      command: 'true',
      cwd: args.workspacePath,
    });
    const ok = exec.exitCode === 0;
    probes.push({
      name: 'exec-probe',
      ok,
      command: 'true',
      output: exec.output,
    });
    if (!ok) {
      throw new Error(`BoxLite environment exec probe failed with exit_code ${exec.exitCode}`);
    }

    for (const probe of args.requiredCommands ?? []) {
      const result = await args.client.exec({
        sandboxId: sandbox.id,
        command: probe.command,
        cwd: args.workspacePath,
      });
      const probeOk = result.exitCode === 0;
      probes.push({
        name: probe.name,
        command: probe.command,
        ok: probeOk,
        output: result.output,
      });
      if (!probeOk) {
        throw new Error(
          `BoxLite environment probe ${probe.name} failed with exit_code ${result.exitCode}`,
        );
      }
    }

    return {
      status: 'passed',
      providerFamily: 'boxlite',
      sourceKind,
      resolvedDigest: args.environment.digest,
      resolvedChecksum: args.environment.checksum,
      probes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (probes.length === 0 || probes.at(-1)?.ok !== false) {
      probes.push({ name: 'validation-error', ok: false, output: message });
    }
    return {
      status: 'failed',
      providerFamily: 'boxlite',
      sourceKind,
      resolvedDigest: args.environment.digest,
      resolvedChecksum: args.environment.checksum,
      probes,
      error: message,
    };
  } finally {
    await args.client.deleteSandbox(sandboxId).catch(() => undefined);
  }
}

export interface BoxLiteEnvironmentValidationCommand {
  readonly name: string;
  readonly command: string;
}

function resolveBoxLiteValidationImage(
  environment: SandboxResolvedEnvironmentMetadata,
): string {
  if (environment.sourceKind === 'boxlite-image' && environment.sourceRef) {
    return environment.sourceRef;
  }
  throw new Error(
    `BoxLite cannot validate environment source ${environment.sourceKind ?? 'unknown'}`,
  );
}
