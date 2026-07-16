import type {
  SandboxPreflightProbeResult,
  SandboxResolvedEnvironmentMetadata,
  SandboxResourceSnapshot,
} from '@cap/sandbox-core';
import {
  SandboxProvisioningStageError,
  snapshotSandboxResources,
} from '@cap/sandbox-core';
import type { BoxLiteClient } from './boxlite-client.js';

export interface BoxLiteEnvironmentValidationResult {
  readonly status: 'passed' | 'failed';
  readonly providerFamily: 'boxlite';
  readonly sourceKind: string | undefined;
  readonly resolvedLocator?: string;
  readonly resolvedDigest?: string;
  readonly resolvedChecksum?: string;
  readonly probes: readonly SandboxPreflightProbeResult[];
  readonly resourceSnapshot?: SandboxResourceSnapshot;
  readonly error?: string;
}

export async function validateBoxLiteEnvironment(args: {
  readonly taskId?: string;
  readonly environment: SandboxResolvedEnvironmentMetadata;
  readonly client: BoxLiteClient;
  readonly workspacePath?: string;
  readonly requiredCommands?: readonly BoxLiteEnvironmentValidationCommand[];
  readonly onCleanupError?: (error: unknown) => void;
}): Promise<BoxLiteEnvironmentValidationResult> {
  const taskId = args.taskId ?? `env-probe-${Date.now()}`;
  const sandboxId = `probe-${taskId}`;
  const probes: SandboxPreflightProbeResult[] = [];
  const sourceKind = args.environment.sourceKind;
  const resourceSnapshot = snapshotSandboxResources(
    args.environment.resources,
  );
  let cleanupSandboxId = sandboxId;
  let resolvedIdentity:
    | { readonly locator: string; readonly digest: string }
    | undefined;
  let outcome: BoxLiteEnvironmentValidationResult;

  try {
    resolvedIdentity = resolveBoxLiteValidationImage(args.environment);
    const image = resolvedIdentity.locator;
    const sandbox = await args.client.createSandbox({
      taskId,
      sandboxId,
      image,
      diskSizeGb: resourceSnapshot?.diskSizeGb,
      metadata: {
        provider: 'boxlite',
        sandboxEnvironmentId: args.environment.environmentId ?? args.environment.id,
        sandboxEnvironmentSourceKind: args.environment.sourceKind,
        resources: resourceSnapshot,
      },
    });
    cleanupSandboxId = sandbox.id;
    probes.push({
      name: 'create-sandbox',
      ok: true,
      output: sandbox.image ?? image,
    });

    if (resourceSnapshot?.diskSizeGb !== undefined) {
      const capacityProbe = await probeBoxLiteDiskCapacity({
        client: args.client,
        sandboxId: sandbox.id,
        diskSizeGb: resourceSnapshot.diskSizeGb,
        cwd: args.workspacePath,
      });
      probes.push(capacityProbe);
      if (!capacityProbe.ok) {
        throw new Error(
          `BoxLite environment disk capacity probe failed for ${resourceSnapshot.diskSizeGb} GiB`,
        );
      }
    }

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

    outcome = {
      status: 'passed',
      providerFamily: 'boxlite',
      sourceKind,
      resolvedLocator: resolvedIdentity.locator,
      resolvedDigest: resolvedIdentity.digest,
      resolvedChecksum: args.environment.checksum,
      resourceSnapshot,
      probes,
    };
  } catch (err) {
    const message = classifyBoxLiteValidationError(
      err instanceof Error ? err.message : String(err),
    );
    if (probes.length === 0 || probes.at(-1)?.ok !== false) {
      probes.push({ name: 'validation-error', ok: false, output: message });
    }
    outcome = {
      status: 'failed',
      providerFamily: 'boxlite',
      sourceKind,
      resolvedLocator: resolvedIdentity?.locator,
      resolvedDigest: resolvedIdentity?.digest,
      resolvedChecksum: args.environment.checksum,
      resourceSnapshot,
      probes,
      error: message,
    };
  }
  try {
    await args.client.deleteSandbox(cleanupSandboxId);
  } catch (error) {
    args.onCleanupError?.(error);
    if (outcome.status === 'passed') {
      const message = 'BoxLite environment probe cleanup failed.';
      probes.push({ name: 'cleanup', ok: false, output: message });
      outcome = { ...outcome, status: 'failed', probes, error: message };
    }
  }
  return outcome;
}

