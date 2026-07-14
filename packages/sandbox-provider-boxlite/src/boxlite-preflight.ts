import type {
  SandboxPreflightResult,
  SandboxProviderCapability,
} from '@cap/sandbox-core';
import type { BoxLiteSandbox } from './boxlite-client.js';
import type {
  BoxLiteRuntimePreflight,
  BoxLiteRuntimePreflightOptions,
} from './boxlite-hooks.js';

export function createBoxLiteRuntimePreflight(
  options: BoxLiteRuntimePreflightOptions,
): BoxLiteRuntimePreflight {
  const cache = options.cache ?? new Map<string, SandboxPreflightResult>();
  const now = options.now ?? (() => new Date());
  return async (context) => {
    const tools = [...options.requiredTools].sort();
    const cacheKey = [
      context.provider.getProviderId(),
      sandboxSourceLabel(context.sandbox),
      context.runtimeId ?? 'default-runtime',
      tools.join(','),
    ].join('|');
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const probes = [];
    if (options.workspacePath) {
      const command = `test -d ${shellQuote(options.workspacePath)}`;
      const result = await context.executor.exec({
        command,
        timeoutMs: options.commandTimeoutMs,
      });
      probes.push({
        name: 'workspace',
        command,
        ok: result.exitCode === 0,
        output: result.output,
      });
    }
    for (const tool of tools) {
      const command = `command -v ${shellQuote(tool)}`;
      const result = await context.executor.exec({
        command,
        timeoutMs: options.commandTimeoutMs,
      });
      probes.push({
        name: tool,
        command,
        ok: result.exitCode === 0,
        output: result.output,
      });
    }
    const failed = probes.filter((probe) => !probe.ok);
    const preflight: SandboxPreflightResult = {
      status: failed.length === 0 ? 'passed' : 'failed',
      checkedAt: now().toISOString(),
      image: context.sandbox.image ?? context.sandbox.rootfsPath,
      runtimeId: context.runtimeId ?? undefined,
      probes,
      error:
        failed.length === 0
          ? undefined
          : boxLitePreflightError(failed.map((probe) => probe.name)),
    };
    cache.set(cacheKey, preflight);
    return preflight;
  };
}

export function requiredToolsForBoxLiteCapabilities(
  capabilities: readonly SandboxProviderCapability[],
): readonly string[] {
  const out = new Set<string>(['sh']);
  if (
    capabilities.includes('terminal.websocket') ||
    capabilities.includes('terminal.interactive')
  ) {
    out.add('bash');
  }
  if (
    capabilities.includes('workspace.git.materialize') ||
    capabilities.includes('workspace.git.deliver')
  ) {
    out.add('git');
  }
  if (capabilities.includes('transcript.retained-read')) {
    out.add('cat');
    out.add('find');
  }
  return [...out].sort();
}

function sandboxSourceLabel(sandbox: BoxLiteSandbox): string {
  return sandbox.image ?? sandbox.rootfsPath ?? 'unknown-source';
}

function boxLitePreflightError(failedNames: readonly string[]): string {
  const label = failedNames.includes('workspace')
    ? 'required tools or workspace'
    : 'required tools';
  return `BoxLite image missing ${label}: ${failedNames.join(', ')}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
