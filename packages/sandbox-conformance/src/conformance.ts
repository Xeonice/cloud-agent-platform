import {
  SANDBOX_EXECUTION_MODES,
  type SandboxConnection,
  type SandboxCommandDescriptorPort,
  type SandboxCommandEndpointDescriptor,
  type SandboxDeliverWorkspaceArgs,
  type SandboxDeliverWorkspaceResult,
  type SandboxProviderPort,
  type SandboxReadoptionPort,
  type SandboxResolvedEnvironmentMetadata,
  type SandboxRetentionDescriptorPort,
  type SandboxSelectedRunPort,
  type SandboxTerminalDescriptorPort,
  type SandboxTerminalEndpointDescriptor,
  type SandboxTranscriptSourceBase,
  type SandboxWorkspaceDescriptor,
  type SandboxWorkspaceDescriptorPort,
  type SelectedSandboxRun,
  type TaskModelIntent,
} from '@cap/sandbox-core';
import {
  missingCapabilities,
  type SandboxProviderCapability,
} from '@cap/sandbox-core';

export interface SandboxProviderConformanceOptions<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
> {
  readonly provider: SandboxProviderPort<TCloneSpec, TRuntimeId, TTranscriptSource> &
    Partial<SandboxReadoptionPort> &
    Partial<SandboxSelectedRunPort> &
    Partial<SandboxTerminalDescriptorPort> &
    Partial<SandboxCommandDescriptorPort> &
    Partial<SandboxWorkspaceDescriptorPort> &
    Partial<SandboxRetentionDescriptorPort>;
  readonly taskId: string;
  readonly requiredCapabilities?: readonly SandboxProviderCapability[];
  readonly cloneSpec?: TCloneSpec | null;
  readonly runtimeId?: TRuntimeId | null;
  readonly modelIntent?: TaskModelIntent;
  readonly executionMode?: 'interactive-pty' | 'headless-exec';
  readonly environment?: SandboxResolvedEnvironmentMetadata | null;
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
  /**
   * Set to true for providers that should expose a selected-run descriptor during
   * conformance. Kept opt-in so existing connection-only adapters remain valid.
   */
  readonly expectSelectedRun?: boolean;
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
  const provisionContext = {
    taskId,
    cloneSpec: options.cloneSpec,
    modelIntent: options.modelIntent ?? ({ kind: 'runtime-default' } as const),
    runtimeId: String(options.runtimeId ?? 'codex'),
    executionMode: options.executionMode ?? ('interactive-pty' as const),
    environment: options.environment,
  };

  const scenarios: SandboxProviderConformanceScenario[] = [
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
        const connection = await options.provider.provision(provisionContext);
        assertSandboxConnection(connection, taskId, assert);
      },
    },
    {
      name: 'provision is idempotent for the same task and cloneSpec',
      async run() {
        const first = await options.provider.provision(provisionContext);
        const second = await options.provider.provision(provisionContext);
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
            ?.some((capability) =>
              capability === 'lifecycle.readopt' ||
              capability === 'lifecycle.readoption',
            ) === true;
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

  scenarios.push(...createFeatureConformanceScenarios(options, assert));

  return scenarios;
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

function createFeatureConformanceScenarios<
  TCloneSpec,
  TRuntimeId,
  TTranscriptSource extends SandboxTranscriptSourceBase,
>(
  options: SandboxProviderConformanceOptions<
    TCloneSpec,
    TRuntimeId,
    TTranscriptSource
  >,
  assert: SandboxProviderConformanceAssert,
): readonly SandboxProviderConformanceScenario[] {
  const capabilities = options.provider.getProviderCapabilities?.() ?? [];
  const scenarios: SandboxProviderConformanceScenario[] = [];

  if (options.expectSelectedRun === true) {
    scenarios.push({
      name: 'selected run descriptor is available when expected',
      async run() {
        assert.equal(
          typeof options.provider.getSelectedSandboxRun,
          'function',
          'selected-run provider must expose getSelectedSandboxRun',
        );
        const run = await options.provider.getSelectedSandboxRun?.(options.taskId);
        if (run === null || run === undefined) {
          assert.ok(false, 'selected run descriptor should be present');
          return;
        }
        assertSelectedSandboxRun(run, options.taskId, assert);
      },
    });
  }

  if (capabilities.includes('terminal.interactive')) {
    scenarios.push({
      name: 'interactive terminal capability exposes a terminal descriptor',
      async run() {
        assert.equal(
          typeof options.provider.getTerminalDescriptor,
          'function',
          'interactive terminal provider must expose getTerminalDescriptor',
        );
        const descriptor = await options.provider.getTerminalDescriptor?.(options.taskId);
        if (descriptor === null || descriptor === undefined) {
          assert.ok(false, 'terminal descriptor should be present');
          return;
        }
        assertTerminalDescriptor(descriptor, assert);
      },
    });
  }

  if (capabilities.includes('command.exec')) {
    scenarios.push({
      name: 'command execution capability exposes a command descriptor',
      async run() {
        assert.equal(
          typeof options.provider.getCommandDescriptor,
          'function',
          'command executor provider must expose getCommandDescriptor',
        );
        const descriptor = await options.provider.getCommandDescriptor?.(options.taskId);
        if (descriptor === null || descriptor === undefined) {
          assert.ok(false, 'command descriptor should be present');
          return;
        }
        assertCommandDescriptor(descriptor, assert);
      },
    });
  }

  if (capabilities.includes('workspace.archive.transfer')) {
    scenarios.push({
      name: 'archive workspace capability exposes a workspace descriptor',
      async run() {
        assert.equal(
          typeof options.provider.getWorkspaceDescriptor,
          'function',
          'workspace transfer provider must expose getWorkspaceDescriptor',
        );
        const descriptor = await options.provider.getWorkspaceDescriptor?.(options.taskId);
        if (descriptor === null || descriptor === undefined) {
          assert.ok(false, 'workspace descriptor should be present');
          return;
        }
        assertWorkspaceDescriptor(descriptor, assert);
      },
    });
  }

  if (
    capabilities.includes('lifecycle.snapshot') ||
    capabilities.includes('lifecycle.sleep')
  ) {
    scenarios.push({
      name: 'provider retention features expose a retention policy',
      async run() {
        assert.equal(
          typeof options.provider.getRetentionPolicy,
          'function',
          'retention-capable provider must expose getRetentionPolicy',
        );
        const policy = await options.provider.getRetentionPolicy?.(options.taskId);
        assert.ok(policy !== null && policy !== undefined, 'retention policy should be present');
      },
    });
  }

  return scenarios;
}

export function assertSelectedSandboxRun(
  run: SelectedSandboxRun,
  expectedTaskId: string | undefined,
  assert: SandboxProviderConformanceAssert,
): void {
  if (expectedTaskId !== undefined) {
    assert.equal(run.taskId, expectedTaskId, 'selected run taskId must match');
  }
  assert.ok(typeof run.providerId === 'string' && run.providerId.length > 0, 'providerId is required');
  assert.ok(Array.isArray(run.capabilities), 'selected run capabilities must be an array');
  assertSandboxConnection(run.connection, expectedTaskId, assert);
}

export function assertTerminalDescriptor(
  descriptor: SandboxTerminalEndpointDescriptor,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    typeof descriptor.protocol === 'string' && descriptor.protocol.length > 0,
    'terminal protocol is required',
  );
  assert.ok(
    descriptor.url === undefined || typeof descriptor.url === 'string',
    'terminal url must be string when present',
  );
  assert.ok(
    descriptor.wsUrl === undefined || typeof descriptor.wsUrl === 'string',
    'terminal wsUrl must be string when present',
  );
}

export function assertCommandDescriptor(
  descriptor: SandboxCommandEndpointDescriptor,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    typeof descriptor.protocol === 'string' && descriptor.protocol.length > 0,
    'command protocol is required',
  );
  assert.ok(
    descriptor.baseUrl === undefined || typeof descriptor.baseUrl === 'string',
    'command baseUrl must be string when present',
  );
}

export function assertWorkspaceDescriptor(
  descriptor: SandboxWorkspaceDescriptor,
  assert: SandboxProviderConformanceAssert,
): void {
  assert.ok(
    typeof descriptor.mode === 'string' && descriptor.mode.length > 0,
    'workspace mode is required',
  );
  assert.ok(
    descriptor.path === undefined || typeof descriptor.path === 'string',
    'workspace path must be string when present',
  );
}
