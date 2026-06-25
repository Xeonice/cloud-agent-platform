import {
  SANDBOX_EXECUTION_MODES,
  type SandboxConnection,
  type SandboxDeliverWorkspaceArgs,
  type SandboxDeliverWorkspaceResult,
  type SandboxProviderPort,
  type SandboxReadoptionPort,
  type SandboxTranscriptSourceBase,
} from '@cap/sandbox-core';
import type { SandboxProviderCapability } from '@cap/sandbox-core';
import { missingCapabilities } from '@cap/sandbox-scheduler';

export interface SandboxProviderConformanceOptions<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
> {
  readonly provider: SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource> &
    Partial<SandboxReadoptionPort>;
  readonly taskId: string;
  readonly requiredCapabilities?: readonly SandboxProviderCapability[];
  readonly cloneSpec?: TCloneSpec | null;
  readonly runtimeId?: TRuntimeId | null;
  readonly deliverArgs?: SandboxDeliverWorkspaceArgs;
  /**
   * Set to false for providers whose fake/test backend intentionally does not
   * expose retained transcripts in this scenario.
   */
  readonly expectTranscriptSource?: boolean;
  /**
   * Set to false when the provider does not declare `lifecycle.readopt`.
   */
  readonly expectReadoption?: boolean;
}

export interface SandboxProviderConformanceScenario {
  readonly name: string;
  run(): Promise<void>;
}

export interface SandboxProviderConformanceAssert {
  ok(value: unknown, message: string): void;
  equal<T>(actual: T, expected: T, message: string): void;
  deepEqual<T>(actual: T, expected: T, message: string): void;
}

export function createSandboxProviderConformanceScenarios<
  TCloneSpec,
  TRuntimeId = string,
  TTranscriptSource extends SandboxTranscriptSourceBase = SandboxTranscriptSourceBase,
>(
  options: SandboxProviderConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  const taskId = options.taskId;
  const deliverArgs =
    options.deliverArgs ??
    ({
      authHeader: 'Authorization: Basic test-token',
      branch: `cap/${taskId}`,
      commitMessage: 'CAP sandbox conformance',
    } satisfies SandboxDeliverWorkspaceArgs);

  return [
    {
      name: 'provider declares a valid execution mode and required capabilities',
      async run() {
        assert.ok(
          SANDBOX_EXECUTION_MODES.includes(options.provider.getSandboxMode()),
          'sandbox mode must be one of the shared execution modes',
        );
        const capabilities = options.provider.getProviderCapabilities?.();
        assert.ok(Array.isArray(capabilities), 'provider must declare capabilities');
        const missing = missingCapabilities(
          capabilities ?? [],
          options.requiredCapabilities ?? [],
        );
        assert.deepEqual(missing, [], 'provider is missing required capabilities');
      },
    },
    {
      name: 'provision returns an addressable task connection',
      async run() {
        const connection = await options.provider.provision({
          taskId,
          cloneSpec: options.cloneSpec,
        });
        assertSandboxConnection(connection, taskId, assert);
      },
    },
    {
      name: 'provision is idempotent for the same task and cloneSpec',
      async run() {
        const first = await options.provider.provision({
          taskId,
          cloneSpec: options.cloneSpec,
        });
        const second = await options.provider.provision({
          taskId,
          cloneSpec: options.cloneSpec,
        });
        assertSandboxConnection(first, taskId, assert);
        assert.deepEqual(
          second,
          first,
          'provision must return a stable connection for repeated task provisioning',
        );
      },
    },
    {
      name: 'sandbox existence check returns a boolean',
      async run() {
        const exists = await options.provider.sandboxExists(taskId);
        assert.equal(typeof exists, 'boolean', 'sandboxExists must resolve to a boolean');
      },
    },
    {
      name: 'workspace delivery returns the shared delivery result shape',
      async run() {
        const result = await options.provider.deliverWorkspaceChanges(taskId, deliverArgs);
        assertSandboxDeliverWorkspaceResult(result, assert);
      },
    },
    {
      name: 'retained transcript read returns null or a tagged source',
      async run() {
        const source = await options.provider.readRolloutFromContainer(
          taskId,
          options.runtimeId,
        );
        if (options.expectTranscriptSource === false) {
          assert.equal(source, null, 'transcript source should be absent in this scenario');
          return;
        }
        if (source === null) {
          assert.ok(false, 'transcript source should be present');
          return;
        }
        assertSandboxTranscriptSource(source, assert);
      },
    },
    {
      name: 'readoption surfaces are present when lifecycle.readopt is declared',
      async run() {
        const shouldReadopt =
          options.expectReadoption ??
          options.provider
            .getProviderCapabilities?.()
            ?.includes('lifecycle.readopt') === true;
        if (!shouldReadopt) return;
        assert.equal(
          typeof options.provider.listReadoptable,
          'function',
          'readoptable provider must expose listReadoptable',
        );
        assert.equal(
          typeof options.provider.reattach,
          'function',
          'readoptable provider must expose reattach',
        );
        const readoptable = await options.provider.listReadoptable?.();
        assert.ok(Array.isArray(readoptable), 'listReadoptable must resolve to an array');
        const reattached = await options.provider.reattach?.(taskId);
        if (reattached !== null && reattached !== undefined) {
          assertSandboxConnection(reattached, taskId, assert);
        }
      },
    },
    {
      name: 'teardown is callable at the end of the provider lifecycle',
      async run() {
        await options.provider.teardownSandbox(taskId);
      },
    },
  ];
}

export function assertSandboxConnection(
  connection: SandboxConnection,
  expectedTaskId: string | undefined,
  assert: SandboxProviderConformanceAssert,
): void {
  if (expectedTaskId !== undefined) {
    assert.equal(connection.taskId, expectedTaskId, 'connection taskId must match');
  }
  assert.ok(typeof connection.baseUrl === 'string' && connection.baseUrl.length > 0, 'baseUrl is required');
  assert.ok(typeof connection.wsUrl === 'string' && connection.wsUrl.length > 0, 'wsUrl is required');
}

export function assertSandboxDeliverWorkspaceResult(
  result: SandboxDeliverWorkspaceResult,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.equal(typeof result.hadChanges, 'boolean', 'hadChanges must be boolean');
  assert.ok(
    result.commitSha === null || typeof result.commitSha === 'string',
    'commitSha must be string or null',
  );
  assert.ok(
    result.error === null || typeof result.error === 'string',
    'error must be string or null',
  );
}

export function assertSandboxTranscriptSource(
  source: SandboxTranscriptSourceBase,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(typeof source.format === 'string' && source.format.length > 0, 'format is required');
  assert.equal(typeof source.jsonl, 'string', 'jsonl must be a string');
}
