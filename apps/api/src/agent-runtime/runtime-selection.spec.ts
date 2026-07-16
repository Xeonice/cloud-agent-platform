/**
 * Runtime-selection regression spec (guard-runtime-selection-regression).
 *
 * Pins the EXACT seam that shipped 100% broken in v0.6.0: a `claude-code` task was
 * silently provisioned through codex because the provision-time read path
 * (`ProvisionLookup.getTaskRuntime`) was missing and the registry read it through an
 * optional cast that swallowed its absence. The existing fast tests all bypassed this
 * seam (the leaf `AgentRuntimeRegistry`, or a FAKE registry in the tasks service),
 * so a fully-broken feature passed and shipped.
 *
 * This spec exercises the REAL `IntegrationRuntimeRegistry` against a real-shaped
 * `ProvisionLookup` AND the REAL `PrismaProvisionLookup` against a fake Prisma client,
 * so a future re-break of selection fails here in the CI test lane (not only in the
 * self-hosted, token-gated, self-skipping amd64 e2e).
 *
 * Run from apps/api with: pnpm test
 * (pretest compiles to dist/ via nest build; node --test picks up dist/**\/*.spec.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';

import { IntegrationRuntimeRegistry } from './agent-runtime.integration';
import { PrismaProvisionLookup } from '../sandbox/prisma-provision-lookup';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  CloneSpec,
  ProvisionLookup,
} from '../sandbox/provision-lookup.port';

/**
 * A real-SHAPED `ProvisionLookup` (satisfies the FULL port — not a partial fake that
 * could drift from the interface) whose `getTaskRuntime` returns a scripted value.
 * Typing it as `ProvisionLookup` is itself part of the guard: an implementation
 * missing `getTaskRuntime` would not compile.
 */
function lookupReturning(runtime: string | null): ProvisionLookup {
  return {
    getTaskLaunchContext: async () => ({
      modelIntent: { kind: 'runtime-default' },
      ownerUserId: 'owner-1',
      runtimeId: runtime === 'claude-code' ? 'claude-code' : 'codex',
      executionMode: 'interactive-pty',
      workspaceMaterializationDeadlineMs: 900_000,
    }),
    getCloneSpec: async (): Promise<CloneSpec | null> => null,
    getTaskPrompt: async (): Promise<string | null> => null,
    getTaskSkills: async (): Promise<string[]> => [],
    getTaskRuntime: async (): Promise<string | null> => runtime,
    getTaskExecutionMode: async (): Promise<string | null> => null,
  };
}