export async function probeBoxLiteDiskCapacity(args: {
  readonly client: BoxLiteClient;
  readonly sandboxId: string;
  readonly diskSizeGb: number;
  readonly cwd?: string;
}): Promise<SandboxPreflightProbeResult> {
  const minimumKiB = Math.floor(args.diskSizeGb * 1024 * 1024 * 0.9);
  const command =
    `df -Pk / | awk -v minimum=${minimumKiB} ` +
    "'NR == 2 { exit ($2 >= minimum ? 0 : 1) } END { if (NR < 2) exit 1 }'";
  let result: Awaited<ReturnType<BoxLiteClient['exec']>>;
  try {
    result = await args.client.exec({
      sandboxId: args.sandboxId,
      command,
      cwd: args.cwd,
    });
  } catch {
    // The client error may carry a native endpoint or command response. Expose
    // only the provider-neutral readiness stage to orchestration.
    throw new SandboxProvisioningStageError('readiness');
  }
  return {
    name: 'disk-capacity',
    command,
    ok: result.exitCode === 0,
    output: result.output,
  };
}

export interface BoxLiteEnvironmentValidationCommand {
  readonly name: string;
  readonly command: string;
}

function resolveBoxLiteValidationImage(
  environment: SandboxResolvedEnvironmentMetadata,
): { readonly locator: string; readonly digest: string } {
  if (environment.sourceKind === 'boxlite-image' && environment.sourceRef) {
    const separator = environment.sourceRef.lastIndexOf('@');
    const qualifiedDigest =
      separator >= 0 ? environment.sourceRef.slice(separator + 1) : null;
    const digest = environment.digest ?? qualifiedDigest;
    if (!digest?.startsWith('sha256:')) {
      throw new Error(
        'BoxLite image validation requires a digest-qualified image reference.',
      );
    }
    const locator = environment.sourceRef.endsWith(`@${digest}`)
      ? environment.sourceRef
      : `${environment.sourceRef.split('@', 1)[0]}@${digest}`;
    return { locator, digest };
  }
  throw new Error(
    `BoxLite cannot validate environment source ${environment.sourceKind ?? 'unknown'}`,
  );
}

function classifyBoxLiteValidationError(message: string): string {
  const safeMessage = redactSensitiveText(message);
  const lower = safeMessage.toLowerCase();
  if (
    lower.includes('unauthorized') ||
    lower.includes('authentication required') ||
    lower.includes('permission_denied') ||
    lower.includes('permission denied') ||
    lower.includes('denied:') ||
    lower.includes('http 401') ||
    lower.includes('http 403')
  ) {
    return `BoxLite image registry authorization failed: ${safeMessage}`;
  }
  if (
    lower.includes('server gave http response to https client') ||
    lower.includes('http response to https') ||
    (lower.includes('https://') && lower.includes('http://')) ||
    lower.includes('tls') ||
    lower.includes('certificate')
  ) {
    return `BoxLite image registry transport failed: ${safeMessage}`;
  }
  if (
    lower.includes('no such image') ||
    lower.includes('manifest unknown') ||
    lower.includes('not found') ||
    lower.includes('name unknown')
  ) {
    return `BoxLite image not found or inaccessible: ${safeMessage}`;
  }
  if (
    lower.includes('no matching manifest') ||
    lower.includes('platform') ||
    lower.includes('architecture') ||
    lower.includes('exec format error')
  ) {
    return `BoxLite image architecture or runtime mismatch: ${safeMessage}`;
  }
  if (
    lower.includes('failed to pull image') ||
    lower.includes('pull access denied') ||
    lower.includes('error pulling image')
  ) {
    return `BoxLite image registry pull failed: ${safeMessage}`;
  }
  if (
    lower.includes('connection refused') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('network is unreachable') ||
    lower.includes('no route to host') ||
    lower.includes('lookup ') ||
    lower.includes('dns') ||
    lower.includes('error sending request')
  ) {
    return `BoxLite image registry unreachable: ${safeMessage}`;
  }
  return safeMessage;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>')
    .replace(/(token=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(password=)[^&\s"']+/gi, '$1<redacted>');
}