/** Capture `Logger.prototype.warn` calls for the duration of `fn`. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = Logger.prototype.warn;
  Logger.prototype.warn = function patched(message: unknown): void {
    warnings.push(String(message));
  };
  try {
    await fn();
  } finally {
    Logger.prototype.warn = original;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Scenario: a claude-code task resolves the Claude runtime through the real seam
// ---------------------------------------------------------------------------

test('resolveForTask returns the claude runtime for a claude-code task', async () => {
  const registry = new IntegrationRuntimeRegistry(lookupReturning('claude-code'));
  const runtime = await registry.resolveForTask('task-1');
  assert.equal(
    runtime.id,
    'claude-code',
    'a persisted runtime=claude-code MUST resolve ClaudeCodeRuntime, never codex (the v0.6.0 DOA bug)',
  );
});

// ---------------------------------------------------------------------------
// Scenario: a codex or runtime-absent task resolves the codex runtime
// ---------------------------------------------------------------------------

test('resolveForTask returns codex for a codex task', async () => {
  const registry = new IntegrationRuntimeRegistry(lookupReturning('codex'));
  const runtime = await registry.resolveForTask('task-2');
  assert.equal(runtime.id, 'codex');
});

test('resolveForTask returns codex for a runtime-absent task (null)', async () => {
  const registry = new IntegrationRuntimeRegistry(lookupReturning(null));
  const runtime = await registry.resolveForTask('task-3');
  assert.equal(runtime.id, 'codex', 'an absent runtime defaults to codex');
});

// ---------------------------------------------------------------------------
// Scenario: the persistence lookup actually returns the stored runtime
//           (the read path the v0.6.0 bug omitted) — REAL PrismaProvisionLookup
// ---------------------------------------------------------------------------

test('PrismaProvisionLookup.getTaskRuntime returns the persisted runtime', async () => {
  const fakePrisma = {
    task: {
      findUnique: async (_args: unknown): Promise<{ runtime: string | null }> => ({
        runtime: 'claude-code',
      }),
    },
  } as unknown as PrismaService;
  const lookup = new PrismaProvisionLookup(fakePrisma);
  assert.equal(await lookup.getTaskRuntime('task-4'), 'claude-code');
});

test('REAL registry + REAL PrismaProvisionLookup selects claude end-to-end', async () => {
  // The full seam the DOA bug broke: real registry -> real prisma lookup -> fake client.
  const fakePrisma = {
    task: {
      findUnique: async (_args: unknown): Promise<{ runtime: string | null }> => ({
        runtime: 'claude-code',
      }),
    },
  } as unknown as PrismaService;
  const registry = new IntegrationRuntimeRegistry(new PrismaProvisionLookup(fakePrisma));
  const runtime = await registry.resolveForTask('task-5');
  assert.equal(
    runtime.id,
    'claude-code',
    'the real registry must dispatch to claude via the real prisma getTaskRuntime read path',
  );
});

// ---------------------------------------------------------------------------
// Scenario: an unresolvable runtime is logged, never silently defaulted (D3)
// ---------------------------------------------------------------------------

test('an out-of-set stored runtime resolves codex AND logs a warning', async () => {
  let resolvedId = '';
  const warnings = await captureWarnings(async () => {
    const registry = new IntegrationRuntimeRegistry(lookupReturning('gemini'));
    resolvedId = (await registry.resolveForTask('task-6')).id;
  });
  assert.equal(resolvedId, 'codex', 'an unknown runtime degrades to the codex default');
  assert.ok(
    warnings.some((w) => w.includes('task-6') && w.includes('gemini')),
    'an out-of-set runtime is warned, not silently defaulted',
  );
});

test('a throwing lookup resolves codex AND logs a warning', async () => {
  const throwing: ProvisionLookup = {
    getTaskLaunchContext: async () => {
      throw new Error('db down');
    },
    getCloneSpec: async () => null,
    getTaskPrompt: async () => null,
    getTaskSkills: async () => [],
    getTaskRuntime: async () => {
      throw new Error('db down');
    },
    getTaskExecutionMode: async () => null,
  };
  let resolvedId = '';
  const warnings = await captureWarnings(async () => {
    const registry = new IntegrationRuntimeRegistry(throwing);
    resolvedId = (await registry.resolveForTask('task-7')).id;
  });
  assert.equal(resolvedId, 'codex');
  assert.ok(
    warnings.some((w) => w.includes('task-7')),
    'a lookup error is warned, not silently defaulted',
  );
});

test('an unwired lookup resolves codex AND logs a warning', async () => {
  let resolvedId = '';
  const warnings = await captureWarnings(async () => {
    const registry = new IntegrationRuntimeRegistry(undefined);
    resolvedId = (await registry.resolveForTask('task-8')).id;
  });
  assert.equal(resolvedId, 'codex');
  assert.ok(
    warnings.some((w) => w.includes('task-8')),
    'an unwired ProvisionLookup is warned, not silently defaulted',
  );
});

// ---------------------------------------------------------------------------
// A legitimate absent runtime (null) does NOT warn — a codex task stores null.
// ---------------------------------------------------------------------------

test('an absent runtime (null) defaults to codex WITHOUT a warning', async () => {
  let resolvedId = '';
  const warnings = await captureWarnings(async () => {
    const registry = new IntegrationRuntimeRegistry(lookupReturning(null));
    resolvedId = (await registry.resolveForTask('task-9')).id;
  });
  assert.equal(resolvedId, 'codex');
  assert.equal(
    warnings.length,
    0,
    'the legitimate absent-runtime case must stay quiet (a codex task persists null)',
  );
});

// ---------------------------------------------------------------------------
// add-headless-execution-track — getTaskExecutionMode normalization
// ---------------------------------------------------------------------------

function lookupWithExecutionMode(mode: string | null): ProvisionLookup {
  return {
    getTaskLaunchContext: async () => ({
      modelIntent: { kind: 'runtime-default' },
      ownerUserId: 'owner-1',
      runtimeId: 'codex',
      executionMode: mode === 'headless-exec' ? 'headless-exec' : 'interactive-pty',
      workspaceMaterializationDeadlineMs: 900_000,
    }),
    getCloneSpec: async () => null,
    getTaskPrompt: async () => null,
    getTaskSkills: async () => [],
    getTaskRuntime: async () => null,
    getTaskExecutionMode: async () => mode,
  };
}

test('getTaskExecutionMode: headless-exec passes through', async () => {
  const reg = new IntegrationRuntimeRegistry(
    lookupWithExecutionMode('headless-exec'),
  );
  assert.equal(await reg.getTaskExecutionMode('t'), 'headless-exec');
});

test('getTaskExecutionMode: null/unknown normalizes to interactive-pty', async () => {
  const regNull = new IntegrationRuntimeRegistry(lookupWithExecutionMode(null));
  assert.equal(await regNull.getTaskExecutionMode('t'), 'interactive-pty');
  const regJunk = new IntegrationRuntimeRegistry(
    lookupWithExecutionMode('bogus-mode'),
  );
  assert.equal(await regJunk.getTaskExecutionMode('t'), 'interactive-pty');
});

test('getTaskExecutionMode: no lookup wired defaults to interactive-pty', async () => {
  const reg = new IntegrationRuntimeRegistry(undefined);
  assert.equal(await reg.getTaskExecutionMode('t'), 'interactive-pty');
});

test('getTaskExecutionMode: a throwing lookup defaults to interactive-pty (logged)', async () => {
  const throwing: ProvisionLookup = {
    getTaskLaunchContext: async () => {
      throw new Error('db down');
    },
    getCloneSpec: async () => null,
    getTaskPrompt: async () => null,
    getTaskSkills: async () => [],
    getTaskRuntime: async () => null,
    getTaskExecutionMode: async () => {
      throw new Error('db down');
    },
  };
  const reg = new IntegrationRuntimeRegistry(throwing);
  let mode = '';
  const warnings = await captureWarnings(async () => {
    mode = await reg.getTaskExecutionMode('t');
  });
  assert.equal(mode, 'interactive-pty');
  assert.equal(warnings.length, 1, 'a lookup failure must be logged, never silent');
});
